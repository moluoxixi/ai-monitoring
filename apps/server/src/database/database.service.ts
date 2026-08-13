import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppConfigService } from '../config/app-config.service';
import { PlatformsService } from '../platforms/platforms.service';
import type { DeliveryRow, EventRow, NormalizedEvent } from './database.types';

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
    private readonly platforms: PlatformsService,
  ) {
    mkdirSync(dirname(config.dbPath), { recursive: true });
    this.db = new Database(config.dbPath, { timeout: 30_000 });
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.function('ai_client_key', (value: unknown) => this.platforms.resolve(typeof value === 'string' ? value : null));
    this.initialize();
  }

  onModuleDestroy(): void {
    this.db.close();
  }

  insertEvent(event: NormalizedEvent, channels: string[]): [number, boolean] {
    return this.db.transaction((): [number, boolean] => {
      const existing = this.db.prepare('SELECT id FROM events WHERE source_event_id = ?').get(event.source_event_id) as { id: number } | undefined;
      if (existing) return [existing.id, false];

      const createdAt = utcNow();
      const result = this.db.prepare(`
        INSERT INTO events
          (source_event_id, source, client, kind, status, title, message, error_code, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.source_event_id,
        event.source,
        event.client,
        event.kind,
        event.status,
        event.title,
        event.message,
        event.error_code,
        JSON.stringify(event.metadata),
        createdAt,
      );
      const eventId = Number(result.lastInsertRowid);
      const delivery = this.db.prepare(
        'INSERT OR IGNORE INTO deliveries (event_id, channel, next_attempt_at) VALUES (?, ?, ?)',
      );
      for (const channel of channels) delivery.run(eventId, channel, createdAt);
      return [eventId, true];
    })();
  }

  listEvents(limit = 100, client?: string): EventRow[] {
    const safeLimit = this.limit(limit);
    let rows: Record<string, unknown>[];
    if (client) {
      const resolved = this.platforms.resolve(client);
      const predicate = resolved === 'other' ? 'lower(client) = lower(?)' : 'ai_client_key(client) = ?';
      rows = this.db.prepare(`SELECT * FROM events WHERE ${predicate} ORDER BY id DESC LIMIT ?`)
        .all(resolved === 'other' ? client : resolved, safeLimit) as Record<string, unknown>[];
    } else {
      rows = this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(safeLimit) as Record<string, unknown>[];
    }
    return rows.map((row) => this.eventRow(row));
  }

  listDeliveries(limit = 100, client?: string): DeliveryRow[] {
    const safeLimit = this.limit(limit);
    let query = `
      SELECT d.*, e.source, e.client, e.kind, e.status, e.title, e.message, e.error_code, e.metadata_json
      FROM deliveries d JOIN events e ON e.id = d.event_id`;
    const params: Array<string | number> = [];
    if (client) {
      const resolved = this.platforms.resolve(client);
      query += resolved === 'other' ? ' WHERE lower(e.client) = lower(?)' : ' WHERE ai_client_key(e.client) = ?';
      params.push(resolved === 'other' ? client : resolved);
    }
    query += ' ORDER BY d.id DESC LIMIT ?';
    params.push(safeLimit);
    const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[];
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

  dueDeliveries(now: string, limit = 20): DeliveryRow[] {
    const rows = this.db.prepare(`
      SELECT d.*, e.source, e.client, e.kind, e.status, e.title, e.message, e.error_code, e.metadata_json
      FROM deliveries d JOIN events e ON e.id = d.event_id
      WHERE d.state IN ('pending', 'retrying') AND d.next_attempt_at <= ?
      ORDER BY d.id LIMIT ?
    `).all(now, this.limit(limit)) as Record<string, unknown>[];
    return rows.map((row) => this.deliveryRow(row));
  }

  markDelivery(
    id: number,
    update: { state: string; attempts: number; nextAttemptAt: string; lastError?: string | null; sentAt?: string | null },
  ): void {
    this.db.prepare(`
      UPDATE deliveries SET state = ?, attempts = ?, next_attempt_at = ?, last_error = ?, sent_at = ? WHERE id = ?
    `).run(update.state, update.attempts, update.nextAttemptAt, update.lastError ?? null, update.sentAt ?? null, id);
  }

  retryDelivery(id: number): boolean {
    const result = this.db.prepare(`
      UPDATE deliveries SET state = 'pending', attempts = 0, next_attempt_at = ?, last_error = NULL, sent_at = NULL
      WHERE id = ?
    `).run(utcNow(), id);
    return result.changes > 0;
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
        UNIQUE(event_id, channel)
      );
      CREATE INDEX IF NOT EXISTS idx_deliveries_due ON deliveries(state, next_attempt_at);
    `);
  }

  private eventRow(row: Record<string, unknown>): EventRow {
    const { metadata_json, ...rest } = row;
    return { ...rest, metadata: parseMetadata(metadata_json) } as unknown as EventRow;
  }

  private deliveryRow(row: Record<string, unknown>): DeliveryRow {
    const { metadata_json, ...rest } = row;
    return { ...rest, metadata: parseMetadata(metadata_json) } as unknown as DeliveryRow;
  }

  private limit(value: number): number {
    return Math.max(1, Math.min(Number.isFinite(value) ? Math.floor(value) : 100, 500));
  }
}
