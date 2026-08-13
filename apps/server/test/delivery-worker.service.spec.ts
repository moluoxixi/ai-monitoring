import { describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../src/config/app-config.service';
import type { ChannelsService } from '../src/channels/channels.service';
import type { DatabaseService } from '../src/database/database.service';
import type { DeliveryRow } from '../src/database/database.types';
import { DeliveryWorkerService } from '../src/deliveries/delivery-worker.service';

const delivery = (id: number, channel: string, eventId = 42): DeliveryRow => ({
  id,
  event_id: eventId,
  channel,
  state: 'pending',
  attempts: 0,
  next_attempt_at: '2026-08-13T00:00:00+00:00',
  last_error: null,
  sent_at: null,
  source: 'dashboard',
  client: 'codex',
  kind: 'test_notification',
  status: 'completed',
  title: 'Test notification',
  message: 'Delivery test',
});

const serviceFor = (
  send: ChannelsService['send'],
  rows = [delivery(1, 'openclaw-qq'), delivery(2, 'openclaw-weixin')],
) => {
  const markDelivery = vi.fn();
  const database = {
    dueDeliveries: vi.fn(() => rows),
    markDelivery,
  } as unknown as DatabaseService;
  const channels = { send } as unknown as ChannelsService;
  const config = { retryBaseSeconds: 5, retryMaxSeconds: 300 } as AppConfigService;
  return { service: new DeliveryWorkerService(database, channels, config), markDelivery };
};

describe('DeliveryWorkerService', () => {
  it('starts all due channel deliveries for the same event concurrently', async () => {
    const resolvers: Array<() => void> = [];
    const send = vi.fn(() => new Promise<void>((resolve) => resolvers.push(resolve)));
    const { service, markDelivery } = serviceFor(send);

    const processing = service.processOnce();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));

    expect(markDelivery).not.toHaveBeenCalled();
    resolvers.forEach((resolve) => resolve());
    await processing;

    expect(markDelivery).toHaveBeenCalledTimes(2);
    expect(markDelivery).toHaveBeenCalledWith(1, expect.objectContaining({ state: 'sent', attempts: 1 }));
    expect(markDelivery).toHaveBeenCalledWith(2, expect.objectContaining({ state: 'sent', attempts: 1 }));
  });

  it('waits for one event before starting the next event', async () => {
    const resolvers: Array<() => void> = [];
    const send = vi.fn(() => new Promise<void>((resolve) => resolvers.push(resolve)));
    const rows = [
      delivery(1, 'openclaw-qq'),
      delivery(2, 'openclaw-weixin'),
      delivery(3, 'openclaw-qq', 43),
    ];
    const { service } = serviceFor(send, rows);

    const processing = service.processOnce();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));

    resolvers.splice(0).forEach((resolve) => resolve());
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(3));
    resolvers.splice(0).forEach((resolve) => resolve());
    await processing;
  });

  it('keeps channel failures isolated while concurrent deliveries continue', async () => {
    const send = vi.fn((channel: string) => channel === 'openclaw-qq'
      ? Promise.reject(new Error('QQ unavailable'))
      : Promise.resolve());
    const { service, markDelivery } = serviceFor(send);

    await service.processOnce();

    expect(markDelivery).toHaveBeenCalledWith(1, expect.objectContaining({
      state: 'retrying',
      attempts: 1,
      lastError: 'QQ unavailable',
    }));
    expect(markDelivery).toHaveBeenCalledWith(2, expect.objectContaining({ state: 'sent', attempts: 1 }));
  });
});
