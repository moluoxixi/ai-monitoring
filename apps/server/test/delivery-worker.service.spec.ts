import { describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../src/config/app-config.service';
import type { ChannelsService } from '../src/channels/channels.service';
import type { DatabaseService } from '../src/database/database.service';
import type { DeliveryRow } from '../src/database/database.types';
import { DeliveryOutcomeUnknownError } from '../src/channels/channel-provider';
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
  reply_token: null,
  reply_expires_at: null,
  source: 'dashboard',
  client: 'codex-cli',
  kind: 'test_notification',
  status: 'completed',
  title: 'Test notification',
  message: 'Delivery test',
});

const serviceFor = (
  send: ChannelsService['send'],
  rows = [delivery(1, 'openclaw-qq'), delivery(2, 'openclaw-weixin')],
  settings?: { notification: () => { taskLimit: number; resultLimit: number } },
) => {
  const markDelivery = vi.fn();
  const claimDueDeliveries = vi.fn(() => rows);
  const database = {
    claimDueDeliveries,
    markClaimedDelivery: markDelivery,
    renewClaimedDelivery: vi.fn(() => true),
    isClaimedDeliveryActive: vi.fn(() => true),
    ensureDeliveryReplyRoute: vi.fn(() => null),
  } as unknown as DatabaseService;
  const channels = { send } as unknown as ChannelsService;
  const config = { retryBaseSeconds: 5, retryMaxSeconds: 300 } as AppConfigService;
  return { service: new DeliveryWorkerService(database, channels, config, settings as never), claimDueDeliveries, markDelivery };
};

describe('DeliveryWorkerService', () => {
  it('limits the question to 100 characters and the result to 2000 characters', () => {
    const content = notificationContent({
      ...delivery(1, 'openclaw-qq'),
      metadata: { task_summary: 'fix the failing build ' + 'x'.repeat(120) },
      answer_text: 'final result ' + 'y'.repeat(2_100),
    });

    expect(content.title).toBe('(Codex CLI) 任务已完成');
    const [question, result] = content.body.split('\n');
    expect(question).toMatch(/^提问：fix the failing build/);
    expect(Array.from(question!.replace('提问：', ''))).toHaveLength(100);
    expect(Array.from(result!.replace('任务结果：', ''))).toHaveLength(2_000);
  });

  it('does not split Unicode characters at notification limits', () => {
    const content = notificationContent({
      ...delivery(1, 'openclaw-qq'),
      metadata: { task_summary: '😀'.repeat(101) },
      answer_text: '🚀'.repeat(2_001),
    });

    const [question, result] = content.body.split('\n');
    expect(question).not.toContain('\uFFFD');
    expect(result).not.toContain('\uFFFD');
    expect(Array.from(question!.replace('提问：', ''))).toHaveLength(100);
    expect(Array.from(result!.replace('任务结果：', ''))).toHaveLength(2_000);
  });

  it('uses user-configured notification limits immediately', () => {
    const content = notificationContent({
      ...delivery(1, 'openclaw-qq'),
      metadata: { task_summary: '😀'.repeat(12) },
      answer_text: '🚀'.repeat(32),
    }, { taskLimit: 10, resultLimit: 24 });

    const [question, result] = content.body.split('\n');
    expect(Array.from(question!.replace('提问：', ''))).toHaveLength(10);
    expect(Array.from(result!.replace('任务结果：', ''))).toHaveLength(24);
  });

  it('renders heartbeat findings without exposing timing metadata or the internal envelope', () => {
    const content = notificationContent({
      ...delivery(1, 'openclaw-qq'),
      title: 'vite-cli 有新进展',
      message: 'Publish succeeded.',
      metadata: {
        task_summary: 'vite-cli',
        automation_id: 'vite-cli',
        automation_decision: 'NOTIFY',
        timing: {
          started_at: '2026-08-17T12:00:00Z',
          completed_at: '2026-08-17T12:04:12Z',
          duration_ms: 252_000,
        },
      },
      answer_text: 'Publish succeeded.',
    });

    expect(content).toEqual({ title: 'vite-cli 有新进展', body: 'Publish succeeded.' });
  });

  it('does not add ingestion timing to QQ notifications when the source start time is unavailable', () => {
    const content = notificationContent({
      ...delivery(1, 'openclaw-qq'),
      event_created_at: '2026-08-17T12:00:00Z',
    });

    expect(content.body).toBe('提问：Delivery test\n任务结果：未采集到最终回答');
  });

  it('keeps question and result content limits without timing fields', () => {
    const content = notificationContent({
      ...delivery(1, 'openclaw-qq'),
      metadata: {
        task_summary: 'question',
        timing: {
          started_at: '2026-08-17T12:00:00Z',
          completed_at: '2026-08-17T12:00:01Z',
        },
      },
      answer_text: 'result',
    }, { taskLimit: 1, resultLimit: 1 });

    expect(content.body).toBe('提问：q\n任务结果：r');
  });

  it('keeps timing fields for non-QQ notifications', () => {
    const content = notificationContent({
      ...delivery(1, 'openclaw-weixin'),
      metadata: {
        task_summary: 'question',
        timing: {
          started_at: '2026-08-17T12:00:00Z',
          completed_at: '2026-08-17T12:00:01Z',
        },
      },
      answer_text: 'result',
    });

    expect(content.body).toBe([
      '开始时间：2026-08-17 20:00:00（北京时间）',
      '完成时间：2026-08-17 20:00:01（北京时间）',
      '总耗时：1秒',
      '提问：question',
      '任务结果：result',
    ].join('\n'));
  });

  it('reads the current settings when a delivery starts', async () => {
    const sent: string[] = [];
    const send = vi.fn((_channel: string, _title: string, body: string) => {
      sent.push(body);
      return Promise.resolve();
    });
    const settings = { notification: vi.fn(() => ({ taskLimit: 4, resultLimit: 8 })) };
    const { service } = serviceFor(send, [
      { ...delivery(1, 'openclaw-qq'), metadata: { task_summary: 'abcdefgh' }, answer_text: '1234567890' },
    ], settings);

    await service.processOnce();

    expect(settings.notification).toHaveBeenCalled();
    expect(sent[0]).toBe('[任务ID:42]\n\n提问：a...\n任务结果：12345...');
  });

  it('adds a stable route marker only when the database enables QQ replies', async () => {
    const send = vi.fn(() => Promise.resolve());
    const { service } = serviceFor(send, [{
      ...delivery(1, 'openclaw-qq'),
      metadata: { thread_id: 'thread-1', task_summary: 'continue work' },
    }]);
    const database = (service as unknown as { database: DatabaseService }).database;
    vi.mocked(database.ensureDeliveryReplyRoute).mockReturnValue('A'.repeat(43));

    service.processOnce();
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());

    expect(send).toHaveBeenCalledWith(
      'openclaw-qq',
      '(Codex CLI) 任务已完成',
      '[任务ID:42]\n\n[AI-MONITOR-REPLY:' + 'A'.repeat(43) + ']\n\n'
        + '提问：continue work\n任务结果：未采集到最终回答',
    );
  });

  it('adds an enabled route marker to a Codex Desktop completion', async () => {
    const send = vi.fn(() => Promise.resolve());
    const { service } = serviceFor(send, [{
      ...delivery(3, 'openclaw-qq'),
      client: 'codex-desktop',
      metadata: { thread_id: 'desktop-thread-1', task_summary: 'continue desktop work' },
    }]);
    const database = (service as unknown as { database: DatabaseService }).database;
    vi.mocked(database.ensureDeliveryReplyRoute).mockReturnValue('B'.repeat(43));

    service.processOnce();
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());

    expect(database.ensureDeliveryReplyRoute).toHaveBeenCalledWith(3, undefined);
    expect(send).toHaveBeenCalledWith(
      'openclaw-qq',
      '(Codex Desktop) 任务已完成',
      expect.stringContaining('[AI-MONITOR-REPLY:' + 'B'.repeat(43) + ']'),
    );
  });

  it('adds the task ID to non-QQ notifications without exposing a reply route', async () => {
    const send = vi.fn(() => Promise.resolve());
    const { service } = serviceFor(send, [delivery(1, 'openclaw-weixin')]);
    const database = (service as unknown as { database: DatabaseService }).database;
    vi.mocked(database.ensureDeliveryReplyRoute).mockReturnValue('A'.repeat(43));

    service.processOnce();
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());

    expect(send).toHaveBeenCalledWith(
      'openclaw-weixin',
      '(Codex CLI) 任务已完成',
      expect.stringMatching(/^\[任务ID:42\]\n\n(?!\[AI-MONITOR-REPLY:)/),
    );
  });

  it('includes the question and failure message for failed tasks', () => {
    const content = notificationContent({
      ...delivery(1, 'openclaw-qq'),
      status: 'failed',
      message: 'API request failed because the server is overloaded ' + 'x'.repeat(2_100),
      error_code: 'server_overloaded',
      metadata: { task_summary: 'fix the failing build' },
    });

    expect(content.title).toBe('(Codex CLI) 任务失败');
    expect(content.body).toMatch(/^提问：fix the failing build\n失败消息：API request failed/);
    expect(Array.from(content.body.split('\n')[0]!.replace('提问：', '')).length).toBeLessThanOrEqual(100);
    expect(Array.from(content.body.split('\n')[1]!.replace('失败消息：', '')).length).toBeLessThanOrEqual(2_000);
    expect(content.body).toMatch(/\.\.\.$/);
  });

  it('sends the captured final answer without an online summary', () => {
    const content = notificationContent({
      ...delivery(1, 'openclaw-qq'),
      metadata: { task_summary: '优化通知内容' },
      answer_text: '已加入在线通知。\n保留换行和代码：`npm test`',
    });

    expect(content).toEqual({
      title: '(Codex CLI) 任务已完成',
      body: '提问：优化通知内容\n任务结果：已加入在线通知。\n保留换行和代码：`npm test`',
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
      title: '(Codex CLI) 任务失败',
      body: '提问：fix the failing build\n失败消息：unexpected status 502 Bad Gateway: local proxy failed',
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

    expect(content).toEqual({ title: '(Codex CLI) 任务失败', body: '提问：fix the failing build\n失败消息：server_overloaded' });
  });

  it('filters internal Codex review prompts from notification summaries', () => {
    const content = notificationContent({
      ...delivery(1, 'openclaw-qq'),
      message: 'The following is the Codex agent history whose request action you are assessing.',
    });

    expect(content.title).toBe('(Codex CLI) 任务已完成');
    expect(content.body).toBe('提问：Test notification\n任务结果：未采集到最终回答');
    expect(content.body).not.toContain('Codex agent history');
  });

  it('does not present a Codex lifecycle label as a task summary', () => {
    const content = notificationContent({
      ...delivery(1, 'openclaw-qq'),
      title: 'Codex task completed',
      message: 'Codex turn completed',
    });

    expect(content).toEqual({
      title: '(Codex CLI) 任务已完成',
      body: '提问：未提供\n任务结果：未采集到最终回答',
    });
  });

  it('starts all due channel deliveries for the same event concurrently', async () => {
    const resolvers: Array<() => void> = [];
    const send = vi.fn(() => new Promise<void>((resolve) => resolvers.push(resolve)));
    const { service, markDelivery } = serviceFor(send);

    service.processOnce();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));

    expect(markDelivery).not.toHaveBeenCalled();
    resolvers.forEach((resolve) => resolve());
    await vi.waitFor(() => expect(markDelivery).toHaveBeenCalledTimes(2));
    await service.onModuleDestroy();

    expect(markDelivery).toHaveBeenCalledTimes(2);
    expect(markDelivery).toHaveBeenCalledWith(1, 'lease-1', expect.objectContaining({ state: 'sent', attempts: 1 }));
    expect(markDelivery).toHaveBeenCalledWith(2, 'lease-2', expect.objectContaining({ state: 'sent', attempts: 1 }));
  });

  it('starts a newer event while an older delivery is still in flight', async () => {
    const resolvers: Array<() => void> = [];
    const send = vi.fn(() => new Promise<void>((resolve) => resolvers.push(resolve)));
    const { service, claimDueDeliveries } = serviceFor(send, []);
    claimDueDeliveries
      .mockReturnValueOnce([delivery(1, 'openclaw-qq')])
      .mockReturnValueOnce([delivery(2, 'openclaw-qq', 43)])
      .mockReturnValue([]);

    service.processOnce();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    service.processOnce();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));

    resolvers.splice(0).forEach((resolve) => resolve());
    await service.onModuleDestroy();
  });

  it('does not claim more than four in-flight deliveries', async () => {
    const resolvers: Array<() => void> = [];
    const send = vi.fn(() => new Promise<void>((resolve) => resolvers.push(resolve)));
    const rows = Array.from({ length: 4 }, (_, index) => delivery(index + 1, `channel-${index + 1}`, index + 42));
    const { service, claimDueDeliveries } = serviceFor(send, rows);

    service.processOnce();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(4));
    service.processOnce();
    expect(claimDueDeliveries).toHaveBeenCalledTimes(1);

    claimDueDeliveries.mockReturnValue([]);
    resolvers.shift()?.();
    await vi.waitFor(() => {
      service.processOnce();
      expect(claimDueDeliveries).toHaveBeenCalledTimes(2);
    });
    expect(claimDueDeliveries).toHaveBeenLastCalledWith(expect.any(String), 1, expect.any(Number));

    resolvers.splice(0).forEach((resolve) => resolve());
    await service.onModuleDestroy();
  });

  it('bounds shutdown waiting and stops claiming new deliveries', async () => {
    vi.useFakeTimers();
    try {
      let resolveSend: (() => void) | undefined;
      let rejectSend: ((error: Error) => void) | undefined;
      const send = vi.fn((channel: string) => new Promise<void>((resolve, reject) => {
        if (channel === 'openclaw-qq') resolveSend = resolve;
        else rejectSend = reject;
      }));
      const { service, claimDueDeliveries, markDelivery } = serviceFor(send, [
        delivery(1, 'openclaw-qq'),
        delivery(2, 'openclaw-weixin'),
      ]);

      service.processOnce();
      expect(send).toHaveBeenCalledTimes(2);
      const shutdown = service.onModuleDestroy();
      service.processOnce();
      expect(claimDueDeliveries).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(5_000);
      await expect(shutdown).resolves.toBeUndefined();
      resolveSend?.();
      rejectSend?.(new Error('late channel failure'));
      await vi.advanceTimersByTimeAsync(0);
      expect(markDelivery).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps channel failures isolated while concurrent deliveries continue', async () => {
    const send = vi.fn((channel: string) => channel === 'openclaw-qq'
      ? Promise.reject(new Error('QQ unavailable'))
      : Promise.resolve());
    const { service, markDelivery } = serviceFor(send);

    service.processOnce();

    await vi.waitFor(() => expect(markDelivery).toHaveBeenCalledWith(1, 'lease-1', expect.objectContaining({
      state: 'retrying',
      attempts: 1,
      lastError: 'QQ unavailable',
    })));
    expect(markDelivery).toHaveBeenCalledWith(2, 'lease-2', expect.objectContaining({ state: 'sent', attempts: 1 }));
  });

  it('stops retrying when the remote channel outcome is unknown', async () => {
    const send = vi.fn(() => Promise.reject(new DeliveryOutcomeUnknownError('QQ 消息可能已送达')));
    const { service, markDelivery } = serviceFor(send, [delivery(1, 'openclaw-qq')]);

    service.processOnce();

    await vi.waitFor(() => expect(markDelivery).toHaveBeenCalledWith(1, 'lease-1', expect.objectContaining({
      state: 'dead',
      attempts: 1,
      lastError: 'QQ 消息可能已送达',
    })));
  });

  it('does not send a claim suppressed by a follow-up turn', async () => {
    const send = vi.fn(() => Promise.resolve());
    const { service, markDelivery } = serviceFor(send, [delivery(1, 'openclaw-qq')]);
    const database = (service as unknown as { database: DatabaseService }).database;
    vi.mocked(database.isClaimedDeliveryActive).mockReturnValue(false);

    await service.processOnce();

    expect(send).not.toHaveBeenCalled();
    expect(markDelivery).not.toHaveBeenCalled();
  });
});
