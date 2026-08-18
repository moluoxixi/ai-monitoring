import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Database from 'better-sqlite3';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppConfigService } from '../config/app-config.service';
import { ExtensionsService } from '../extensions/extensions.service';
import type {
  DeliveryRow,
  EventRow,
  InboundReplyRow,
  InboundReplyState,
  NormalizedEvent,
  ReplyRoute,
} from './database.types';
import { MAX_ANSWER_TEXT_LENGTH, truncateTail } from '../utils/event-text';

export const utcNow = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');

const parseMetadata = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
};

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly db: Database.Database;

  constructor(
    config: AppConfigService,
    private readonly extensions: ExtensionsService,
  ) {
    mkdirSync(dirname(config.dbPath), { recursive: true });
    this.db = new Database(config.dbPath, { timeout: 30_000 });
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.function('ai_client_key', (value: unknown) => this.extensions.resolve(typeof value === 'string' ? value : null));
    this.initialize();
  }

  onModuleDestroy(): void {
    this.db.close();
  }

  insertEvent(event: NormalizedEvent, channels: string[], deliveryDelayMs = 0): [number, boolean, number] {
    return this.db.transaction((): [number, boolean, number] => {
      const existing = this.db.prepare('SELECT id, message, metadata_json, answer_text FROM events WHERE source_event_id = ?').get(event.source_event_id) as { id: number; message: string; metadata_json: string; answer_text: string | null } | undefined;
      if (existing) {
        const currentMetadata = parseMetadata(existing.metadata_json);
        const additions = ['task_summary', 'failure_message'].reduce<Record<string, string>>((result, key) => {
          const value = event.metadata[key];
          if (typeof value === 'string' && value && typeof currentMetadata[key] !== 'string') result[key] = value;
          return result;
        }, {});
        const answerText = event.status === 'completed' && typeof event.metadata.answer_text === 'string'
          ? truncateTail(event.metadata.answer_text, MAX_ANSWER_TEXT_LENGTH)
          : '';
        const shouldAddAnswer = Boolean(answerText) && !existing.answer_text;
        if (Object.keys(additions).length || shouldAddAnswer) {
          const message = additions.task_summary ? event.message : undefined;
          this.db.prepare(`
            UPDATE events
            SET message = ?, metadata_json = ?,
                answer_text = CASE WHEN answer_text IS NULL OR answer_text = '' THEN ? ELSE answer_text END
            WHERE id = ?
          `).run(
            message ?? existing.message,
            JSON.stringify({ ...currentMetadata, ...additions }),
            shouldAddAnswer ? answerText : null,
            existing.id,
          );
        }
        const delivery = this.db.prepare(
          'INSERT OR IGNORE INTO deliveries (event_id, channel, next_attempt_at) VALUES (?, ?, ?)',
        );
        const deliveryAt = new Date(Date.now() + Math.max(0, deliveryDelayMs)).toISOString().replace(/\.\d{3}Z$/, '+00:00');
        let deliveriesAdded = 0;
        for (const channel of channels) deliveriesAdded += delivery.run(existing.id, channel, deliveryAt).changes;
        return [existing.id, false, deliveriesAdded];
      }

      const createdAt = utcNow();
      const result = this.db.prepare(`
        INSERT INTO events
          (source_event_id, source, client, kind, status, title, message, error_code, metadata_json, answer_text, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.source_event_id,
        event.source,
        event.client,
        event.kind,
        event.status,
        event.title,
        event.message,
        event.error_code,
        JSON.stringify(Object.fromEntries(Object.entries(event.metadata).filter(([key]) => !['answer_source', 'answer_text'].includes(key)))),
        event.status === 'completed' && typeof event.metadata.answer_text === 'string'
          ? truncateTail(event.metadata.answer_text, MAX_ANSWER_TEXT_LENGTH)
          : null,
        createdAt,
      );
      const eventId = Number(result.lastInsertRowid);
      const delivery = this.db.prepare(
        'INSERT OR IGNORE INTO deliveries (event_id, channel, next_attempt_at) VALUES (?, ?, ?)',
      );
      const deliveryAt = new Date(Date.now() + Math.max(0, deliveryDelayMs)).toISOString().replace(/\.\d{3}Z$/, '+00:00');
      let deliveriesAdded = 0;
      for (const channel of channels) deliveriesAdded += delivery.run(eventId, channel, deliveryAt).changes;
      return [eventId, true, deliveriesAdded];
    })();
  }

  hasDeliveriesForEvent(eventId: number): boolean {
    const row = this.db.prepare('SELECT 1 AS found FROM deliveries WHERE event_id = ? LIMIT 1').get(eventId) as
      { found: number } | undefined;
    return row?.found === 1;
  }

  releaseDeliveries(eventId: number): void {
    this.db.prepare(`
      UPDATE deliveries SET next_attempt_at = ? WHERE event_id = ? AND state = 'pending'
    `).run(utcNow(), eventId);
  }

  listEvents(limit = 100, client?: string): EventRow[] {
    const safeLimit = this.limit(limit);
    let rows: Record<string, unknown>[];
    if (client) {
      const resolved = this.extensions.resolve(client);
      const predicate = resolved === 'other' ? 'lower(client) = lower(?)' : 'ai_client_key(client) = ?';
      rows = this.db.prepare(`SELECT * FROM events WHERE ${predicate} ORDER BY id DESC LIMIT ?`)
        .all(resolved === 'other' ? client : resolved, safeLimit) as Record<string, unknown>[];
    } else {
      rows = this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(safeLimit) as Record<string, unknown>[];
    }
    return rows.map((row) => this.eventRow(row));
  }

  getEvent(id: number, includeAnswerText = false): EventRow | null {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.eventRow(row, includeAnswerText) : null;
  }

  getEventBySourceEventId(sourceEventId: string): EventRow | null {
    const row = this.db.prepare('SELECT * FROM events WHERE source_event_id = ?').get(sourceEventId) as Record<string, unknown> | undefined;
    return row ? this.eventRow(row) : null;
  }

  /**
   * Cancel notification attempts for a recoverable failure when the same
   * client/session starts a follow-up turn. The event remains in history for
   * diagnostics, but it can no longer produce a stale failure notification.
   */
  suppressProvisionalFailures(client: string, sessionId: string): number {
    const normalizedSessionId = sessionId.trim();
    if (!normalizedSessionId) return 0;
    return this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT e.id, e.metadata_json
        FROM events e
        WHERE e.client = ?
          AND e.status = 'failed'
          AND json_extract(e.metadata_json, '$.notification_state') = 'provisional'
          AND (
            json_extract(e.metadata_json, '$.session_id') = ?
            OR json_extract(e.metadata_json, '$.thread_id') = ?
          )
      `).all(client, normalizedSessionId, normalizedSessionId) as Array<{ id: number; metadata_json: string }>;
      if (!rows.length) return 0;
      const markDeliveries = this.db.prepare(`
        UPDATE deliveries
        SET state = 'dead', last_error = ?, lease_token = NULL, lease_expires_at = NULL
        WHERE event_id = ? AND state IN ('pending', 'retrying', 'claimed')
      `);
      const markEvent = this.db.prepare('UPDATE events SET metadata_json = ? WHERE id = ?');
      let changed = 0;
      for (const row of rows) {
        const current = parseMetadata(row.metadata_json);
        markDeliveries.run('superseded by a follow-up turn', row.id);
        markEvent.run(JSON.stringify({ ...current, notification_state: 'suppressed' }), row.id);
        changed += 1;
      }
      return changed;
    })();
  }

  /**
   * Re-check a delivery immediately before an external send. A follow-up turn
   * can suppress a claimed delivery after the worker has loaded its row; the
   * lease token makes that state transition observable without allowing a
   * stale worker to mark the row sent afterwards.
   */
  isClaimedDeliveryActive(id: number, leaseToken: string): boolean {
    const row = this.db.prepare(`
      SELECT 1 AS active
      FROM deliveries
      WHERE id = ? AND state = 'claimed' AND lease_token = ?
    `).get(id, leaseToken) as { active: number } | undefined;
    return row?.active === 1;
  }

  countEvents(client: string): number {
    const resolved = this.extensions.resolve(client);
    const predicate = resolved === 'other' ? 'lower(client) = lower(?)' : 'ai_client_key(client) = ?';
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM events WHERE ${predicate}`)
      .get(resolved === 'other' ? client : resolved) as { count: number };
    return row.count;
  }

  listDeliveries(limit = 100, client?: string): DeliveryRow[] {
    const safeLimit = this.limit(limit);
    let query = `
      SELECT d.*, e.source, e.client, e.kind, e.status, e.title, e.message, e.error_code, e.metadata_json
      FROM deliveries d JOIN events e ON e.id = d.event_id`;
    const params: Array<string | number> = [];
    if (client) {
      const resolved = this.extensions.resolve(client);
      query += resolved === 'other' ? ' WHERE lower(e.client) = lower(?)' : ' WHERE ai_client_key(e.client) = ?';
      params.push(resolved === 'other' ? client : resolved);
    }
    query += ' ORDER BY d.id DESC LIMIT ?';
    params.push(safeLimit);
    const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.deliveryRow(row));
  }

  getDeliveriesForEvent(eventId: number): DeliveryRow[] {
    const rows = this.db.prepare(`
      SELECT d.*, e.source, e.client, e.kind, e.status, e.title, e.message, e.error_code, e.metadata_json
      FROM deliveries d JOIN events e ON e.id = d.event_id
      WHERE d.event_id = ?
      ORDER BY d.id
    `).all(eventId) as Record<string, unknown>[];
    return rows.map((row) => this.deliveryRow(row));
  }

  stats(): Record<string, number> {
    const result: Record<string, number> = {
      events: 0,
      completed: 0,
      failed: 0,
      interrupted: 0,
      tool_failed: 0,
      unknown: 0,
      pending: 0,
      claimed: 0,
      retrying: 0,
      sent: 0,
      dead: 0,
    };
    const eventRows = this.db.prepare('SELECT status, COUNT(*) AS count FROM events GROUP BY status').all() as Array<{ status: string; count: number }>;
    for (const row of eventRows) {
      result[row.status] = row.count;
      result.events = (result.events ?? 0) + row.count;
    }
    const deliveryRows = this.db.prepare('SELECT state, COUNT(*) AS count FROM deliveries GROUP BY state').all() as Array<{ state: string; count: number }>;
    for (const row of deliveryRows) result[row.state] = row.count;
    return result;
  }

  claimDueDeliveries(now: string, limit = 20, leaseMs = 60_000): DeliveryRow[] {
    return this.db.transaction(() => {
      const safeLimit = this.limit(limit);
      const token = randomUUID();
      const leaseExpiresAt = new Date(Date.parse(now) + Math.max(1_000, leaseMs))
        .toISOString().replace(/\.\d{3}Z$/, '+00:00');
      this.db.prepare(`
        UPDATE deliveries
        SET state = 'claimed', lease_token = ?, lease_expires_at = ?
        WHERE id IN (
          SELECT id FROM deliveries
          WHERE ((state IN ('pending', 'retrying') AND next_attempt_at <= ?)
             OR (state = 'claimed' AND lease_expires_at <= ?))
          ORDER BY id LIMIT ?
        )
        AND ((state IN ('pending', 'retrying') AND next_attempt_at <= ?)
          OR (state = 'claimed' AND lease_expires_at <= ?))
      `).run(token, leaseExpiresAt, now, now, safeLimit, now, now);
      const rows = this.db.prepare(`
        SELECT d.*, e.source, e.client, e.kind, e.status, e.title, e.message, e.error_code,
               e.metadata_json, e.answer_text, e.created_at AS event_created_at
        FROM deliveries d JOIN events e ON e.id = d.event_id
        WHERE d.state = 'claimed' AND d.lease_token = ?
        ORDER BY d.id
      `).all(token) as Record<string, unknown>[];
      return rows.map((row) => this.deliveryRow(row, true));
    })();
  }

  renewClaimedDelivery(id: number, leaseToken: string, now: string, leaseMs = 60_000): boolean {
    const leaseExpiresAt = new Date(Date.parse(now) + Math.max(1_000, leaseMs))
      .toISOString().replace(/\.\d{3}Z$/, '+00:00');
    const result = this.db.prepare(`
      UPDATE deliveries SET lease_expires_at = ?
      WHERE id = ? AND state = 'claimed' AND lease_token = ?
    `).run(leaseExpiresAt, id, leaseToken);
    return result.changes > 0;
  }

  markClaimedDelivery(
    id: number,
    leaseToken: string,
    update: { state: string; attempts: number; nextAttemptAt: string; lastError?: string | null; sentAt?: string | null },
  ): boolean {
    const result = this.db.prepare(`
      UPDATE deliveries
      SET state = ?, attempts = ?, next_attempt_at = ?, last_error = ?, sent_at = ?,
          lease_token = NULL, lease_expires_at = NULL
      WHERE id = ? AND state = 'claimed' AND lease_token = ?
    `).run(
      update.state,
      update.attempts,
      update.nextAttemptAt,
      update.lastError ?? null,
      update.sentAt ?? null,
      id,
      leaseToken,
    );
    return result.changes > 0;
  }

  retryDelivery(id: number): boolean {
    const result = this.db.prepare(`
      UPDATE deliveries SET state = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL, sent_at = NULL,
        lease_token = NULL, lease_expires_at = NULL
      WHERE id = ? AND state != 'claimed'
    `).run(utcNow(), id);
    return result.changes > 0;
  }

  ensureDeliveryReplyRoute(deliveryId: number, ttlMs: number): string | null {
    return this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT d.channel, d.reply_token, e.client, e.status, e.metadata_json
        FROM deliveries d JOIN events e ON e.id = d.event_id
        WHERE d.id = ?
      `).get(deliveryId) as {
        channel: string;
        reply_token: string | null;
        client: string;
        status: string;
        metadata_json: string;
      } | undefined;
      if (!row || row.channel !== 'openclaw-qq' || row.client !== 'codex-cli' || row.status !== 'completed') return null;
      const threadId = parseMetadata(row.metadata_json).thread_id;
      if (typeof threadId !== 'string' || !threadId.trim()) return null;
      if (row.reply_token) return row.reply_token;

      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(Date.now() + Math.max(60_000, ttlMs))
        .toISOString().replace(/\.\d{3}Z$/, '+00:00');
      const result = this.db.prepare(`
        UPDATE deliveries SET reply_token = ?, reply_expires_at = ?
        WHERE id = ? AND reply_token IS NULL
      `).run(token, expiresAt, deliveryId);
      if (result.changes > 0) return token;
      const existing = this.db.prepare('SELECT reply_token FROM deliveries WHERE id = ?').get(deliveryId) as
        { reply_token: string | null } | undefined;
      return existing?.reply_token || null;
    })();
  }

  resolveReplyRoute(token: string): ReplyRoute | null {
    const row = this.db.prepare(`
      SELECT d.id AS delivery_id, d.event_id, d.channel, d.state AS delivery_state,
             d.reply_token, d.reply_expires_at, e.client, e.metadata_json
      FROM deliveries d JOIN events e ON e.id = d.event_id
      WHERE d.reply_token = ?
    `).get(token) as Record<string, unknown> | undefined;
    if (!row) return null;
    const { metadata_json, ...rest } = row;
    return { ...rest, metadata: parseMetadata(metadata_json) } as unknown as ReplyRoute;
  }

  claimInboundReply(input: {
    channel: string;
    externalMessageId: string;
    deliveryId: number;
    senderId: string;
    accountId: string;
    text: string;
  }): { inserted: boolean; reply: InboundReplyRow } {
    return this.db.transaction(() => {
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO inbound_replies
          (channel, external_message_id, delivery_id, sender_id, account_id, text, state, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'processing', ?)
      `).run(
        input.channel,
        input.externalMessageId,
        input.deliveryId,
        input.senderId,
        input.accountId,
        input.text,
        utcNow(),
      );
      const row = this.db.prepare(`
        SELECT * FROM inbound_replies WHERE channel = ? AND external_message_id = ?
      `).get(input.channel, input.externalMessageId) as InboundReplyRow | undefined;
      if (!row) throw new Error('inbound reply idempotency record was not persisted');
      return { inserted: result.changes > 0, reply: row };
    })();
  }

  markInboundReply(id: number, state: Exclude<InboundReplyState, 'processing'>, lastError?: string): void {
    this.db.prepare(`
      UPDATE inbound_replies
      SET state = ?, last_error = ?, accepted_at = CASE WHEN ? = 'accepted' THEN ? ELSE NULL END
      WHERE id = ? AND state = 'processing'
    `).run(state, lastError?.slice(0, 2_000) || null, state, utcNow(), id);
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
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
      CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
      CREATE TABLE IF NOT EXISTS deliveries (
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
        reply_token TEXT,
        reply_expires_at TEXT,
        UNIQUE(event_id, channel)
      );
      CREATE INDEX IF NOT EXISTS idx_deliveries_due ON deliveries(state, next_attempt_at);
      CREATE TABLE IF NOT EXISTS inbound_replies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        external_message_id TEXT NOT NULL,
        delivery_id INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
        sender_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        text TEXT NOT NULL,
        state TEXT NOT NULL,
        last_error TEXT,
        created_at TEXT NOT NULL,
        accepted_at TEXT,
        UNIQUE(channel, external_message_id)
      );
    `);
    const eventColumns = new Set(
      (this.db.pragma('table_info(events)') as Array<{ name: string }>).map((column) => column.name),
    );
    if (!eventColumns.has('answer_text')) this.db.exec('ALTER TABLE events ADD COLUMN answer_text TEXT');
    const deliveryColumns = new Set(
      (this.db.pragma('table_info(deliveries)') as Array<{ name: string }>).map((column) => column.name),
    );
    if (!deliveryColumns.has('lease_token')) this.db.exec('ALTER TABLE deliveries ADD COLUMN lease_token TEXT');
    if (!deliveryColumns.has('lease_expires_at')) this.db.exec('ALTER TABLE deliveries ADD COLUMN lease_expires_at TEXT');
    if (!deliveryColumns.has('reply_token')) this.db.exec('ALTER TABLE deliveries ADD COLUMN reply_token TEXT');
    if (!deliveryColumns.has('reply_expires_at')) this.db.exec('ALTER TABLE deliveries ADD COLUMN reply_expires_at TEXT');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_deliveries_lease ON deliveries(state, lease_expires_at)');
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_reply_token ON deliveries(reply_token) WHERE reply_token IS NOT NULL');
    this.migrateLegacyClients();
  }

  private migrateLegacyClients(): void {
    const update = this.db.prepare('UPDATE events SET client = ? WHERE lower(client) = ?');
    this.db.transaction(() => {
      for (const [legacy, canonical] of this.extensions.legacyMigrations()) update.run(canonical, legacy);
    })();
  }

  private eventRow(row: Record<string, unknown>, includeAnswerText = false): EventRow {
    const { metadata_json, answer_text, ...rest } = row;
    return {
      ...rest,
      client: typeof rest.client === 'string' ? this.extensions.resolve(rest.client) : rest.client,
      ...(includeAnswerText && typeof answer_text === 'string' && answer_text ? { answer_text } : {}),
      metadata: parseMetadata(metadata_json),
    } as unknown as EventRow;
  }

  private deliveryRow(row: Record<string, unknown>, includeAnswerText = false): DeliveryRow {
    const { metadata_json, answer_text, reply_token, reply_expires_at, ...rest } = row;
    return {
      ...rest,
      client: typeof rest.client === 'string' ? this.extensions.resolve(rest.client) : rest.client,
      ...(includeAnswerText && typeof answer_text === 'string' && answer_text ? { answer_text } : {}),
      ...(includeAnswerText ? {
        reply_token: typeof reply_token === 'string' ? reply_token : null,
        reply_expires_at: typeof reply_expires_at === 'string' ? reply_expires_at : null,
      } : {}),
      metadata: parseMetadata(metadata_json),
    } as unknown as DeliveryRow;
  }

  private limit(value: number): number {
    return Math.max(1, Math.min(Number.isFinite(value) ? Math.floor(value) : 100, 500));
  }
}
