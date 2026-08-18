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

  it('preserves quiet heartbeat metadata across idempotent watcher replays', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-monitor-db-'));
    directories.push(directory);
    const database = new DatabaseService(
      { dbPath: join(directory, 'monitor.db') } as AppConfigService,
      new ExtensionsService(),
    );
    const quietHeartbeat = {
      ...event({
        task_summary: 'vite-cli',
        automation_id: 'vite-cli',
        automation_decision: 'DONT_NOTIFY',
        notification_state: 'diagnostic',
        terminal: false,
        answer_text: 'Still running.',
      }, 'Still running.'),
      source_event_id: 'session:heartbeat-turn:completed',
      client: 'codex-desktop',
      status: 'completed',
      title: 'vite-cli 状态检查',
      error_code: null,
    };

    expect(database.insertEvent(quietHeartbeat, [])[1]).toBe(true);
    expect(database.insertEvent(quietHeartbeat, [])[1]).toBe(false);
    expect(database.listEvents(10)[0]).toEqual(expect.objectContaining({
      title: 'vite-cli 状态检查',
      message: 'Still running.',
      metadata: expect.objectContaining({
        automation_decision: 'DONT_NOTIFY',
        notification_state: 'diagnostic',
        terminal: false,
      }),
    }));
    expect(database.getDeliveriesForEvent(database.listEvents(10)[0]!.id)).toEqual([]);
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

  it('adds reply routing columns and the inbound idempotency table to an existing outbox', () => {
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
        answer_text TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        channel TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_error TEXT,
        sent_at TEXT,
        lease_token TEXT,
        lease_expires_at TEXT,
        UNIQUE(event_id, channel)
      );
    `);
    legacy.close();

    const database = new DatabaseService({ dbPath } as AppConfigService, new ExtensionsService());
    database.onModuleDestroy();
    const migrated = new Sqlite(dbPath, { readonly: true });
    const deliveryColumns = (migrated.pragma('table_info(deliveries)') as Array<{ name: string }>).map((column) => column.name);
    expect(deliveryColumns).toEqual(expect.arrayContaining(['reply_token', 'reply_expires_at']));
    expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inbound_replies'").get())
      .toEqual({ name: 'inbound_replies' });
    migrated.close();
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

  it('claims due deliveries from different events in the same batch', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-monitor-db-'));
    directories.push(directory);
    const database = new DatabaseService(
      { dbPath: join(directory, 'monitor.db') } as AppConfigService,
      new ExtensionsService(),
    );
    const first = database.insertEvent(event({}, '第一个任务'), ['openclaw-qq'])[0];
    const second = database.insertEvent({
      ...event({}, '第二个任务'),
      source_event_id: 'session:turn:second',
    }, ['openclaw-weixin'])[0];

    const claimed = database.claimDueDeliveries(
      new Date(Date.now() + 1_000).toISOString().replace(/\.\d{3}Z$/, '+00:00'),
      2,
    );

    expect(claimed.map((row) => row.event_id)).toEqual([first, second]);
    expect(claimed.every((row) => typeof row.event_created_at === 'string')).toBe(true);
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

  it('creates one stable reply route for a completed Codex QQ delivery', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-monitor-db-'));
    directories.push(directory);
    const database = new DatabaseService(
      { dbPath: join(directory, 'monitor.db') } as AppConfigService,
      new ExtensionsService(),
    );
    const [eventId] = database.insertEvent({
      ...event({ thread_id: 'thread-123', answer_text: 'done' }, 'finish the task'),
      source_event_id: 'thread-123:turn-1:completed',
      status: 'completed',
      error_code: null,
    }, ['openclaw-qq', 'pushplus']);
    const qq = database.getDeliveriesForEvent(eventId).find((row) => row.channel === 'openclaw-qq')!;
    const pushplus = database.getDeliveriesForEvent(eventId).find((row) => row.channel === 'pushplus')!;

    const first = database.ensureDeliveryReplyRoute(qq.id, 86_400_000);
    const second = database.ensureDeliveryReplyRoute(qq.id, 86_400_000);

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toBe(first);
    expect(database.ensureDeliveryReplyRoute(pushplus.id, 86_400_000)).toBeNull();
    expect(database.listDeliveries(10).some((row) => 'reply_token' in row)).toBe(false);
    expect(database.resolveReplyRoute(first!)).toMatchObject({
      delivery_id: qq.id,
      event_id: eventId,
      channel: 'openclaw-qq',
      client: 'codex-cli',
      metadata: { thread_id: 'thread-123' },
    });
    database.onModuleDestroy();
  });

  it('deduplicates inbound replies by channel and external message id', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-monitor-db-'));
    directories.push(directory);
    const database = new DatabaseService(
      { dbPath: join(directory, 'monitor.db') } as AppConfigService,
      new ExtensionsService(),
    );
    const [eventId] = database.insertEvent({
      ...event({ thread_id: 'thread-123' }, 'finish the task'),
      source_event_id: 'thread-123:turn-2:completed',
      status: 'completed',
      error_code: null,
    }, ['openclaw-qq']);
    const deliveryId = database.getDeliveriesForEvent(eventId)[0]!.id;
    const input = {
      channel: 'openclaw-qq', externalMessageId: 'qq-message-1', deliveryId,
      senderId: 'user-1', accountId: 'default', text: 'continue',
    };

    const first = database.claimInboundReply(input);
    const duplicate = database.claimInboundReply(input);
    database.markInboundReply(first.reply.id, 'accepted');
    const accepted = database.claimInboundReply(input);

    expect(first.inserted).toBe(true);
    expect(duplicate).toMatchObject({ inserted: false, reply: { id: first.reply.id, state: 'processing' } });
    expect(accepted).toMatchObject({ inserted: false, reply: { id: first.reply.id, state: 'accepted' } });
    database.onModuleDestroy();
  });
});

const utcNowForTest = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
