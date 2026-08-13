import { Injectable } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AppConfigService } from '../config/app-config.service';
import type { ChannelProvider, ChannelStatus } from './channel-provider';
import { ProcessRunnerService } from './process-runner.service';

@Injectable()
export class AppriseProvider implements ChannelProvider {
  readonly ids: string[];
  private readonly cliPath: string;

  constructor(
    private readonly config: AppConfigService,
    private readonly runner: ProcessRunnerService,
  ) {
    this.ids = config.appriseUrls.map((_, index) => `channel-${index + 1}`);
    const localCli = join(config.projectRoot, '.venv', 'Scripts', process.platform === 'win32' ? 'apprise.exe' : 'apprise');
    this.cliPath = existsSync(localCli) ? localCli : 'apprise';
  }

  availableChannels(): string[] {
    return [...this.ids];
  }

  async status(): Promise<ChannelStatus[]> {
    return this.config.appriseUrls.map((url, index) => ({
      id: `channel-${index + 1}`,
      label: this.label(url, index),
      bound: true,
      error: false,
      bindingMode: 'none',
    }));
  }

  async send(channel: string, title: string, body: string): Promise<void> {
    const index = Number(channel.slice('channel-'.length)) - 1;
    const url = this.config.appriseUrls[index];
    if (!url) throw new Error(`unknown notification channel: ${channel}`);
    await this.runner.run(this.cliPath, ['--title', title, '--body', body, url], {
      timeoutMs: 45_000,
      cwd: this.config.projectRoot,
      redact: [url],
    });
  }

  private label(url: string, index: number): string {
    const scheme = url.split(':', 1)[0]?.toLowerCase();
    if (scheme === 'pushplus') return 'PushPlus';
    if (scheme === 'wecombot') return '企业微信机器人';
    if (scheme === 'qq') return 'QQ Push';
    return `Apprise ${index + 1}`;
  }
}
