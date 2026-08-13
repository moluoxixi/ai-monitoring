import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { AppriseProvider } from './apprise.provider';
import type { BindingStartResult, BindingWaitResult, ChannelProvider, ChannelStatus } from './channel-provider';
import { OpenClawProvider } from './openclaw.provider';
import { PlatformsService } from '../platforms/platforms.service';

@Injectable()
export class ChannelsService {
  private readonly providers: ChannelProvider[];
  private cache: { timestamp: number; value: ChannelStatus[] } | null = null;

  constructor(
    apprise: AppriseProvider,
    openClaw: OpenClawProvider,
    private readonly platforms: PlatformsService,
  ) {
    this.providers = [apprise, openClaw];
  }

  availableChannels(): string[] {
    return this.providers.flatMap((provider) => provider.availableChannels());
  }

  channelsForClient(client: string): string[] {
    let selected: string | null = null;
    try {
      selected = this.platforms.get(this.platforms.resolve(client)).binding.channel;
    } catch {
      return [];
    }
    return selected && this.availableChannels().includes(selected) ? [selected] : [];
  }

  async status(force = false): Promise<ChannelStatus[]> {
    const now = performance.now();
    if (!force && this.cache && now - this.cache.timestamp < 30_000) return this.cache.value.map((item) => ({ ...item }));
    const value = (await Promise.all(this.providers.map((provider) => provider.status()))).flat();
    this.cache = { timestamp: now, value: value.map((item) => ({ ...item })) };
    return value;
  }

  async send(channel: string, title: string, body: string): Promise<void> {
    const provider = this.provider(channel);
    await provider.send(channel, title, body);
  }

  async startBinding(channel: string): Promise<BindingStartResult> {
    const provider = this.provider(channel);
    if (!provider.startBinding) throw new BadRequestException('notification channel does not support account binding');
    const result = await provider.startBinding(channel);
    this.cache = null;
    return result;
  }

  async waitBinding(channel: string): Promise<BindingWaitResult> {
    const provider = this.provider(channel);
    if (!provider.waitBinding) throw new BadRequestException('notification channel does not support account binding');
    const result = await provider.waitBinding(channel);
    this.cache = null;
    return result;
  }

  async cancelBinding(channel: string): Promise<void> {
    const provider = this.provider(channel);
    if (provider.cancelBinding) await provider.cancelBinding(channel);
  }

  async unbind(channel: string): Promise<boolean> {
    const provider = this.provider(channel);
    if (!provider.unbind) throw new BadRequestException('notification channel does not support account binding');
    const removed = await provider.unbind(channel);
    this.cache = null;
    return removed;
  }

  private provider(channel: string): ChannelProvider {
    const provider = this.providers.find((item) => item.ids.includes(channel));
    if (!provider) throw new NotFoundException('unknown notification channel');
    return provider;
  }
}
