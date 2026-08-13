import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../src/config/app-config.service';
import type { ChannelsService } from '../src/channels/channels.service';
import type { DatabaseService } from '../src/database/database.service';
import { CodexSessionWatcherService, parseCodexSessionLine } from '../src/events/codex-session-watcher.service';

const tempDirectories: string[] = [];

const terminalLine = (payload: Record<string, unknown>, timestamp = new Date().toISOString()): string =>
  JSON.stringify({ timestamp, type: 'event_msg', payload });

const serviceFor = (directory: string) => {
  const insertEvent = vi.fn();
  const config = { codexSessionsPath: directory, codexBackfillMinutes: 120 } as AppConfigService;
  const database = { insertEvent } as unknown as DatabaseService;
  const channels = { channelsForClient: vi.fn(() => []) } as unknown as ChannelsService;
  return { service: new CodexSessionWatcherService(config, database, channels), insertEvent };
};

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Codex session watcher parser', () => {
  it('maps task_complete without retaining conversation content', () => {
    const meta = parseCodexSessionLine(JSON.stringify({
      type: 'session_meta', payload: { session_id: 'session-1', base_instructions: 'private' },
    }));
    const result = parseCodexSessionLine(terminalLine({
      type: 'task_complete', turn_id: 'turn-1', last_agent_message: 'private response',
    }), meta.sessionId);

    expect(result.event).toMatchObject({
      source_event_id: 'session-1:turn-1:completed', status: 'completed', kind: 'task_complete',
      metadata: { thread_id: 'session-1', turn_id: 'turn-1' },
    });
    expect(JSON.stringify(result.event)).not.toContain('private');
  });

  it('maps task_complete errors without retaining the error message', () => {
    const result = parseCodexSessionLine(terminalLine({
      type: 'task_complete', turn_id: 'turn-failed',
      error: { message: 'private failure details', codex_error_info: 'server_overloaded' },
    }), 'session-failed');

    expect(result.event).toMatchObject({
      source_event_id: 'session-failed:turn-failed:failed',
      status: 'failed',
      error_code: 'server_overloaded',
    });
    expect(JSON.stringify(result.event)).not.toContain('private failure details');
  });

  it('maps turn_aborted to interrupted', () => {
    const result = parseCodexSessionLine(terminalLine({
      type: 'turn_aborted', turn_id: 'turn-2', reason: 'private reason',
    }), 'session-2');
    expect(result.event).toMatchObject({
      source_event_id: 'session-2:turn-2:interrupted', status: 'interrupted', kind: 'turn_aborted',
    });
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
    const database = { insertEvent } as unknown as DatabaseService;
    const channelsForClient = vi.fn(() => ['openclaw-qq']);
    const channels = { channelsForClient } as unknown as ChannelsService;
    const service = new CodexSessionWatcherService(config, database, channels);

    await service.syncFile(path, false);

    expect(channelsForClient).not.toHaveBeenCalled();
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
    const database = { insertEvent } as unknown as DatabaseService;
    const channelsForClient = vi.fn(() => ['openclaw-qq']);
    const channels = { channelsForClient } as unknown as ChannelsService;
    const service = new CodexSessionWatcherService(config, database, channels);

    await service.syncFile(path, false, backfillEnd);
    await service.syncFile(path, true);

    expect(insertEvent).toHaveBeenCalledWith(expect.objectContaining({
      source_event_id: 'race-session:live-turn:completed',
    }), ['openclaw-qq']);
  });
});
