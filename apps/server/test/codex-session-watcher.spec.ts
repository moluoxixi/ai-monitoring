import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../src/config/app-config.service';
import type { ChannelsService } from '../src/channels/channels.service';
import type { EventIngestionService } from '../src/events/event-ingestion.service';
import {
  CodexSessionWatcherService,
  parseCodexSessionLine,
  sanitizeFailureMessage as legacySanitizeFailureMessage,
  summarizeTask as legacySummarizeTask,
} from '../src/events/codex-session-watcher.service';
import { sanitizeFailureMessage, summarizeTask } from '../src/utils/event-text';

const tempDirectories: string[] = [];

const terminalLine = (payload: Record<string, unknown>, timestamp = new Date().toISOString()): string =>
  JSON.stringify({ timestamp, type: 'event_msg', payload });

const serviceFor = (directory: string) => {
  const insertEvent = vi.fn();
  const suppressProvisionalFailures = vi.fn();
  const config = { codexSessionsPath: directory, codexBackfillMinutes: 120 } as AppConfigService;
  const channels = { deliveryChannels: vi.fn(() => []) } as unknown as ChannelsService;
  const ingestion = { ingest: insertEvent, suppressProvisionalFailures } as unknown as EventIngestionService;
  return { service: new CodexSessionWatcherService(config, channels, ingestion), insertEvent, suppressProvisionalFailures };
};

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Codex session watcher parser', () => {
  it('keeps the legacy text helper exports wired to the shared module', () => {
    expect(legacySanitizeFailureMessage).toBe(sanitizeFailureMessage);
    expect(legacySummarizeTask).toBe(summarizeTask);
  });

  it('keeps a short user task summary for the terminal event', () => {
    const prompt = parseCodexSessionLine(terminalLine({
      type: 'user_message', message: '<in-app-browser-context>ignore me</in-app-browser-context> ## My request: 修复登录失败',
    }), 'session-1');
    const result = parseCodexSessionLine(terminalLine({
      type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'private response',
    }), prompt.sessionId, prompt.taskSummary);

    expect(result.event).toMatchObject({
      message: '提问：修复登录失败',
      metadata: { task_summary: '修复登录失败' },
    });
    expect(result.taskSummary).toBe('');
    expect(result.answerSource).toBe('private response');
  });

  it('marks a follow-up turn so provisional failures are suppressed', () => {
    const started = parseCodexSessionLine(terminalLine({ type: 'task_started', turn_id: 'turn-2' }), 'session-1');
    const prompt = parseCodexSessionLine(terminalLine({ type: 'user_message', message: '继续任务' }), started.sessionId);

    expect(started.suppressProvisional).toBe(true);
    expect(prompt.suppressProvisional).toBe(true);
  });

  it('records task start, completion, and duration from Codex timestamps', () => {
    const started = parseCodexSessionLine(
      terminalLine({ type: 'task_started', turn_id: 'turn-timing' }, '2026-08-17T12:00:00.000Z'),
      'session-timing',
    );
    const completed = parseCodexSessionLine(
      terminalLine({ type: 'task_complete', turn_id: 'turn-timing' }, '2026-08-17T12:04:12.500Z'),
      started.sessionId,
      started.taskSummary,
      started.isSubagent,
      started.answerSource,
      started.client,
      started.startedAt,
      started.startedTurnId,
    );

    expect(completed.event?.metadata).toMatchObject({
      timing: {
        started_at: '2026-08-17T12:00:00.000Z',
        completed_at: '2026-08-17T12:04:12.500Z',
        duration_ms: 252_500,
      },
    });
  });

  it('does not reuse an earlier turn start time after a new user message', () => {
    const earlierStarted = parseCodexSessionLine(
      terminalLine({ type: 'task_started', turn_id: 'turn-earlier' }, '2026-08-17T12:00:00.000Z'),
      'session-timing',
    );
    const nextPrompt = parseCodexSessionLine(
      terminalLine({ type: 'user_message', message: 'new turn' }, '2026-08-17T12:05:00.000Z'),
      earlierStarted.sessionId,
      earlierStarted.taskSummary,
      earlierStarted.isSubagent,
      earlierStarted.answerSource,
      earlierStarted.client,
      earlierStarted.startedAt,
      earlierStarted.startedTurnId,
    );
    const nextCompleted = parseCodexSessionLine(
      terminalLine({ type: 'task_complete', turn_id: 'turn-next' }, '2026-08-17T12:06:00.000Z'),
      nextPrompt.sessionId,
      nextPrompt.taskSummary,
      nextPrompt.isSubagent,
      nextPrompt.answerSource,
      nextPrompt.client,
      nextPrompt.startedAt,
      nextPrompt.startedTurnId,
    );

    expect(nextPrompt.startedAt).toBe('');
    expect(nextCompleted.event?.metadata).toMatchObject({
      timing: { completed_at: '2026-08-17T12:06:00.000Z' },
    });
    expect(nextCompleted.event?.metadata?.timing).not.toHaveProperty('started_at');
    expect(nextCompleted.event?.metadata?.timing).not.toHaveProperty('duration_ms');
  });

  it('does not apply another turn start time to a mismatched completion', () => {
    const started = parseCodexSessionLine(
      terminalLine({ type: 'task_started', turn_id: 'turn-b' }, '2026-08-17T12:05:00.000Z'),
      'session-timing',
    );
    const completed = parseCodexSessionLine(
      terminalLine({ type: 'task_complete', turn_id: 'turn-a' }, '2026-08-17T12:06:00.000Z'),
      started.sessionId,
      started.taskSummary,
      started.isSubagent,
      started.answerSource,
      started.client,
      started.startedAt,
      started.startedTurnId,
    );

    expect(completed.event?.metadata).toMatchObject({
      timing: { completed_at: '2026-08-17T12:06:00.000Z' },
    });
    expect(completed.event?.metadata?.timing).not.toHaveProperty('started_at');
    expect(completed.event?.metadata?.timing).not.toHaveProperty('duration_ms');
  });

  it('uses the last agent message for the current terminal event and clears it for the next turn', () => {
    const answer = parseCodexSessionLine(
      terminalLine({ type: 'agent_message', message: 'first final answer' }),
      'session-1',
      'first task',
    );
    const completed = parseCodexSessionLine(
      terminalLine({ type: 'task_complete', turn_id: 'turn-1' }),
      answer.sessionId,
      answer.taskSummary,
      answer.isSubagent,
      answer.answerSource,
    );
    const nextPrompt = parseCodexSessionLine(
      terminalLine({ type: 'user_message', message: 'second task' }),
      completed.sessionId,
      completed.taskSummary,
      completed.isSubagent,
      '',
    );

    expect(completed.answerSource).toBe('first final answer');
    expect(nextPrompt.answerSource).toBe('');
  });

  it('maps task_complete without retaining conversation content', () => {
    const meta = parseCodexSessionLine(JSON.stringify({
      type: 'session_meta', payload: { session_id: 'session-1', base_instructions: 'private' },
    }));
    const result = parseCodexSessionLine(terminalLine({
      type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'private response',
    }), meta.sessionId);

    expect(result.event).toMatchObject({
      source_event_id: 'session-1:turn-1:completed', status: 'completed', kind: 'task_complete',
      client: 'codex-desktop',
      metadata: { thread_id: 'session-1', turn_id: 'turn-1' },
    });
    expect(JSON.stringify(result.event)).not.toContain('private');
  });

  it('maps task_complete errors with a redacted failure message', () => {
    const result = parseCodexSessionLine(terminalLine({
      type: 'task_complete', turn_id: 'turn-failed',
      error: {
        message: 'unexpected status 502; Authorization: Bearer private-token; token=private-query; path C:\\Users\\alice\\project',
        codex_error_info: 'server_overloaded',
      },
    }), 'session-failed');

    expect(result.event).toMatchObject({
      source_event_id: 'session-failed:turn-failed:failed',
      status: 'failed',
      error_code: 'server_overloaded',
      metadata: {
        failure_message: 'unexpected status 502; Authorization: <redacted>; token=<redacted>; path C:\\Users\\<user>\\project',
      },
    });
    expect(JSON.stringify(result.event)).not.toContain('private-token');
    expect(JSON.stringify(result.event)).not.toContain('private-query');
    expect(JSON.stringify(result.event)).not.toContain('alice');
  });

  it('maps turn_aborted to interrupted', () => {
    const result = parseCodexSessionLine(terminalLine({
      type: 'turn_aborted', turn_id: 'turn-2', reason: 'private reason',
    }), 'session-2');
    expect(result.event).toMatchObject({
      source_event_id: 'session-2:turn-2:interrupted', status: 'interrupted', kind: 'turn_aborted',
    });
  });

  it('ignores terminal events from internal subagent sessions', () => {
    const meta = parseCodexSessionLine(JSON.stringify({
      type: 'session_meta',
      payload: { session_id: 'subagent-session', source: { subagent: { thread_spawn: {} } } },
    }));
    const result = parseCodexSessionLine(
      terminalLine({ type: 'task_complete', turn_id: 'subagent-turn' }),
      meta.sessionId,
      meta.taskSummary,
      meta.isSubagent,
    );

    expect(meta.isSubagent).toBe(true);
    expect(result.event).toBeUndefined();
  });

  it('recognizes string and typed subagent metadata variants', () => {
    for (const source of [
      'subagent',
      { type: 'subagent' },
      { kind: 'subagent' },
    ]) {
      const meta = parseCodexSessionLine(JSON.stringify({
        type: 'session_meta', payload: { session_id: 'variant-session', source },
      }));
      expect(meta.isSubagent).toBe(true);
      expect(parseCodexSessionLine(
        terminalLine({ type: 'task_complete', turn_id: 'variant-turn' }),
        meta.sessionId,
        '',
        meta.isSubagent,
      ).event).toBeUndefined();
    }
  });

  it('keeps an explicitly CLI session as Codex CLI', () => {
    const meta = parseCodexSessionLine(JSON.stringify({
      type: 'session_meta',
      payload: { session_id: 'cli-session', source: 'cli', originator: 'Codex CLI', thread_source: 'user' },
    }));
    const result = parseCodexSessionLine(
      terminalLine({ type: 'task_complete', turn_id: 'cli-turn' }),
      meta.sessionId,
      'run from cli',
      meta.isSubagent,
      '',
      meta.client,
    );

    expect(meta.client).toBe('codex-cli');
    expect(result.event?.client).toBe('codex-cli');
  });

  it('reads session metadata when it is not the first JSONL line', () => {
    const meta = parseCodexSessionLine(JSON.stringify({
      type: 'session_meta',
      payload: { session_id: 'late-session', source: { type: 'subagent' } },
    }), '');
    expect(meta.sessionId).toBe('late-session');
    expect(meta.isSubagent).toBe(true);
  });

  it('ignores malformed, non-terminal, and terminal lines without identifiers', () => {
    expect(parseCodexSessionLine('not json').event).toBeUndefined();
    expect(parseCodexSessionLine(JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message' } }), 'session').event).toBeUndefined();
    expect(parseCodexSessionLine(terminalLine({ type: 'task_complete' }), 'session').event).toBeUndefined();
  });
});

describe('Codex session file synchronization', () => {
  it('recovers the session id before scanning the tail of a large file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'codex-watcher-'));
    tempDirectories.push(directory);
    const path = join(directory, 'large.jsonl');
    writeFileSync(path, `${JSON.stringify({ type: 'session_meta', payload: { id: 'large-session' } })}\n`);
    appendFileSync(path, `${'x'.repeat(1024)}\n`.repeat(1100));
    appendFileSync(path, `${terminalLine({ type: 'task_complete', turn_id: 'large-turn' })}\n`);
    const { service, insertEvent } = serviceFor(directory);

    await service.syncFile(path);

    expect(insertEvent).toHaveBeenCalledWith(expect.objectContaining({
      source_event_id: 'large-session:large-turn:completed',
    }), []);
  });

  it('recovers the active task summary before scanning the tail of a large file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'codex-watcher-'));
    tempDirectories.push(directory);
    const path = join(directory, 'large-summary.jsonl');
    const completedAt = new Date();
    const startedAt = new Date(completedAt.getTime() - 90_000);
    writeFileSync(path, `${JSON.stringify({ type: 'session_meta', payload: { id: 'large-summary-session' } })}\n`);
    appendFileSync(path, `${terminalLine({ type: 'user_message', message: '优化主题并发送消息摘要' })}\n`);
    appendFileSync(path, `${terminalLine({ type: 'task_started', turn_id: 'large-summary-turn' }, startedAt.toISOString())}\n`);
    appendFileSync(path, `${'x'.repeat(1024)}\n`.repeat(1100));
    appendFileSync(path, `${terminalLine({ type: 'task_complete', turn_id: 'large-summary-turn' }, completedAt.toISOString())}\n`);
    const { service, insertEvent } = serviceFor(directory);

    await service.syncFile(path);

    expect(insertEvent).toHaveBeenCalledWith(expect.objectContaining({
      source_event_id: 'large-summary-session:large-summary-turn:completed',
      message: '提问：优化主题并发送消息摘要',
      metadata: expect.objectContaining({
        task_summary: '优化主题并发送消息摘要',
        timing: {
          started_at: startedAt.toISOString(),
          completed_at: completedAt.toISOString(),
          duration_ms: 90_000,
        },
      }),
    }), []);
  });

  it('preserves a turn start across an earlier mismatched terminal event', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'codex-watcher-'));
    tempDirectories.push(directory);
    const path = join(directory, 'out-of-order-timing.jsonl');
    const turnBCompletedAt = new Date();
    const mismatchedCompletedAt = new Date(turnBCompletedAt.getTime() - 60_000);
    const turnBStartedAt = new Date(turnBCompletedAt.getTime() - 120_000);
    writeFileSync(path, `${JSON.stringify({ type: 'session_meta', payload: { id: 'out-of-order-session' } })}\n`);
    appendFileSync(path, `${terminalLine({ type: 'task_started', turn_id: 'turn-b' }, turnBStartedAt.toISOString())}\n`);
    appendFileSync(path, `${terminalLine({ type: 'task_complete', turn_id: 'turn-a' }, mismatchedCompletedAt.toISOString())}\n`);
    appendFileSync(path, `${terminalLine({ type: 'task_complete', turn_id: 'turn-b' }, turnBCompletedAt.toISOString())}\n`);
    const { service, insertEvent } = serviceFor(directory);

    await service.syncFile(path);

    expect(insertEvent).toHaveBeenCalledTimes(2);
    expect(insertEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      source_event_id: 'out-of-order-session:turn-b:completed',
      metadata: expect.objectContaining({
        timing: {
          started_at: turnBStartedAt.toISOString(),
          completed_at: turnBCompletedAt.toISOString(),
          duration_ms: 120_000,
        },
      }),
    }), []);
  });

  it('passes the last agent message to enrichment without storing it in the event', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'codex-watcher-'));
    tempDirectories.push(directory);
    const path = join(directory, 'answer.jsonl');
    writeFileSync(path, `${JSON.stringify({ type: 'session_meta', payload: { id: 'answer-session' } })}\n`);
    appendFileSync(path, `${terminalLine({ type: 'user_message', message: 'summarize this' })}\n`);
    appendFileSync(path, `${terminalLine({ type: 'agent_message', message: 'private final answer' })}\n`);
    appendFileSync(path, `${terminalLine({ type: 'task_complete', turn_id: 'answer-turn' })}\n`);
    const insertEvent = vi.fn();
    const ingest = vi.fn();
    const service = new CodexSessionWatcherService(
      { codexSessionsPath: directory, codexBackfillMinutes: 120 } as AppConfigService,
      { deliveryChannels: vi.fn(() => []) } as unknown as ChannelsService,
      { ingest } as unknown as EventIngestionService,
    );

    await service.syncFile(path);

    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.not.objectContaining({ answer_source: expect.anything() }),
    }), [], 'private final answer');
  });

  it('waits for a complete trailing JSON line before advancing the offset', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'codex-watcher-'));
    tempDirectories.push(directory);
    const path = join(directory, 'partial.jsonl');
    writeFileSync(path, `${JSON.stringify({ type: 'session_meta', payload: { id: 'partial-session' } })}\n`);
    const line = terminalLine({ type: 'task_complete', turn_id: 'partial-turn' });
    appendFileSync(path, line.slice(0, -5));
    const { service, insertEvent } = serviceFor(directory);

    await service.syncFile(path);
    expect(insertEvent).not.toHaveBeenCalled();
    appendFileSync(path, `${line.slice(-5)}\n`);
    await service.syncFile(path);

    expect(insertEvent).toHaveBeenCalledOnce();
    expect(insertEvent).toHaveBeenCalledWith(expect.objectContaining({
      source_event_id: 'partial-session:partial-turn:completed',
    }), []);
  });

  it('watches nested JSONL files with chokidar 4 directory semantics', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'codex-watcher-'));
    tempDirectories.push(directory);
    const nested = join(directory, '2026', '08', '13');
    mkdirSync(nested, { recursive: true });
    const { service, insertEvent } = serviceFor(directory);
    service.onModuleInit();
    const path = join(nested, 'session.jsonl');
    writeFileSync(path, `${JSON.stringify({ type: 'session_meta', payload: { id: 'watched-session' } })}\n`);
    appendFileSync(path, `${terminalLine({ type: 'task_complete', turn_id: 'watched-turn' })}\n`);

    await vi.waitFor(() => expect(insertEvent).toHaveBeenCalled(), { timeout: 3000 });
    await service.onModuleDestroy();

    expect(insertEvent).toHaveBeenCalledWith(expect.objectContaining({
      source_event_id: 'watched-session:watched-turn:completed',
    }), []);
  });

  it('suppresses a provisional failure when a follow-up user turn starts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'codex-watcher-'));
    tempDirectories.push(directory);
    const path = join(directory, 'follow-up.jsonl');
    writeFileSync(path, `${JSON.stringify({ type: 'session_meta', payload: { id: 'follow-up-session' } })}\n`);
    appendFileSync(path, `${terminalLine({ type: 'task_started', turn_id: 'turn-2' })}\n`);
    appendFileSync(path, `${terminalLine({ type: 'user_message', message: '继续处理' })}\n`);
    const { service, suppressProvisionalFailures } = serviceFor(directory);

    await service.syncFile(path, true);

    expect(suppressProvisionalFailures).toHaveBeenCalledWith('codex-desktop', 'follow-up-session');
  });

  it('suppresses a recoverable failure followed by a retry in the same file update', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'codex-watcher-'));
    tempDirectories.push(directory);
    const path = join(directory, 'retry-after-failure.jsonl');
    writeFileSync(path, `${JSON.stringify({ type: 'session_meta', payload: { id: 'retry-session' } })}\n`);
    appendFileSync(path, `${terminalLine({
      type: 'task_complete',
      turn_id: 'failed-turn',
      error: { message: 'stream disconnected before completion' },
    })}\n`);
    appendFileSync(path, `${terminalLine({ type: 'task_started', turn_id: 'retry-turn' })}\n`);
    const { service, insertEvent, suppressProvisionalFailures } = serviceFor(directory);

    await service.syncFile(path, true);

    expect(insertEvent).toHaveBeenCalledWith(expect.objectContaining({
      source_event_id: 'retry-session:failed-turn:failed',
      metadata: expect.objectContaining({ failure_message: 'stream disconnected before completion' }),
    }), []);
    expect(suppressProvisionalFailures).toHaveBeenCalledWith('codex-desktop', 'retry-session');
    expect(insertEvent.mock.invocationCallOrder[0]).toBeLessThan(suppressProvisionalFailures.mock.invocationCallOrder[0]!);
  });

  it('backfills events without creating notification deliveries', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'codex-watcher-'));
    tempDirectories.push(directory);
    const path = join(directory, 'backfill.jsonl');
    writeFileSync(path, `${JSON.stringify({ type: 'session_meta', payload: { id: 'backfill-session' } })}\n`);
    appendFileSync(path, `${terminalLine({ type: 'task_complete', turn_id: 'backfill-turn' })}\n`);
    const insertEvent = vi.fn();
    const config = { codexSessionsPath: directory, codexBackfillMinutes: 120 } as AppConfigService;
    const deliveryChannels = vi.fn(() => ['openclaw-qq']);
    const channels = { deliveryChannels } as unknown as ChannelsService;
    const service = new CodexSessionWatcherService(
      config, channels, { ingest: insertEvent } as unknown as EventIngestionService,
    );

    await service.syncFile(path, false);

    expect(deliveryChannels).not.toHaveBeenCalled();
    expect(insertEvent).toHaveBeenCalledWith(expect.objectContaining({
      source_event_id: 'backfill-session:backfill-turn:completed',
    }), []);
  });

  it('creates deliveries for terminal events found during startup recovery', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'codex-watcher-'));
    tempDirectories.push(directory);
    const path = join(directory, 'startup-recovery.jsonl');
    writeFileSync(path, `${JSON.stringify({ type: 'session_meta', payload: { id: 'startup-recovery-session' } })}\n`);
    appendFileSync(path, `${terminalLine({ type: 'task_complete', turn_id: 'startup-recovery-turn' })}\n`);
    const insertEvent = vi.fn();
    const config = { codexSessionsPath: directory, codexBackfillMinutes: 120 } as AppConfigService;
    const deliveryChannels = vi.fn(() => ['openclaw-qq']);
    const channels = { deliveryChannels } as unknown as ChannelsService;
    const service = new CodexSessionWatcherService(
      config, channels, { ingest: insertEvent } as unknown as EventIngestionService,
    );

    service.onModuleInit();
    await vi.waitFor(() => expect(insertEvent).toHaveBeenCalledWith(expect.objectContaining({
      source_event_id: 'startup-recovery-session:startup-recovery-turn:completed',
    }), ['openclaw-qq']), { timeout: 3_000 });
    await service.onModuleDestroy();
  });

  it('notifies for bytes appended after the initial scan snapshot', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'codex-watcher-'));
    tempDirectories.push(directory);
    const path = join(directory, 'startup-race.jsonl');
    writeFileSync(path, `${JSON.stringify({ type: 'session_meta', payload: { id: 'race-session' } })}\n`);
    const backfillEnd = Buffer.byteLength(readFileSync(path));
    appendFileSync(path, `${terminalLine({ type: 'task_complete', turn_id: 'live-turn' })}\n`);
    const insertEvent = vi.fn();
    const config = { codexSessionsPath: directory, codexBackfillMinutes: 120 } as AppConfigService;
    const deliveryChannels = vi.fn(() => ['openclaw-qq']);
    const channels = { deliveryChannels } as unknown as ChannelsService;
    const service = new CodexSessionWatcherService(
      config, channels, { ingest: insertEvent } as unknown as EventIngestionService,
    );

    await service.syncFile(path, false, backfillEnd);
    await service.syncFile(path, true);

    expect(insertEvent).toHaveBeenCalledWith(expect.objectContaining({
      source_event_id: 'race-session:live-turn:completed',
    }), ['openclaw-qq']);
  });

  it('notifies when a terminal event is appended before the initial add event settles', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'codex-watcher-'));
    tempDirectories.push(directory);
    const path = join(directory, 'startup-add-race.jsonl');
    writeFileSync(path, `${JSON.stringify({ type: 'session_meta', payload: { id: 'startup-session' } })}\n`);
    const insertEvent = vi.fn();
    const config = { codexSessionsPath: directory, codexBackfillMinutes: 120 } as AppConfigService;
    const channels = { deliveryChannels: vi.fn(() => ['openclaw-qq', 'openclaw-weixin']) } as unknown as ChannelsService;
    const service = new CodexSessionWatcherService(
      config, channels, { ingest: insertEvent } as unknown as EventIngestionService,
    );

    service.onModuleInit();
    appendFileSync(path, `${terminalLine({ type: 'task_complete', turn_id: 'startup-live-turn' })}\n`);

    await vi.waitFor(() => expect(insertEvent).toHaveBeenCalledWith(expect.objectContaining({
      source_event_id: 'startup-session:startup-live-turn:completed',
    }), ['openclaw-qq', 'openclaw-weixin']), { timeout: 3000 });
    await service.onModuleDestroy();
  });

  it('discovers appended terminal events when the filesystem change event is missed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'codex-watcher-'));
    tempDirectories.push(directory);
    const path = join(directory, 'missed-change.jsonl');
    writeFileSync(path, `${JSON.stringify({ type: 'session_meta', payload: { id: 'short-session' } })}\n`);
    appendFileSync(path, `${terminalLine({ type: 'user_message', message: '你好' })}\n`);
    const { service, insertEvent } = serviceFor(directory);
    const internals = service as unknown as { discoverFiles(): void; queue: Promise<void> };

    await service.syncFile(path);
    appendFileSync(path, `${terminalLine({ type: 'task_complete', turn_id: 'short-turn' })}\n`);
    internals.discoverFiles();
    await internals.queue;
    internals.discoverFiles();
    await internals.queue;

    expect(insertEvent).toHaveBeenCalledOnce();
    expect(insertEvent).toHaveBeenCalledWith(expect.objectContaining({
      source_event_id: 'short-session:short-turn:completed',
      message: '提问：你好',
    }), []);
  });

  it('retries a discovered session file after a transient read failure', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'codex-watcher-'));
    tempDirectories.push(directory);
    const path = join(directory, 'retry-discovery.jsonl');
    writeFileSync(path, `${JSON.stringify({ type: 'session_meta', payload: { id: 'retry-discovery-session' } })}\n`);
    appendFileSync(path, `${terminalLine({ type: 'task_complete', turn_id: 'retry-discovery-turn' })}\n`);
    const { service, insertEvent } = serviceFor(directory);
    const internals = service as unknown as {
      discoverFiles(): void;
      queue: Promise<void>;
      readBytes(path: string, start: number, end: number): Promise<Buffer>;
    };
    let rejectFirstRead: (error: Error) => void = () => undefined;
    const firstRead = new Promise<Buffer>((_resolve, reject) => {
      rejectFirstRead = reject;
    });
    const readBytes = vi.spyOn(internals, 'readBytes').mockImplementationOnce(() => firstRead);

    internals.discoverFiles();
    await vi.waitFor(() => expect(readBytes).toHaveBeenCalledOnce());
    internals.discoverFiles();
    expect(readBytes).toHaveBeenCalledOnce();
    rejectFirstRead(new Error('temporarily locked'));
    await internals.queue;
    expect(insertEvent).not.toHaveBeenCalled();
    internals.discoverFiles();
    await internals.queue;

    expect(readBytes).toHaveBeenCalledTimes(2);
    expect(insertEvent).toHaveBeenCalledOnce();
    expect(insertEvent).toHaveBeenCalledWith(expect.objectContaining({
      source_event_id: 'retry-discovery-session:retry-discovery-turn:completed',
    }), []);
  });
});
