import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import Database from 'better-sqlite3';
import { watch, type FSWatcher } from 'chokidar';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { AppConfigService } from '../config/app-config.service';
import { ChannelsService } from '../channels/channels.service';
import type { NormalizedEvent } from '../database/database.types';
import { sanitizeFailureMessage, summarizeTask } from './codex-session-watcher.service';
import { EventIngestionService } from './event-ingestion.service';
import { truncateTail } from './event-text';

interface HermesAssistantRow {
  id: number;
  session_id: string;
  content: string | null;
  task_summary: string | null;
}

const recordValue = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const textValue = (value: unknown, limit = 24_000): string => {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text ? truncateTail(text, limit) : '';
};

export const hermesDesktopCompletedEvent = (row: HermesAssistantRow): NormalizedEvent | null => {
  const answer = textValue(row.content);
  if (!answer) return null;
  const taskSummary = summarizeTask(textValue(row.task_summary, 2_000));
  return {
    source_event_id: `hermes-desktop:assistant:${row.id}`,
    source: 'hermes-desktop',
    client: 'hermes-desktop',
    kind: 'assistant_completed',
    status: 'completed',
    title: 'Hermes Desktop task completed',
    message: 'Hermes Desktop task completed',
    error_code: null,
    metadata: {
      session_id: row.session_id,
      turn_id: String(row.id),
      ...(taskSummary ? { task_summary: taskSummary } : {}),
      answer_source: answer,
    },
  };
};

export const parseHermesDesktopRequestDump = (
  source: string,
  sourceEventId: string,
  taskSummary = '',
): NormalizedEvent | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return null;
  }
  const item = recordValue(raw);
  const error = recordValue(item.error);
  const sessionId = textValue(item.session_id, 200) || 'unknown-session';
  const statusCode = error.status_code ?? error.response_status;
  const code = textValue(error.code ?? error.type, 200)
    || (statusCode === undefined ? 'hermes_desktop_request_failed' : String(statusCode));
  const failure = sanitizeFailureMessage(
    textValue(error.message) || textValue(item.reason) || 'Hermes Desktop request failed',
    true,
  );
  const summary = summarizeTask(textValue(taskSummary, 2_000));
  return {
    source_event_id: sourceEventId,
    source: 'hermes-desktop',
    client: 'hermes-desktop',
    kind: 'api_request_error',
    status: 'tool_failed',
    title: 'Hermes Desktop task failed',
    message: failure,
    error_code: code,
    metadata: {
      session_id: sessionId,
      ...(summary ? { task_summary: summary } : {}),
      failure_message: failure,
      notification_state: 'diagnostic',
    },
  };
};

@Injectable()
export class HermesDesktopStateWatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HermesDesktopStateWatcherService.name);
  private readonly startupDumps = new Set<string>();
  private database: Database.Database | null = null;
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastTerminalAssistantId = 0;
  private queue = Promise.resolve();

  constructor(
    private readonly config: AppConfigService,
    private readonly channels: ChannelsService,
    private readonly ingestion: EventIngestionService,
  ) {}

  onModuleInit(): void {
    if (existsSync(this.config.hermesStatePath)) {
      try {
        this.database = new Database(this.config.hermesStatePath, { readonly: true, fileMustExist: true });
        const baseline = this.database.prepare(`
          SELECT COALESCE(MAX(m.id), 0) AS id
          FROM messages m
          JOIN sessions s ON s.id = m.session_id
          WHERE s.source = 'tui' AND m.role = 'assistant'
            AND m.active = 1 AND m.finish_reason IS NOT NULL AND m.finish_reason <> 'tool_calls'
        `).get() as { id: number };
        this.lastTerminalAssistantId = baseline.id;
        this.timer = setInterval(() => this.pollCompleted(), 1_000);
        this.timer.unref();
      } catch (error) {
        this.logger.warn(`Unable to open Hermes Desktop state database: ${error instanceof Error ? error.message : String(error)}`);
        this.database?.close();
        this.database = null;
      }
    }
    this.startDumpWatcher();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.watcher?.close();
    await this.queue;
    this.database?.close();
  }

  private pollCompleted(): void {
    if (!this.database) return;
    try {
      const rows = this.database.prepare(`
        SELECT m.id, m.session_id, m.content,
          (SELECT u.content FROM messages u
           WHERE u.session_id = m.session_id AND u.role = 'user' AND u.active = 1 AND u.id < m.id
           ORDER BY u.id DESC LIMIT 1) AS task_summary
        FROM messages m
        JOIN sessions s ON s.id = m.session_id
        WHERE s.source = 'tui' AND m.role = 'assistant' AND m.active = 1
          AND m.finish_reason IS NOT NULL AND m.finish_reason <> 'tool_calls' AND m.id > ?
        ORDER BY m.id
      `).all(this.lastTerminalAssistantId) as HermesAssistantRow[];
      for (const row of rows) {
        this.lastTerminalAssistantId = Math.max(this.lastTerminalAssistantId, row.id);
        const event = hermesDesktopCompletedEvent(row);
        if (event) this.ingestion.ingest(event, this.channels.deliveryChannels(), event.metadata.answer_source);
      }
    } catch (error) {
      this.logger.warn(`Unable to poll Hermes Desktop state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private startDumpWatcher(): void {
    const root = this.config.hermesSessionsPath;
    if (!existsSync(root)) return;
    for (const name of readdirSync(root)) {
      if (this.isRequestDump(name)) this.startupDumps.add(join(root, name));
    }
    this.watcher = watch(root, {
      depth: 0,
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });
    this.watcher.on('add', (path) => {
      if (!this.isRequestDump(path)) return;
      if (this.startupDumps.delete(path)) return;
      this.queue = this.queue.then(() => this.ingestRequestDump(path)).catch((error) => {
        this.logger.warn(`Unable to read Hermes Desktop request dump: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
    this.watcher.on('error', (error) => this.logger.warn(`Hermes Desktop request watcher failed: ${String(error)}`));
  }

  private ingestRequestDump(path: string): void {
    if (!existsSync(path) || statSync(path).size > 4 * 1024 * 1024) return;
    const source = readFileSync(path, 'utf8');
    let sessionId = '';
    try {
      sessionId = textValue(recordValue(JSON.parse(source)).session_id, 200);
    } catch {
      return;
    }
    const taskSummary = sessionId ? this.latestUserMessage(sessionId) : '';
    const event = parseHermesDesktopRequestDump(
      source,
      `hermes-desktop:request-dump:${basename(path, '.json')}`,
      taskSummary,
    );
    if (event) this.ingestion.ingest(event, this.channels.deliveryChannels());
  }

  private latestUserMessage(sessionId: string): string {
    if (!this.database) return '';
    try {
      const row = this.database.prepare(`
        SELECT content FROM messages
        WHERE session_id = ? AND role = 'user' AND active = 1
        ORDER BY id DESC LIMIT 1
      `).get(sessionId) as { content?: string } | undefined;
      return textValue(row?.content, 2_000);
    } catch {
      return '';
    }
  }

  private isRequestDump(path: string): boolean {
    return /^request_dump_.+\.json$/i.test(basename(path));
  }
}
