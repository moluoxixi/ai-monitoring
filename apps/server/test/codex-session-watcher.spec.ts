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
  sanitizeFailureMessage,
  summarizeTask,
} from '../src/events/codex-session-watcher.service';

const tempDirectories: string[] = [];

const terminalLine = (payload: Record<string, unknown>, timestamp = new Date().toISOString()): string =>
  JSON.stringify({ timestamp, type: 'event_msg', payload });

const serviceFor = (directory: string) => {
  const insertEvent = vi.fn();
  const config = { codexSessionsPath: directory, codexBackfillMinutes: 120 } as AppConfigService;
  const channels = { deliveryChannels: vi.fn(() => []) } as unknown as ChannelsService;
  const ingestion = { ingest: insertEvent } as unknown as EventIngestionService;
  return { service: new CodexSessionWatcherService(config, channels, ingestion), insertEvent };
};

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Codex session watcher parser', () => {
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

  it('normalizes and truncates task summaries', () => {
    expect(summarizeTask(`  ${'a'.repeat(2_010)}  `)).toHaveLength(2_000);
    expect(summarizeTask('The following is the Codex agent history whose request action you are assessing.')).toBe('');
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

  it('limits stored failure details', () => {
    expect(sanitizeFailureMessage('x'.repeat(25_000))).toHaveLength(24_000);
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
    writeFileSync(path, `${JSON.stringify({ type: 'session_meta', payload: { id: 'large-summary-session' } })}\n`);
    appendFileSync(path, `${terminalLine({ type: 'user_message', message: '优化主题并发送消息摘要' })}\n`);
    appendFileSync(path, `${'x'.repeat(1024)}\n`.repeat(1100));
    appendFileSync(path, `${terminalLine({ type: 'task_complete', turn_id: 'large-summary-turn' })}\n`);
    const { service, insertEvent } = serviceFor(directory);

    await service.syncFile(path);

    expect(insertEvent).toHaveBeenCalledWith(expect.objectContaining({
      source_event_id: 'large-summary-session:large-summary-turn:completed',
      message: '提问：优化主题并发送消息摘要',
      metadata: expect.objectContaining({ task_summary: '优化主题并发送消息摘要' }),
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
});
