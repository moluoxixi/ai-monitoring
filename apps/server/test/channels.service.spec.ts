import { describe, expect, it, vi } from 'vitest';
import { ChannelsService } from '../src/channels/channels.service';
import type { ChannelProvider } from '../src/channels/channel-provider';
import type { AppriseProvider } from '../src/channels/apprise.provider';
import type { OpenClawProvider } from '../src/channels/openclaw.provider';

const provider = (ids: string[], available = ids): ChannelProvider => ({
  ids,
  availableChannels: () => available,
  status: vi.fn(async () => []),
  send: vi.fn(async () => undefined),
});

describe('ChannelsService', () => {
  it('routes every AI client to all currently available channels', () => {
    const service = new ChannelsService(
      provider(['pushplus']) as unknown as AppriseProvider,
      provider(['openclaw-qq', 'openclaw-weixin'], ['openclaw-qq', 'openclaw-weixin']) as unknown as OpenClawProvider,
    );

    expect(service.deliveryChannels()).toEqual(['pushplus', 'openclaw-qq', 'openclaw-weixin']);
  });
});
