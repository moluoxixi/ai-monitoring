import { Injectable } from '@nestjs/common';
import type { QrConnectCredentials, startQrConnect as StartQrConnect } from '@tencent-connect/qqbot-connector';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AppConfigService } from '../config/app-config.service';
import type {
  BindingStartResult,
  BindingWaitResult,
  ChannelProvider,
  ChannelStatus,
} from './channel-provider';
import { ProcessExecutionError, ProcessRunnerService } from './process-runner.service';

export const OPENCLAW_QQ = 'openclaw-qq';
export const OPENCLAW_WEIXIN = 'openclaw-weixin';

interface Binding {
  provider: string;
  target: string;
  account_id: string;
}

type Bindings = Record<string, Binding>;

interface QrSession {
  qrUrl: string;
  state: 'starting' | 'pending' | 'connected' | 'failed';
  credentials?: QrConnectCredentials[];
  error?: string;
  dispose: () => void;
  changed: Promise<void>;
  notify: () => void;
  persisting?: Promise<BindingWaitResult>;
}

@Injectable()
export class OpenClawProvider implements ChannelProvider {
  readonly ids = [OPENCLAW_QQ, OPENCLAW_WEIXIN] as const;
  private readonly outboundDir: string;
  private readonly emitterPath: string;
  private qrSession: QrSession | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly runner: ProcessRunnerService,
  ) {
    this.outboundDir = join(config.projectRoot, 'data', 'openclaw-outbound');
    this.emitterPath = join(config.projectRoot, 'scripts', 'openclaw-emit-notification.mjs');
  }

  availableChannels(): string[] {
    const bindings = this.loadBindings();
    return this.ids.filter((id) => Boolean(bindings[id]));
  }

  async status(): Promise<ChannelStatus[]> {
    const bindings = this.loadBindings();
    let payload: Record<string, unknown> = {};
    let commandError = false;
    try {
      payload = await this.runJson(['channels', 'status', '--json'], 5_000);
      commandError = payload.gatewayReachable === false || Boolean(payload.error);
    } catch {
      commandError = true;
    }
    const channels = this.objectValue(payload.channels);
    return [
      this.statusItem(OPENCLAW_QQ, 'QQ 机器人', 'qqbot', 'qr', bindings, channels, commandError),
      {
        ...this.statusItem(OPENCLAW_WEIXIN, '微信机器人', OPENCLAW_WEIXIN, 'external', bindings, channels, commandError),
        message: '当前 OpenClaw 微信插件未公开可路由的二维码登录接口，需在 OpenClaw 中完成登录。',
      },
    ];
  }

  async startBinding(channel: string): Promise<BindingStartResult> {
    if (channel === OPENCLAW_WEIXIN) {
      return {
        mode: 'external',
        message: '当前微信插件不支持从本页面发起扫码，请先在 OpenClaw 中完成官方登录。',
      };
    }
    if (channel !== OPENCLAW_QQ) throw new Error(`unsupported OpenClaw channel: ${channel}`);

    this.cancelQrSession();
    let notify = (): void => undefined;
    let changed = new Promise<void>((resolve) => { notify = resolve; });
    const session: QrSession = {
      qrUrl: '', state: 'starting', dispose: () => undefined, changed, notify,
    };
    const signalChange = (): void => {
      session.notify();
      session.changed = new Promise<void>((resolve) => { session.notify = resolve; });
    };
    const startQrConnect = await this.loadConnector();
    session.dispose = startQrConnect({
      onQrDisplayed: (url) => {
        session.qrUrl = url;
        session.state = 'pending';
        signalChange();
      },
      onQrExpired: () => signalChange(),
      onSuccess: (credentials) => {
        session.credentials = credentials;
        session.state = 'connected';
        signalChange();
      },
      onFailure: (error) => {
        session.error = error.message;
        session.state = 'failed';
        signalChange();
      },
    }, { displayQrCodeToConsole: false, source: 'ai-monitor' });
    this.qrSession = session;

    if (!session.qrUrl) await this.waitForChange(session, 15_000);
    if (!session.qrUrl) {
      this.cancelQrSession();
      throw new Error(session.error || 'QQ 二维码生成超时，请重试');
    }
    return { mode: 'qr', qrUrl: session.qrUrl, message: '请使用手机 QQ 扫描二维码完成绑定' };
  }

  async waitBinding(channel: string): Promise<BindingWaitResult> {
    if (channel !== OPENCLAW_QQ) {
      return { connected: false, bound: false, message: '该通道不支持从本页面等待扫码结果' };
    }
    const session = this.qrSession;
    if (!session) return { connected: false, bound: false, message: '二维码会话不存在或已过期，请重新绑定' };
    if (session.state === 'starting' || session.state === 'pending') await this.waitForChange(session, 25_000);
    if (session.state === 'starting' || session.state === 'pending') {
      return { connected: false, bound: false, message: '等待扫码', qrUrl: session.qrUrl || undefined };
    }
    if (session.state === 'failed') {
      const message = session.error || 'QQ 绑定失败，请重新尝试';
      this.cancelQrSession();
      return { connected: false, bound: false, message };
    }
    session.persisting ||= this.completeQqBinding(session);
    return session.persisting;
  }

  async unbind(channel: string): Promise<boolean> {
    if (channel === OPENCLAW_QQ) this.cancelQrSession();
    const bindings = this.loadBindings();
    if (!bindings[channel]) return false;
    delete bindings[channel];
    this.saveBindings(bindings);
    return true;
  }

  async cancelBinding(channel: string): Promise<void> {
    if (channel === OPENCLAW_QQ) this.cancelQrSession();
  }

  async send(channel: string, title: string, body: string): Promise<void> {
    const binding = this.loadBindings()[channel];
    if (!binding) throw new Error(`OpenClaw channel is not bound: ${channel}`);
    await this.sendCommandNotification(binding, `${title}\n\n${body}`.trim());
  }

  private async completeQqBinding(session: QrSession): Promise<BindingWaitResult> {
    try {
      const credentials = session.credentials || [];
      if (credentials.length !== 1) throw new Error('扫码返回了多个 QQ 机器人账号，请重新扫码并只选择一个账号');
      const credential = credentials[0]!;
      if (!credential.appId || !credential.appSecret || !credential.userOpenid) {
        throw new Error('QQ 扫码结果缺少绑定信息，请重新扫码');
      }
      await this.persistQqCredential(credential);
      const bindings = this.loadBindings();
      bindings[OPENCLAW_QQ] = {
        provider: 'qqbot',
        target: `qqbot:c2c:${credential.userOpenid}`,
        account_id: 'default',
      };
      this.saveBindings(bindings);
      this.cancelQrSession();
      return { connected: true, bound: true, message: 'QQ 机器人已绑定' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'QQ 绑定失败';
      this.cancelQrSession();
      return { connected: true, bound: false, message };
    }
  }

  private async persistQqCredential(credential: QrConnectCredentials): Promise<void> {
    mkdirSync(this.outboundDir, { recursive: true });
    const batchPath = join(this.outboundDir, `qq-binding-${randomUUID()}.json`);
    const entries = [
      { path: 'channels.qqbot.enabled', value: true },
      { path: 'channels.qqbot.appId', value: credential.appId },
      { path: 'channels.qqbot.clientSecret', value: credential.appSecret },
      { path: 'channels.qqbot.allowFrom', value: [credential.userOpenid] },
      { path: 'channels.qqbot.streaming', value: { mode: 'partial' } },
      { path: 'channels.qqbot.dmPolicy', value: 'allowlist' },
      { path: 'channels.qqbot.mediaMaxMb', value: 200 },
    ];
    try {
      writeFileSync(batchPath, `${JSON.stringify(entries)}\n`, { encoding: 'utf8', mode: 0o600 });
      chmodSync(batchPath, 0o600);
      await this.run(['config', 'set', '--batch-file', batchPath], 30_000, [credential.appId, credential.appSecret, credential.userOpenid || '']);
    } finally {
      if (existsSync(batchPath)) unlinkSync(batchPath);
    }
  }

  private statusItem(
    id: string,
    label: string,
    provider: string,
    bindingMode: ChannelStatus['bindingMode'],
    bindings: Bindings,
    statuses: Record<string, unknown>,
    commandError: boolean,
  ): ChannelStatus {
    const status = this.objectValue(statuses[provider]);
    return {
      id,
      label,
      bound: Boolean(bindings[id]),
      error: commandError || Boolean(status.lastError),
      bindingMode,
    };
  }

  private async sendCommandNotification(binding: Binding, message: string): Promise<void> {
    mkdirSync(this.outboundDir, { recursive: true });
    const messagePath = join(this.outboundDir, `notification-${randomUUID()}.txt`);
    writeFileSync(messagePath, message, { encoding: 'utf8', mode: 0o600 });
    chmodSync(messagePath, 0o600);
    let jobId = '';
    try {
      const created = await this.runJson([
        'cron', 'add',
        '--name', `ai-monitor-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        '--at', '+24h',
        '--keep-after-run',
        '--command-argv', JSON.stringify([process.execPath, this.emitterPath, messagePath]),
        '--command-cwd', this.config.projectRoot,
        '--timeout-seconds', '30',
        '--output-max-bytes', '16000',
        '--announce',
        '--channel', binding.provider,
        '--to', binding.target,
        '--account', binding.account_id,
        '--json',
      ], 45_000, [binding.target, binding.account_id]);
      jobId = this.findId(created);
      if (!jobId) throw new Error('OpenClaw did not return a notification job id');
      await this.run(['cron', 'run', jobId, '--wait', '--wait-timeout', '2m', '--poll-interval', '1s'], 150_000, [binding.target, binding.account_id]);
    } finally {
      if (existsSync(messagePath)) unlinkSync(messagePath);
      if (jobId) {
        try {
          await this.run(['cron', 'rm', jobId, '--json'], 30_000);
        } catch {
          // Job cleanup is best-effort after the notification has completed.
        }
      }
    }
  }

  private async runJson(args: string[], timeoutMs: number, redact: string[] = []): Promise<Record<string, unknown>> {
    const output = await this.run(args, timeoutMs, redact);
    let payload: unknown;
    try {
      payload = JSON.parse(output);
    } catch {
      throw new Error('OpenClaw returned invalid JSON');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('OpenClaw returned an unexpected response');
    return payload as Record<string, unknown>;
  }

  private async run(args: string[], timeoutMs: number, redact: string[] = []): Promise<string> {
    const env = { ...process.env };
    if (!env.OPENCLAW_GATEWAY_TOKEN) {
      const token = await this.gatewayToken();
      if (token) env.OPENCLAW_GATEWAY_TOKEN = token;
    }
    if (process.platform === 'win32') {
      const cliModule = join(dirname(process.execPath), 'node_modules', 'openclaw', 'openclaw.mjs');
      if (!existsSync(cliModule)) throw new Error('OpenClaw CLI is unavailable');
      return this.runner.run(process.execPath, [cliModule, ...args], {
        timeoutMs,
        cwd: this.config.projectRoot,
        env,
        redact,
      });
    }
    return this.runner.run('openclaw', args, { timeoutMs, cwd: this.config.projectRoot, env, redact });
  }

  private async gatewayToken(): Promise<string> {
    if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
    if (process.platform !== 'win32') return '';
    try {
      const output = await this.runner.run('reg.exe', ['query', 'HKCU\\Environment', '/v', 'OPENCLAW_GATEWAY_TOKEN'], { timeoutMs: 5_000 });
      const match = output.match(/OPENCLAW_GATEWAY_TOKEN\s+REG_\w+\s+(.+)$/m);
      return match?.[1]?.trim() || '';
    } catch (error) {
      if (error instanceof ProcessExecutionError) return '';
      return '';
    }
  }

  private loadBindings(): Bindings {
    if (!existsSync(this.config.openClawBindingsPath)) return {};
    let payload: unknown;
    try {
      payload = JSON.parse(readFileSync(this.config.openClawBindingsPath, 'utf8'));
    } catch {
      throw new Error('OpenClaw notification binding file is invalid');
    }
    const document = this.objectValue(payload);
    if (document.version !== 2) return {};
    const raw = this.objectValue(document.bindings);
    const bindings: Bindings = {};
    for (const [channel, value] of Object.entries(raw)) {
      const item = this.objectValue(value);
      if (typeof item.provider === 'string' && item.provider && typeof item.target === 'string' && item.target && typeof item.account_id === 'string' && item.account_id) {
        bindings[channel] = { provider: item.provider, target: item.target, account_id: item.account_id };
      }
    }
    return bindings;
  }

  private saveBindings(bindings: Bindings): void {
    mkdirSync(dirname(this.config.openClawBindingsPath), { recursive: true });
    const temporary = `${this.config.openClawBindingsPath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ version: 2, bindings }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.config.openClawBindingsPath);
  }

  private cancelQrSession(): void {
    this.qrSession?.dispose();
    this.qrSession = null;
  }

  private async waitForChange(session: QrSession, timeoutMs: number): Promise<void> {
    await Promise.race([
      session.changed,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  private async loadConnector(): Promise<typeof StartQrConnect> {
    // The connector's CommonJS export is invalid under its own `type: module` package.
    // Native import selects the published ESM entry without patching the dependency.
    const nativeImport = new Function('specifier', 'return import(specifier)') as (
      specifier: string,
    ) => Promise<{ startQrConnect: typeof StartQrConnect }>;
    return (await nativeImport('@tencent-connect/qqbot-connector')).startQrConnect;
  }

  private findId(value: unknown): string {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    const record = value as Record<string, unknown>;
    for (const key of ['id', 'jobId', 'job_id']) {
      if (typeof record[key] === 'string' && record[key]) return record[key];
    }
    for (const item of Object.values(record)) {
      const found = this.findId(item);
      if (found) return found;
    }
    return '';
  }

  private objectValue(value: unknown): Record<string, any> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
  }
}
