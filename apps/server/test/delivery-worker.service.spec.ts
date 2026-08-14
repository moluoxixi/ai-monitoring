import { describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../src/config/app-config.service';
import type { ChannelsService } from '../src/channels/channels.service';
import type { DatabaseService } from '../src/database/database.service';
import type { DeliveryRow } from '../src/database/database.types';
import { DeliveryWorkerService, notificationContent } from '../src/deliveries/delivery-worker.service';

const delivery = (id: number, channel: string, eventId = 42): DeliveryRow => ({
  id,
  event_id: eventId,
  channel,
  state: 'claimed',
  attempts: 0,
  next_attempt_at: '2026-08-13T00:00:00+00:00',
  last_error: null,
  sent_at: null,
  lease_token: `lease-${id}`,
  lease_expires_at: '2026-08-13T00:01:00+00:00',
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
    claimDueDeliveries: vi.fn(() => rows),
    markClaimedDelivery: markDelivery,
    renewClaimedDelivery: vi.fn(() => true),
  } as unknown as DatabaseService;
  const channels = { send } as unknown as ChannelsService;
  const config = { retryBaseSeconds: 5, retryMaxSeconds: 300 } as AppConfigService;
  return { service: new DeliveryWorkerService(database, channels, config), markDelivery };
};

describe('DeliveryWorkerService', () => {
  it('uses a concise title and limits the task summary to 100 characters', () => {
    const content = notificationContent({
      ...delivery(1, 'openclaw-qq'),
      metadata: { task_summary: 'fix the failing build ' + 'x'.repeat(120) },
    });

    expect(content.title).toBe('Codex 任务已完成');
    expect(content.body).toMatch(/^任务摘要：fix the failing build/);
    expect(Array.from(content.body.replace('任务摘要：', ''))).toHaveLength(100);
  });

  it('shows the failure message instead of repeating the task summary', () => {
    const content = notificationContent({
      ...delivery(1, 'openclaw-qq'),
      status: 'failed',
      message: 'API request failed because the server is overloaded ' + 'x'.repeat(120),
      error_code: 'server_overloaded',
      metadata: { task_summary: 'fix the failing build' },
    });

    expect(content.title).toBe('Codex 任务失败');
    expect(content.body).toMatch(/^失败消息：API request failed/);
    expect(content.body).not.toContain('fix the failing build');
    expect(Array.from(content.body.replace('失败消息：', '')).length).toBeLessThanOrEqual(100);
    expect(content.body).toMatch(/\.\.\.$/);
  });

  it('shows stable task and answer sections when an answer summary exists', () => {
    const content = notificationContent({
      ...delivery(1, 'openclaw-qq'),
      metadata: { task_summary: '优化通知内容', answer_summary: '已加入在线摘要与自动回退。' },
    });

    expect(content).toEqual({
      title: 'Codex 任务已完成',
      body: '任务摘要：优化通知内容\n回答摘要：已加入在线摘要与自动回退。',
    });
  });

  it('prefers the sanitized failure message captured by the event adapter', () => {
    const content = notificationContent({
      ...delivery(1, 'openclaw-qq'),
      status: 'failed',
      message: '提问：fix the failing build',
      error_code: 'other',
      metadata: {
        task_summary: 'fix the failing build',
        failure_message: 'unexpected status 502 Bad Gateway: local proxy failed',
      },
    });

    expect(content).toEqual({
      title: 'Codex 任务失败',
      body: '失败消息：unexpected status 502 Bad Gateway: local proxy failed',
    });
  });

  it('falls back to the error code when a failed event only contains the prompt', () => {
    const content = notificationContent({
      ...delivery(1, 'openclaw-qq'),
      status: 'failed',
      message: '提问：fix the failing build',
      error_code: 'server_overloaded',
      metadata: { task_summary: 'fix the failing build' },
    });

    expect(content).toEqual({ title: 'Codex 任务失败', body: '失败消息：server_overloaded' });
  });

  it('filters internal Codex review prompts from notification summaries', () => {
    const content = notificationContent({
      ...delivery(1, 'openclaw-qq'),
      message: 'The following is the Codex agent history whose request action you are assessing.',
    });

    expect(content.title).toBe('Codex 任务已完成');
    expect(content.body).toBe('任务摘要：Test notification');
    expect(content.body).not.toContain('Codex agent history');
  });

  it('does not present a Codex lifecycle label as a task summary', () => {
    const content = notificationContent({
      ...delivery(1, 'openclaw-qq'),
      title: 'Codex task completed',
      message: 'Codex turn completed',
    });

    expect(content).toEqual({
      title: 'Codex 任务已完成',
      body: '任务摘要：未提供',
    });
  });

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
    expect(markDelivery).toHaveBeenCalledWith(1, 'lease-1', expect.objectContaining({ state: 'sent', attempts: 1 }));
    expect(markDelivery).toHaveBeenCalledWith(2, 'lease-2', expect.objectContaining({ state: 'sent', attempts: 1 }));
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

    expect(markDelivery).toHaveBeenCalledWith(1, 'lease-1', expect.objectContaining({
      state: 'retrying',
      attempts: 1,
      lastError: 'QQ unavailable',
    }));
    expect(markDelivery).toHaveBeenCalledWith(2, 'lease-2', expect.objectContaining({ state: 'sent', attempts: 1 }));
  });
});
