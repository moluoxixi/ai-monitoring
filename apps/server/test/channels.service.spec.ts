import { describe, expect, it, vi } from 'vitest';
import { ChannelsService } from '../src/channels/channels.service';
import type { ChannelProvider } from '../src/channels/channel-provider';
import type { AppriseProvider } from '../src/channels/apprise.provider';
import type { OpenClawProvider } from '../src/channels/openclaw.provider';
import type { PushPlusProvider } from '../src/channels/pushplus.provider';

const provider = (ids: string[], available = ids): ChannelProvider => ({
  ids,
  availableChannels: () => available,
  status: vi.fn(async () => []),
  send: vi.fn(async () => undefined),
});

describe('ChannelsService', () => {
  it('routes every AI client to all currently available channels', () => {
    const service = new ChannelsService(
      provider([]) as unknown as AppriseProvider,
      provider(['pushplus']) as unknown as PushPlusProvider,
      provider(['openclaw-qq', 'openclaw-weixin'], ['openclaw-qq', 'openclaw-weixin']) as unknown as OpenClawProvider,
    );

    expect(service.deliveryChannels()).toEqual(['pushplus', 'openclaw-qq', 'openclaw-weixin']);
  });

  it('forwards the pre-rendered message unchanged to the provider', async () => {
    const apprise = provider(['apprise-feishu']);
    const pushPlus = provider([]);
    const openClaw = provider([]);
    const service = new ChannelsService(
      apprise as unknown as AppriseProvider,
      pushPlus as unknown as PushPlusProvider,
      openClaw as unknown as OpenClawProvider,
    );

    await service.send('apprise-feishu', '(Codex CLI) 任务已完成\n\n[任务ID:42]\n\n任务结果');

    expect(apprise.send).toHaveBeenCalledWith('apprise-feishu', '(Codex CLI) 任务已完成\n\n[任务ID:42]\n\n任务结果');
  });
});
