import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Sqlite from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfigService } from '../src/config/app-config.service';
import { DatabaseService } from '../src/database/database.service';
import { ExtensionsService } from '../src/extensions/extensions.service';
import type { NormalizedEvent } from '../src/database/database.types';

const directories: string[] = [];

const event = (metadata: Record<string, unknown>, message: string): NormalizedEvent => ({
  source_event_id: 'session:turn:failed',
  source: 'codex-session',
  client: 'codex-cli',
  kind: 'task_complete',
  status: 'failed',
  title: 'Codex task failed',
  message,
  error_code: 'other',
  metadata,
});

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('DatabaseService idempotent event enrichment', () => {
  it('adds missing task and failure details without creating a duplicate event', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-monitor-db-'));
    directories.push(directory);
    const database = new DatabaseService(
      { dbPath: join(directory, 'monitor.db') } as AppConfigService,
      new ExtensionsService(),
    );

    expect(database.insertEvent(event({}, 'Codex turn failed'), [])[1]).toBe(true);
    expect(database.insertEvent(event({
      task_summary: '修复登录失败',
      failure_message: 'unexpected status 502 Bad Gateway',
    }, '提问：修复登录失败'), [])[1]).toBe(false);

    expect(database.listEvents(10)).toEqual([
      expect.objectContaining({
        message: '提问：修复登录失败',
        metadata: {
          task_summary: '修复登录失败',
          failure_message: 'unexpected status 502 Bad Gateway',
        },
      }),
    ]);
    database.onModuleDestroy();
  });

  it('returns a cleaned answer only from the explicit detail projection', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-monitor-db-'));
    directories.push(directory);
    const database = new DatabaseService(
      { dbPath: join(directory, 'monitor.db') } as AppConfigService,
      new ExtensionsService(),
    );
    const completed = {
      ...event({ answer_source: 'temporary', answer_text: '完整回答' }, '提问：检查详情'),
      source_event_id: 'session:turn:completed',
      status: 'completed',
      error_code: null,
    };

    const [id] = database.insertEvent(completed, ['pushplus']);

    expect(database.listEvents(10)[0]).not.toHaveProperty('answer_text');
    expect(database.getEvent(id)).not.toHaveProperty('answer_text');
    expect(database.getEvent(id, true)?.answer_text).toBe('完整回答');
    expect(database.getEvent(id, true)?.metadata).not.toHaveProperty('answer_source');
    expect(database.getEvent(id, true)?.metadata).not.toHaveProperty('answer_text');
    expect(JSON.stringify(database.listDeliveries(10))).not.toContain('完整回答');
    database.onModuleDestroy();
  });

  it('adds the answer column to an existing database without rebuilding events', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-monitor-db-'));
    directories.push(directory);
    const dbPath = join(directory, 'monitor.db');
    const legacy = new Sqlite(dbPath);
    legacy.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_event_id TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        client TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        error_code TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
    `);
    legacy.close();

    const database = new DatabaseService({ dbPath } as AppConfigService, new ExtensionsService());
    const completed = {
      ...event({ answer_text: '迁移后的回答' }, '提问：迁移测试'),
      source_event_id: 'legacy:turn:completed',
      status: 'completed',
      error_code: null,
    };
    const [id] = database.insertEvent(completed, []);

    expect(database.getEvent(id, true)?.answer_text).toBe('迁移后的回答');
    database.onModuleDestroy();
  });

  it('migrates legacy client values to canonical runtime keys on startup', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-monitor-db-'));
    directories.push(directory);
    const dbPath = join(directory, 'monitor.db');
    const legacy = new Sqlite(dbPath);
    legacy.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_event_id TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        client TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        error_code TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      INSERT INTO events (source_event_id, source, client, kind, status, title, message, created_at)
      VALUES ('legacy:1', 'codex', 'codex', 'complete', 'completed', 'legacy', 'legacy', '2026-08-14T00:00:00+00:00');
    `);
    legacy.close();

    const database = new DatabaseService({ dbPath } as AppConfigService, new ExtensionsService());
    expect(database.listEvents(10)[0]?.client).toBe('codex-cli');
    database.onModuleDestroy();
    const reopened = new Sqlite(dbPath, { readonly: true });
    expect(reopened.prepare('SELECT client FROM events WHERE source_event_id = ?').get('legacy:1')).toEqual({ client: 'codex-cli' });
    reopened.close();
  });

  it('returns only the deliveries belonging to one event', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-monitor-db-'));
    directories.push(directory);
    const database = new DatabaseService(
      { dbPath: join(directory, 'monitor.db') } as AppConfigService,
      new ExtensionsService(),
    );

    const first = database.insertEvent(event({}, '第一个任务'), ['pushplus'])[0];
    database.insertEvent({ ...event({}, '第二个任务'), source_event_id: 'session:turn:other' }, ['qq']);

    expect(database.getDeliveriesForEvent(first)).toEqual([
      expect.objectContaining({ event_id: first, channel: 'pushplus', state: 'pending' }),
    ]);
    database.onModuleDestroy();
  });

  it('suppresses pending provisional failures for a follow-up session', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-monitor-db-'));
    directories.push(directory);
    const database = new DatabaseService(
      { dbPath: join(directory, 'monitor.db') } as AppConfigService,
      new ExtensionsService(),
    );
    const provisional = database.insertEvent({
      ...event({ session_id: 'session', notification_state: 'provisional', failure_message: 'stream disconnected' }, 'stream disconnected'),
      source_event_id: 'session:turn:provisional',
    }, ['pushplus'], 600_000)[0];

    expect(database.suppressProvisionalFailures('codex-cli', 'session')).toBe(1);
    expect(database.getDeliveriesForEvent(provisional)).toEqual([
      expect.objectContaining({ state: 'dead', last_error: 'superseded by a follow-up turn' }),
    ]);
    expect(database.getEvent(provisional)?.metadata).toMatchObject({ notification_state: 'suppressed' });
    database.onModuleDestroy();
  });

  it('also suppresses a provisional failure already claimed by the worker', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-monitor-db-'));
    directories.push(directory);
    const database = new DatabaseService(
      { dbPath: join(directory, 'monitor.db') } as AppConfigService,
      new ExtensionsService(),
    );
    const provisional = database.insertEvent({
      ...event({ session_id: 'claimed-session', notification_state: 'provisional', failure_message: '502 upstream' }, '502 upstream'),
      source_event_id: 'claimed:turn:provisional',
    }, ['pushplus'])[0];
    const claimed = database.claimDueDeliveries(utcNowForTest(), 20);

    expect(claimed).toHaveLength(1);
    expect(database.suppressProvisionalFailures('codex-cli', 'claimed-session')).toBe(1);
    expect(database.getDeliveriesForEvent(provisional)).toEqual([
      expect.objectContaining({ state: 'dead', lease_token: null, last_error: 'superseded by a follow-up turn' }),
    ]);
    database.onModuleDestroy();
  });

  it('claims a due delivery only once across database connections and fences stale workers', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-monitor-db-'));
    directories.push(directory);
    const config = { dbPath: join(directory, 'monitor.db') } as AppConfigService;
    const first = new DatabaseService(config, new ExtensionsService());
    const second = new DatabaseService(config, new ExtensionsService());
    const [eventId, , deliveriesAdded] = first.insertEvent(event({}, 'Codex turn failed'), ['pushplus']);
    expect(deliveriesAdded).toBe(1);
    const claimTime = new Date(Date.now() + 1_000).toISOString().replace(/\.\d{3}Z$/, '+00:00');

    const firstClaim = first.claimDueDeliveries(claimTime, 20, 1_000);
    const secondClaim = second.claimDueDeliveries(claimTime, 20, 1_000);

    expect(firstClaim).toHaveLength(1);
    expect(firstClaim[0]).toMatchObject({ event_id: eventId, channel: 'pushplus', state: 'claimed' });
    expect(firstClaim[0]?.lease_token).toBeTruthy();
    expect(secondClaim).toEqual([]);
    expect(first.retryDelivery(firstClaim[0]!.id)).toBe(false);

    const reclaimTime = new Date(Date.parse(claimTime) + 2_000).toISOString().replace(/\.\d{3}Z$/, '+00:00');
    const reclaimed = second.claimDueDeliveries(reclaimTime, 20, 1_000);
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.lease_token).not.toBe(firstClaim[0]?.lease_token);
    expect(first.markClaimedDelivery(firstClaim[0]!.id, firstClaim[0]!.lease_token!, {
      state: 'sent', attempts: 1, nextAttemptAt: reclaimTime, sentAt: reclaimTime,
    })).toBe(false);
    expect(second.markClaimedDelivery(reclaimed[0]!.id, reclaimed[0]!.lease_token!, {
      state: 'sent', attempts: 1, nextAttemptAt: reclaimTime, sentAt: reclaimTime,
    })).toBe(true);

    first.onModuleDestroy();
    second.onModuleDestroy();
  });
});

const utcNowForTest = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
