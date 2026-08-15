import { Injectable } from '@nestjs/common';
import type { QrConnectCredentials, startQrConnect as StartQrConnect } from '@tencent-connect/qqbot-connector';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AppConfigService } from '../config/app-config.service';
import type {
  BindingStartResult,
  BindingWaitResult,
  ChannelProvider,
  ChannelStatus,
} from './channel-provider';
import { DeliveryOutcomeUnknownError } from './channel-provider';
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

interface WeixinBindingTarget {
  accountId: string;
  hasContext: boolean;
  target: string;
}

@Injectable()
export class OpenClawProvider implements ChannelProvider {
  readonly ids = [OPENCLAW_QQ, OPENCLAW_WEIXIN] as const;
  private readonly outboundDir: string;
  private readonly emitterPath: string;
  private qqQrSession: QrSession | null = null;
  private weixinQrSession: QrSession | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly runner: ProcessRunnerService,
  ) {
    const dataRoot = config.dataRoot || join(config.projectRoot, 'data');
    this.outboundDir = join(dataRoot, 'openclaw-outbound');
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
      payload = await this.runJson(['channels', 'status', '--json'], 15_000);
      commandError = payload.gatewayReachable === false || Boolean(payload.error);
    } catch {
      commandError = true;
    }
    const channels = this.objectValue(payload.channels);
    return [
      this.statusItem(OPENCLAW_QQ, 'QQ 机器人', 'qqbot', 'qr', bindings, channels, commandError),
      this.statusItem(OPENCLAW_WEIXIN, '微信机器人', OPENCLAW_WEIXIN, 'qr', bindings, channels, commandError),
    ];
  }

  async startBinding(channel: string): Promise<BindingStartResult> {
    if (channel === OPENCLAW_WEIXIN) return this.startWeixinBinding();
    if (channel !== OPENCLAW_QQ) throw new Error(`unsupported OpenClaw channel: ${channel}`);

    this.cancelQqQrSession();
    const session = this.newQrSession();
    const startQrConnect = await this.loadConnector();
    session.dispose = startQrConnect({
      onQrDisplayed: (url) => {
        session.qrUrl = url;
        session.state = 'pending';
        this.signalChange(session);
      },
      onQrExpired: () => this.signalChange(session),
      onSuccess: (credentials) => {
        session.credentials = credentials;
        session.state = 'connected';
        this.signalChange(session);
      },
      onFailure: (error) => {
        session.error = error.message;
        session.state = 'failed';
        this.signalChange(session);
      },
    }, { displayQrCodeToConsole: false, source: 'ai-monitor' });
    this.qqQrSession = session;

    if (!session.qrUrl) await this.waitForChange(session, 15_000);
    if (!session.qrUrl) {
      this.cancelQqQrSession();
      throw new Error(session.error || 'QQ 二维码生成超时，请重试');
    }
    return { mode: 'qr', qrUrl: session.qrUrl, message: '请使用手机 QQ 扫描二维码完成绑定' };
  }

  async waitBinding(channel: string): Promise<BindingWaitResult> {
    if (channel === OPENCLAW_WEIXIN) return this.waitWeixinBinding();
    if (channel !== OPENCLAW_QQ) return { connected: false, bound: false, message: '未知消息通道' };
    const session = this.qqQrSession;
    if (!session) return { connected: false, bound: false, message: '二维码会话不存在或已过期，请重新绑定' };
    if (session.state === 'starting' || session.state === 'pending') await this.waitForChange(session, 25_000);
    if (session.state === 'starting' || session.state === 'pending') {
      return { connected: false, bound: false, message: '等待扫码', qrUrl: session.qrUrl || undefined };
    }
    if (session.state === 'failed') {
      const message = session.error || 'QQ 绑定失败，请重新尝试';
      this.cancelQqQrSession();
      return { connected: false, bound: false, message };
    }
    session.persisting ||= this.completeQqBinding(session);
    return session.persisting;
  }

  async unbind(channel: string): Promise<boolean> {
    this.cancelBindingSession(channel);
    const bindings = this.loadBindings();
    if (!bindings[channel]) return false;
    delete bindings[channel];
    this.saveBindings(bindings);
    return true;
  }

  async cancelBinding(channel: string): Promise<void> {
    this.cancelBindingSession(channel);
  }

  async send(channel: string, title: string, body: string): Promise<void> {
    const binding = this.loadBindings()[channel];
    if (!binding) throw new Error(`OpenClaw channel is not bound: ${channel}`);
    const message = `${title}\n\n${body}`.trim();
    if (channel === OPENCLAW_QQ) {
      await this.sendGatewayAnnouncement(binding, message);
      return;
    }
    await this.sendDirectMessage(binding, message);
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
      this.cancelQqQrSession();
      return { connected: true, bound: true, message: 'QQ 机器人已绑定' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'QQ 绑定失败';
      this.cancelQqQrSession();
      return { connected: true, bound: false, message };
    }
  }

  private async startWeixinBinding(): Promise<BindingStartResult> {
    this.cancelWeixinQrSession();
    const session = this.newQrSession();
    session.dispose = await this.launchWeixinLogin({
      onQrDisplayed: (url) => {
        session.qrUrl = url;
        session.state = 'pending';
        this.signalChange(session);
      },
      onSuccess: () => {
        session.state = 'connected';
        this.signalChange(session);
      },
      onFailure: (error) => {
        session.error = error.message;
        session.state = 'failed';
        this.signalChange(session);
      },
    });
    this.weixinQrSession = session;
    if (!session.qrUrl) await this.waitForChange(session, 20_000);
    if (!session.qrUrl) {
      this.cancelWeixinQrSession();
      throw new Error(session.error || '微信二维码生成超时，请重试');
    }
    return { mode: 'qr', qrUrl: session.qrUrl, message: '请使用手机微信扫描二维码并确认连接' };
  }

  private async waitWeixinBinding(): Promise<BindingWaitResult> {
    const session = this.weixinQrSession;
    if (!session) return { connected: false, bound: false, message: '二维码会话不存在或已过期，请重新绑定' };
    if (session.state === 'starting' || session.state === 'pending') await this.waitForChange(session, 25_000);
    if (session.state === 'starting' || session.state === 'pending') {
      return { connected: false, bound: false, message: '等待扫码', qrUrl: session.qrUrl || undefined };
    }
    if (session.state === 'failed') {
      const message = session.error || '微信绑定失败，请重新尝试';
      this.cancelWeixinQrSession();
      return { connected: false, bound: false, message };
    }
    return this.completeWeixinBinding();
  }

  private async completeWeixinBinding(): Promise<BindingWaitResult> {
    try {
      const target = this.latestWeixinBinding();
      if (!target) throw new Error('微信登录已完成，但未找到可用于通知的本人接收目标');
      if (!target.hasContext) {
        return {
          connected: false,
          bound: false,
          message: '扫码已确认，请先在微信中给机器人发送任意一条消息以启用通知',
        };
      }
      const bindings = this.loadBindings();
      bindings[OPENCLAW_WEIXIN] = {
        provider: OPENCLAW_WEIXIN,
        target: target.target,
        account_id: target.accountId,
      };
      this.saveBindings(bindings);
      this.cancelWeixinQrSession();
      return { connected: true, bound: true, message: '微信机器人已绑定' };
    } catch (error) {
      const message = error instanceof Error ? error.message : '微信绑定失败';
      this.cancelWeixinQrSession();
      return { connected: true, bound: false, message };
    }
  }

  private async launchWeixinLogin(callbacks: {
    onQrDisplayed: (url: string) => void;
    onSuccess: () => void;
    onFailure: (error: Error) => void;
  }): Promise<() => void> {
    const loginArgs = ['channels', 'login', '--channel', OPENCLAW_WEIXIN];
    let command = 'openclaw';
    let args = loginArgs;
    const cliModule = this.openClawCliModule();
    if (cliModule) {
      command = process.execPath;
      args = [cliModule, ...loginArgs];
    }
    const env = { ...process.env };
    if (!env.OPENCLAW_GATEWAY_TOKEN) {
      const token = await this.gatewayToken();
      if (token) env.OPENCLAW_GATEWAY_TOKEN = token;
    }
    const child = spawn(command, args, {
      cwd: this.config.projectRoot,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let displayedQr = '';
    const inspect = (chunk: Buffer): void => {
      output = `${output}${chunk.toString('utf8')}`.slice(-64_000);
      const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
      const matches = [...plain.matchAll(/(?:二维码链接:|若二维码未能显示或无法使用，你可以访问以下链接以继续：)\s*(data:image\/[^\s]+|https:\/\/[^\s]+)/g)];
      const qrUrl = matches.at(-1)?.[1]?.replace(/[)\]}>,.;]+$/, '');
      if (!qrUrl || qrUrl === displayedQr) return;
      displayedQr = qrUrl;
      callbacks.onQrDisplayed(qrUrl);
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('error', () => callbacks.onFailure(new Error('无法启动微信官方登录流程')));
    child.once('exit', (code, signal) => {
      if (signal) return;
      if (code === 0) callbacks.onSuccess();
      else callbacks.onFailure(new Error('微信扫码登录未完成，请重试'));
    });
    return () => {
      child.removeAllListeners();
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true, stdio: 'ignore',
        });
      } else {
        child.kill();
      }
    };
  }

  private latestWeixinBinding(): WeixinBindingTarget | null {
    const stateRoot = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim() || join(homedir(), '.openclaw');
    const stateDir = join(stateRoot, OPENCLAW_WEIXIN);
    const indexPath = join(stateDir, 'accounts.json');
    if (!existsSync(indexPath)) return null;
    let accountIds: unknown;
    try {
      accountIds = JSON.parse(readFileSync(indexPath, 'utf8'));
    } catch {
      return null;
    }
    if (!Array.isArray(accountIds)) return null;
    const candidates: Array<WeixinBindingTarget & { savedAt: number }> = [];
    for (const rawId of accountIds) {
      if (typeof rawId !== 'string' || !rawId) continue;
      const accountPath = join(stateDir, 'accounts', `${rawId}.json`);
      if (!existsSync(accountPath)) continue;
      try {
        const account = this.objectValue(JSON.parse(readFileSync(accountPath, 'utf8')));
        if (typeof account.token !== 'string' || !account.token || typeof account.userId !== 'string' || !account.userId.endsWith('@im.wechat')) continue;
        candidates.push({
          accountId: rawId,
          hasContext: this.hasWeixinContext(stateDir, rawId, account.userId),
          target: account.userId,
          savedAt: typeof account.savedAt === 'string' ? Date.parse(account.savedAt) || 0 : 0,
        });
      } catch {
        // Ignore incomplete account files while the official login flow is persisting them.
      }
    }
    candidates.sort((left, right) => right.savedAt - left.savedAt);
    return candidates[0] || null;
  }

  private hasWeixinContext(stateDir: string, accountId: string, userId: string): boolean {
    const contextPath = join(stateDir, 'accounts', `${accountId}.context-tokens.json`);
    if (!existsSync(contextPath)) return false;
    try {
      const contexts = this.objectValue(JSON.parse(readFileSync(contextPath, 'utf8')));
      return typeof contexts[userId] === 'string' && Boolean(contexts[userId]);
    } catch {
      return false;
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

  private async sendDirectMessage(binding: Binding, message: string): Promise<void> {
    let result: Record<string, unknown>;
    try {
      result = await this.runJson([
        'message', 'send',
        '--channel', binding.provider,
        '--account', binding.account_id,
        '--target', binding.target,
        '--message', message,
        '--json',
      ], 60_000, [binding.target, binding.account_id]);
    } catch (error) {
      if (error instanceof ProcessExecutionError && /sendMessage ret=-2 errmsg=prepare failed/i.test(error.message)) {
        throw new Error('微信会话不可用，请在微信中给机器人发送任意一条消息后重试');
      }
      throw error;
    }
    if (result.action !== 'send' || result.dryRun === true || typeof result.messageId !== 'string' || !result.messageId) {
      throw new Error('OpenClaw did not confirm direct message delivery');
    }
  }

  private async sendGatewayAnnouncement(binding: Binding, message: string): Promise<void> {
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
        '--command-argv', JSON.stringify([process.execPath, this.emitterPath, this.outboundDir, messagePath]),
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
      try {
        await this.run(['cron', 'run', jobId, '--wait', '--wait-timeout', '2m', '--poll-interval', '1s'], 150_000, [binding.target, binding.account_id]);
      } catch (error) {
        throw new DeliveryOutcomeUnknownError(
          'QQ 消息已提交到 OpenClaw，但执行结果无法确认，已停止自动重试',
          { cause: error },
        );
      }
      let history: Record<string, unknown>;
      try {
        history = await this.runJson(['cron', 'runs', '--id', jobId, '--limit', '1'], 30_000, [binding.target, binding.account_id]);
      } catch (error) {
        throw new DeliveryOutcomeUnknownError(
          'QQ 消息可能已送达，但 OpenClaw 历史记录无法读取，已停止自动重试',
          { cause: error },
        );
      }
      const latest = Array.isArray(history.entries) ? this.objectValue(history.entries[0]) : {};
      if (latest.status !== 'ok' || latest.delivered !== true || latest.deliveryStatus !== 'delivered') {
        const explicitlyNotDelivered = ['error', 'failed'].includes(String(latest.status).toLowerCase())
          && latest.delivered === false
          && ['error', 'failed'].includes(String(latest.deliveryStatus).toLowerCase());
        if (!explicitlyNotDelivered) {
          throw new DeliveryOutcomeUnknownError('QQ 消息可能已送达，但 Gateway 未给出明确投递结果');
        }
        throw new Error('OpenClaw Gateway did not confirm QQ message delivery');
      }
    } finally {
      rmSync(messagePath, { force: true });
      if (jobId) {
        try {
          await this.run(['cron', 'rm', jobId, '--json'], 30_000);
        } catch {
          // Cleanup is best-effort after the Gateway has completed the delivery.
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
    const cliModule = this.openClawCliModule();
    if (cliModule) {
      return this.runner.run(process.execPath, [cliModule, ...args], {
        timeoutMs,
        cwd: this.config.projectRoot,
        env,
        redact,
      });
    }
    return this.runner.run('openclaw', args, { timeoutMs, cwd: this.config.projectRoot, env, redact });
  }

  private openClawCliModule(): string | null {
    const configured = process.env.AIMONITOR_OPENCLAW_CLI_PATH?.trim();
    const candidates = [
      configured,
      join(dirname(process.execPath), 'node_modules', 'openclaw', 'openclaw.mjs'),
      join(this.config.projectRoot, 'node_modules', 'openclaw', 'openclaw.mjs'),
    ].filter((value): value is string => Boolean(value));
    return candidates.find((candidate) => existsSync(candidate)) || null;
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

  private newQrSession(): QrSession {
    let notify = (): void => undefined;
    const changed = new Promise<void>((resolve) => { notify = resolve; });
    return { qrUrl: '', state: 'starting', dispose: () => undefined, changed, notify };
  }

  private signalChange(session: QrSession): void {
    session.notify();
    session.changed = new Promise<void>((resolve) => { session.notify = resolve; });
  }

  private cancelBindingSession(channel: string): void {
    if (channel === OPENCLAW_QQ) this.cancelQqQrSession();
    if (channel === OPENCLAW_WEIXIN) this.cancelWeixinQrSession();
  }

  private cancelQqQrSession(): void {
    this.qqQrSession?.dispose();
    this.qqQrSession = null;
  }

  private cancelWeixinQrSession(): void {
    this.weixinQrSession?.dispose();
    this.weixinQrSession = null;
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

  private objectValue(value: unknown): Record<string, any> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
  }

  private findId(value: unknown): string {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    const record = value as Record<string, unknown>;
    for (const key of ['id', 'jobId', 'job_id']) {
      if (typeof record[key] === 'string' && record[key]) return record[key] as string;
    }
    for (const item of Object.values(record)) {
      const found = this.findId(item);
      if (found) return found;
    }
    return '';
  }
}
