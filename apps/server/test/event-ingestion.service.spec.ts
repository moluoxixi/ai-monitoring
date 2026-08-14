import { describe, expect, it, vi } from 'vitest';
import type { AnswerSummaryService } from '../src/answer-summary/answer-summary.service';
import type { AppConfigService } from '../src/config/app-config.service';
import type { DatabaseService } from '../src/database/database.service';
import type { NormalizedEvent } from '../src/database/database.types';
import { EventIngestionService } from '../src/events/event-ingestion.service';

const event = (metadata: Record<string, unknown> = {}): NormalizedEvent => ({
  source_event_id: 'session:turn:completed', source: 'codex', client: 'codex', kind: 'complete', status: 'completed',
  title: 'done', message: 'task', error_code: null, metadata,
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe('EventIngestionService', () => {
  it('persists immediately and releases delivery only after asynchronous enrichment', async () => {
    const enrichment = deferred<NormalizedEvent>();
    const insertEvent = vi.fn()
      .mockReturnValueOnce([7, true, 1])
      .mockReturnValueOnce([7, false, 0]);
    const releaseDeliveries = vi.fn();
    const database = { insertEvent, releaseDeliveries } as unknown as DatabaseService;
    const answerSummary = { enrichEvent: vi.fn(() => enrichment.promise) } as unknown as AnswerSummaryService;
    const service = new EventIngestionService(database, answerSummary, {
      answerSummaryGraceMs: 0, answerSummaryTimeoutMs: 1_000,
    } as AppConfigService);

    expect(service.ingest(event(), ['pushplus'], 'private answer')).toEqual([7, true]);
    expect(insertEvent).toHaveBeenCalledTimes(1);
    expect(releaseDeliveries).not.toHaveBeenCalled();

    enrichment.resolve(event({ answer_summary: 'answer summary' }));
    await vi.waitFor(() => expect(releaseDeliveries).toHaveBeenCalledWith(7));
    expect(insertEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      metadata: { answer_summary: 'answer summary' },
    }), [], 0);
  });

  it('coalesces a duplicate source and uses its late answer in one model call', async () => {
    vi.useFakeTimers();
    const insertEvent = vi.fn().mockReturnValueOnce([7, true, 1]).mockReturnValue([7, false, 0]);
    const database = {
      insertEvent, releaseDeliveries: vi.fn(),
    } as unknown as DatabaseService;
    const enrichEvent = vi.fn(async (input: NormalizedEvent) => input);
    const service = new EventIngestionService(database, { enrichEvent } as unknown as AnswerSummaryService, {
      answerSummaryGraceMs: 20, answerSummaryTimeoutMs: 1_000,
    } as AppConfigService);

    service.ingest(event({ task_summary: 'task' }), ['pushplus']);
    service.ingest(event({ task_summary: 'task' }), ['pushplus'], 'late final answer');
    await vi.advanceTimersByTimeAsync(20);

    expect(enrichEvent).toHaveBeenCalledOnce();
    expect(enrichEvent).toHaveBeenCalledWith(expect.anything(), 'late final answer');
    vi.useRealTimers();
  });

  it('does not summarize an event after deliveries already exist', () => {
    const database = {
      insertEvent: vi.fn(() => [7, false, 0]),
    } as unknown as DatabaseService;
    const enrichEvent = vi.fn();
    const service = new EventIngestionService(database, { enrichEvent } as unknown as AnswerSummaryService, {
      answerSummaryGraceMs: 0, answerSummaryTimeoutMs: 1_000,
    } as AppConfigService);

    service.ingest(event(), ['pushplus'], 'duplicate answer');

    expect(enrichEvent).not.toHaveBeenCalled();
  });

  it('does not call an online model when no notification channel is bound', () => {
    const insertEvent = vi.fn(() => [7, true, 0]);
    const database = {
      insertEvent,
    } as unknown as DatabaseService;
    const enrichEvent = vi.fn();
    const service = new EventIngestionService(database, { enrichEvent } as unknown as AnswerSummaryService, {
      answerSummaryGraceMs: 0, answerSummaryTimeoutMs: 1_000,
    } as AppConfigService);

    service.ingest(event(), [], 'private answer');

    expect(enrichEvent).not.toHaveBeenCalled();
    expect(insertEvent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { answer_text: 'private answer' },
    }), [], expect.any(Number));
  });

  it('does not persist an answer attached to a failed event', () => {
    const insertEvent = vi.fn(() => [7, true, 0]);
    const database = { insertEvent } as unknown as DatabaseService;
    const service = new EventIngestionService(database, { enrichEvent: vi.fn() } as unknown as AnswerSummaryService, {
      answerSummaryGraceMs: 0, answerSummaryTimeoutMs: 1_000,
    } as AppConfigService);

    service.ingest({ ...event({ answer_text: 'untrusted answer' }), status: 'failed' }, [], 'private answer');

    expect(insertEvent).toHaveBeenCalledWith(expect.objectContaining({ metadata: {} }), [], expect.any(Number));
  });

  it('summarizes when a duplicate event adds the first notification channel', async () => {
    const insertEvent = vi.fn()
      .mockReturnValueOnce([7, true, 0])
      .mockReturnValueOnce([7, false, 1])
      .mockReturnValueOnce([7, false, 0]);
    const releaseDeliveries = vi.fn();
    const database = { insertEvent, releaseDeliveries } as unknown as DatabaseService;
    const enrichEvent = vi.fn(async (input: NormalizedEvent) => ({
      ...input, metadata: { ...input.metadata, answer_summary: 'late summary' },
    }));
    const service = new EventIngestionService(database, { enrichEvent } as unknown as AnswerSummaryService, {
      answerSummaryGraceMs: 0, answerSummaryTimeoutMs: 1_000,
    } as AppConfigService);

    service.ingest(event({ task_summary: 'task' }), [], 'private answer');
    expect(enrichEvent).not.toHaveBeenCalled();
    service.ingest(event({ task_summary: 'task' }), ['pushplus']);

    await vi.waitFor(() => expect(releaseDeliveries).toHaveBeenCalledWith(7));
    expect(enrichEvent).toHaveBeenCalledOnce();
    expect(enrichEvent).toHaveBeenCalledWith(expect.anything(), 'private answer');
  });

  it('releases delivery when answer summarization rejects', async () => {
    const insertEvent = vi.fn().mockReturnValueOnce([7, true, 1]);
    const releaseDeliveries = vi.fn();
    const database = { insertEvent, releaseDeliveries } as unknown as DatabaseService;
    const service = new EventIngestionService(database, {
      enrichEvent: vi.fn().mockRejectedValue(new Error('provider unavailable')),
    } as unknown as AnswerSummaryService, {
      answerSummaryGraceMs: 0, answerSummaryTimeoutMs: 10,
    } as AppConfigService);

    service.ingest(event({ task_summary: '保留这条任务摘要' }), ['pushplus'], 'private answer');

    await vi.waitFor(() => expect(releaseDeliveries).toHaveBeenCalledWith(7));
    expect(insertEvent).toHaveBeenCalledTimes(1);
  });

  it('releases delivery when answer summarization never settles', async () => {
    vi.useFakeTimers();
    const insertEvent = vi.fn().mockReturnValueOnce([7, true, 1]);
    const releaseDeliveries = vi.fn();
    const database = { insertEvent, releaseDeliveries } as unknown as DatabaseService;
    const service = new EventIngestionService(database, {
      enrichEvent: vi.fn(() => new Promise<NormalizedEvent>(() => undefined)),
    } as unknown as AnswerSummaryService, {
      answerSummaryGraceMs: 0, answerSummaryTimeoutMs: 10,
    } as AppConfigService);

    service.ingest(event({ task_summary: '保留这条任务摘要' }), ['pushplus'], 'private answer');
    await vi.advanceTimersByTimeAsync(1_100);

    expect(releaseDeliveries).toHaveBeenCalledWith(7);
    vi.useRealTimers();
  });
});
