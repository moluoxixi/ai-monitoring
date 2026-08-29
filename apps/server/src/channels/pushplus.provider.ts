import { BadRequestException, Injectable } from '@nestjs/common';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AppConfigService } from '../config/app-config.service';
import type { BindingStartResult, BindingWaitResult, ChannelProvider, ChannelStatus } from './channel-provider';
import { ProcessRunnerService } from './process-runner.service';

export const PUSHPLUS = 'pushplus';
const PUSHPLUS_HELP_URL = 'https://www.pushplus.plus/push1.html';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;

interface PushPlusBinding {
  version: 1;
  token: string;
}

@Injectable()
export class PushPlusProvider implements ChannelProvider {
  readonly ids = [PUSHPLUS] as const;
  private readonly cliPath: string;

  constructor(
    private readonly config: AppConfigService,
    private readonly runner: ProcessRunnerService,
  ) {
    const localCli = join(config.projectRoot, '.venv', 'Scripts', process.platform === 'win32' ? 'apprise.exe' : 'apprise');
    this.cliPath = existsSync(localCli) ? localCli : 'apprise';
  }

  availableChannels(): string[] {
    return this.readToken() ? [PUSHPLUS] : [];
  }

  async status(): Promise<ChannelStatus[]> {
    const { token, invalid } = this.loadBinding();
    return [{
      id: PUSHPLUS,
      label: 'PushPlus',
      bound: Boolean(token),
      error: invalid,
      bindingMode: 'credential',
      message: invalid ? '本地绑定配置无效，请重新绑定' : undefined,
    }];
  }

  async startBinding(channel: string): Promise<BindingStartResult> {
    this.assertChannel(channel);
    return {
      mode: 'credential',
      message: '请输入 PushPlus 控制台中的 Token',
      helpUrl: PUSHPLUS_HELP_URL,
    };
  }

  async bindCredential(channel: string, credential: string | Record<string, unknown>): Promise<BindingWaitResult> {
    this.assertChannel(channel);
    if (typeof credential !== 'string') throw new BadRequestException('PushPlus Token 格式无效');
    const token = credential.trim();
    if (!TOKEN_PATTERN.test(token)) throw new BadRequestException('PushPlus Token 格式无效');
    this.saveBinding({ version: 1, token });
    return { connected: true, bound: true, message: 'PushPlus 已绑定' };
  }

  async unbind(channel: string): Promise<boolean> {
    this.assertChannel(channel);
    if (!existsSync(this.config.pushPlusBindingPath)) return false;
    unlinkSync(this.config.pushPlusBindingPath);
    return true;
  }

  async send(channel: string, message: string): Promise<void> {
    this.assertChannel(channel);
    const token = this.readToken();
    if (!token) throw new Error('PushPlus is not bound');
    const url = `pushplus://${token}`;
    await this.runner.run(this.cliPath, ['--body', message, url], {
      timeoutMs: 45_000,
      cwd: this.config.projectRoot,
      redact: [token, url],
    });
  }

  private assertChannel(channel: string): void {
    if (channel !== PUSHPLUS) throw new BadRequestException('unknown PushPlus channel');
  }

  private readToken(): string {
    return this.loadBinding().token;
  }

  private loadBinding(): { token: string; invalid: boolean } {
    if (!existsSync(this.config.pushPlusBindingPath)) return { token: '', invalid: false };
    try {
      const payload = JSON.parse(readFileSync(this.config.pushPlusBindingPath, 'utf8')) as Partial<PushPlusBinding>;
      if (payload.version !== 1 || typeof payload.token !== 'string' || !TOKEN_PATTERN.test(payload.token)) {
        return { token: '', invalid: true };
      }
      return { token: payload.token, invalid: false };
    } catch {
      return { token: '', invalid: true };
    }
  }

  private saveBinding(binding: PushPlusBinding): void {
    mkdirSync(dirname(this.config.pushPlusBindingPath), { recursive: true });
    const temporary = `${this.config.pushPlusBindingPath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(binding, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.config.pushPlusBindingPath);
  }
}
