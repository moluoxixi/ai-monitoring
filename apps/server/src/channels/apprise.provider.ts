import { BadRequestException, Injectable } from '@nestjs/common';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AppConfigService } from '../config/app-config.service';
import { APPRISE_PLATFORMS, apprisePlatform, normalizePlatformValues } from './apprise-platforms';
import type { BindingStartResult, BindingWaitResult, ChannelProvider, ChannelStatus } from './channel-provider';
import { ProcessRunnerService } from './process-runner.service';

interface AppriseChannelDocument {
  version: 1;
  channels: Record<string, { values: Record<string, string> }>;
}

@Injectable()
export class AppriseProvider implements ChannelProvider {
  readonly ids: string[];
  private readonly cliPath: string;

  constructor(
    private readonly config: AppConfigService,
    private readonly runner: ProcessRunnerService,
  ) {
    this.ids = [
      ...APPRISE_PLATFORMS.map((item) => item.id),
      ...config.appriseUrls.map((_, index) => `channel-${index + 1}`),
    ];
    const localCli = join(config.projectRoot, '.venv', 'Scripts', process.platform === 'win32' ? 'apprise.exe' : 'apprise');
    this.cliPath = existsSync(localCli) ? localCli : 'apprise';
  }

  availableChannels(): string[] {
    const { document, invalid } = this.loadDocument();
    const configured = APPRISE_PLATFORMS
      .filter((definition) => !invalid && this.configuredValues(document, definition.id) !== null)
      .map((definition) => definition.id);
    return [...configured, ...this.config.appriseUrls.map((_, index) => `channel-${index + 1}`)];
  }

  async status(): Promise<ChannelStatus[]> {
    const { document, invalid } = this.loadDocument();
    const configured = APPRISE_PLATFORMS.map((definition) => {
      const item = document.channels[definition.id];
      const valid = !invalid && this.configuredValues(document, definition.id) !== null;
      return {
        id: definition.id,
        label: definition.label,
        bound: valid,
        error: invalid || Boolean(item) && !valid,
        bindingMode: 'credential' as const,
        message: invalid ? 'Apprise 本地配置文件损坏，请修复或移除后重新绑定' : Boolean(item) && !valid ? '本地绑定配置无效，请重新绑定' : undefined,
      };
    });
    const legacy = this.config.appriseUrls.map((url, index) => ({
      id: `channel-${index + 1}`,
      label: this.legacyLabel(url, index),
      bound: true,
      error: false,
      bindingMode: 'none' as const,
      message: '由 AIMONITOR_APPRISE_URLS 管理',
    }));
    return [...configured, ...legacy];
  }

  async startBinding(channel: string): Promise<BindingStartResult> {
    const definition = apprisePlatform(channel);
    if (!definition) throw new BadRequestException('该 Apprise 通道不支持页面绑定');
    return {
      mode: 'credential',
      message: definition.message,
      helpUrl: definition.helpUrl,
      form: definition.form,
    };
  }

  async bindCredential(channel: string, credential: string | Record<string, unknown>): Promise<BindingWaitResult> {
    const definition = apprisePlatform(channel);
    if (!definition) throw new BadRequestException('该 Apprise 通道不支持页面绑定');
    if (!credential || typeof credential !== 'object' || Array.isArray(credential)) {
      throw new BadRequestException('通道配置格式无效');
    }
    const values = normalizePlatformValues(definition, credential);
    const url = definition.buildUrl(values);
    const redact = [url, ...Object.values(values).filter(Boolean)];
    await this.runner.run(this.cliPath, ['--dry-run', '--title', 'AI Monitor', '--body', 'configuration check', url], {
      timeoutMs: 15_000,
      cwd: this.config.projectRoot,
      redact,
    });
    const loaded = this.loadDocument();
    if (loaded.invalid) throw new BadRequestException('Apprise 本地配置文件损坏，请修复或移除后重试');
    const document = loaded.document;
    document.channels[channel] = { values };
    this.saveDocument(document);
    return { connected: true, bound: true, message: `${definition.label}已绑定` };
  }

  async unbind(channel: string): Promise<boolean> {
    const definition = apprisePlatform(channel);
    if (!definition) throw new BadRequestException('环境变量通道不能在页面解绑');
    const loaded = this.loadDocument();
    if (loaded.invalid) throw new BadRequestException('Apprise 本地配置文件损坏，请修复或移除后重试');
    const document = loaded.document;
    if (!document.channels[channel]) return false;
    delete document.channels[channel];
    this.saveDocument(document);
    return true;
  }

  async send(channel: string, title: string, body: string): Promise<void> {
    const definition = apprisePlatform(channel);
    let url = '';
    let secrets: string[] = [];
    if (definition) {
      const loaded = this.loadDocument();
      if (loaded.invalid) throw new Error('Apprise local channel configuration is invalid');
      const values = this.configuredValues(loaded.document, channel);
      if (!values) throw new Error(`${definition.label} is not bound`);
      url = definition.buildUrl(values);
      secrets = Object.values(values).filter(Boolean);
    } else {
      const index = Number(channel.slice('channel-'.length)) - 1;
      url = this.config.appriseUrls[index] || '';
    }
    if (!url) throw new Error(`unknown notification channel: ${channel}`);
    await this.runner.run(this.cliPath, ['--title', title, '--body', body, url], {
      timeoutMs: 45_000,
      cwd: this.config.projectRoot,
      redact: [url, ...secrets],
    });
  }

  private configuredValues(document: AppriseChannelDocument, channel: string): Record<string, string> | null {
    const definition = apprisePlatform(channel);
    const item = document.channels[channel];
    if (!definition || !item || !item.values || typeof item.values !== 'object') return null;
    try {
      return normalizePlatformValues(definition, item.values);
    } catch {
      return null;
    }
  }

  private loadDocument(): { document: AppriseChannelDocument; invalid: boolean } {
    const empty: AppriseChannelDocument = { version: 1, channels: {} };
    if (!existsSync(this.config.appriseChannelsPath)) return { document: empty, invalid: false };
    try {
      const payload = JSON.parse(readFileSync(this.config.appriseChannelsPath, 'utf8')) as Partial<AppriseChannelDocument>;
      if (payload.version !== 1 || !payload.channels || typeof payload.channels !== 'object' || Array.isArray(payload.channels)) {
        return { document: empty, invalid: true };
      }
      return { document: { version: 1, channels: payload.channels }, invalid: false };
    } catch {
      return { document: empty, invalid: true };
    }
  }

  private saveDocument(document: AppriseChannelDocument): void {
    mkdirSync(dirname(this.config.appriseChannelsPath), { recursive: true });
    const temporary = `${this.config.appriseChannelsPath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.config.appriseChannelsPath);
  }

  private legacyLabel(url: string, index: number): string {
    const scheme = url.split(':', 1)[0]?.toLowerCase() || '';
    const known = APPRISE_PLATFORMS.find((item) => item.id.includes(scheme));
    if (scheme === 'pushplus') return 'PushPlus（环境变量）';
    if (known) return `${known.label}（环境变量）`;
    return `Apprise ${index + 1}（环境变量）`;
  }
}
