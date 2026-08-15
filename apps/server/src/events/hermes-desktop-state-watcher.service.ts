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
  finish_reason?: string | null;
}

interface HermesSessionContext {
  session_id: string;
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
  const finishReason = textValue(row.finish_reason, 120).toLowerCase();
  if (finishReason === 'tool_calls') return null;
  const interrupted = /\b(interrupted|interrupt|cancelled|canceled|aborted|abort)\b/.test(finishReason);
  const failed = !interrupted && /\b(error|failed|failure|api_error|authentication_error)\b/.test(finishReason);
  if (!answer && !failed && !interrupted) return null;
  const taskSummary = summarizeTask(textValue(row.task_summary, 2_000));
  const status = failed ? 'failed' : interrupted ? 'interrupted' : 'completed';
  const label = status === 'failed' ? 'failed' : status === 'interrupted' ? 'interrupted' : 'completed';
  return {
    source_event_id: `hermes-desktop:assistant:${row.id}`,
    source: 'hermes-desktop',
    client: 'hermes-desktop',
    kind: `assistant_${status}`,
    status,
    title: `Hermes Desktop task ${label}`,
    message: `Hermes Desktop task ${label}`,
    error_code: failed ? `hermes_desktop_${finishReason || 'task_failed'}` : null,
    metadata: {
      session_id: row.session_id,
      turn_id: String(row.id),
      ...(taskSummary ? { task_summary: taskSummary } : {}),
      ...(status === 'completed' && answer ? { answer_source: answer } : {}),
    },
  };
};

export const parseHermesDesktopLogLine = (
  line: string,
  sourceEventId: string,
  sessionId = '',
  taskSummary = '',
): NormalizedEvent | null => {
  if (!/\]\s*(?:[^\w\s]+\s*)?interrupted during api call\.\s*$/i.test(line)
    || /\[subagent(?:[-\]])/i.test(line)) return null;
  const summary = summarizeTask(textValue(taskSummary, 2_000));
  return {
    source_event_id: sourceEventId,
    source: 'hermes-desktop',
    client: 'hermes-desktop',
    kind: 'assistant_interrupted',
    status: 'interrupted',
    title: 'Hermes Desktop task interrupted',
    message: 'Hermes Desktop task interrupted',
    error_code: null,
    metadata: {
      ...(sessionId ? { session_id: sessionId } : {}),
      ...(summary ? { task_summary: summary } : {}),
      detection_source: 'desktop_log',
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
  private desktopLogOffset = 0;
  private desktopLogBaselineCaptured = false;
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
      } catch (error) {
        this.logger.warn(`Unable to open Hermes Desktop state database: ${error instanceof Error ? error.message : String(error)}`);
        this.database?.close();
        this.database = null;
      }
    }
    this.desktopLogOffset = this.desktopLogSize();
    this.desktopLogBaselineCaptured = existsSync(this.config.hermesDesktopLogPath);
    this.timer = setInterval(() => {
      this.pollCompleted();
      this.pollDesktopLog();
    }, 1_000);
    this.timer.unref();
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
        SELECT m.id, m.session_id, m.content, m.finish_reason,
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

  private pollDesktopLog(): void {
    if (!existsSync(this.config.hermesDesktopLogPath)) return;
    try {
      const bytes = readFileSync(this.config.hermesDesktopLogPath);
      if (bytes.length < this.desktopLogOffset) {
        this.desktopLogOffset = bytes.length;
        return;
      }
      if (!this.desktopLogBaselineCaptured) {
        this.desktopLogOffset = bytes.length;
        this.desktopLogBaselineCaptured = true;
        return;
      }
      if (bytes.length === this.desktopLogOffset) return;
      const chunk = bytes.subarray(this.desktopLogOffset);
      const lastNewline = chunk.lastIndexOf(0x0a);
      if (lastNewline < 0) return;
      const complete = chunk.subarray(0, lastNewline + 1).toString('utf8');
      let relativeOffset = 0;
      for (const rawLine of complete.split('\n')) {
        const lineBytes = Buffer.byteLength(rawLine, 'utf8') + 1;
        if (rawLine.trim()) {
          const context = this.latestTuiSessionContext();
          const event = parseHermesDesktopLogLine(
            rawLine,
            `hermes-desktop:log-interrupted:${this.desktopLogOffset + relativeOffset}`,
            context?.session_id || '',
            context?.task_summary || '',
          );
          if (event) this.ingestion.ingest(event, this.channels.deliveryChannels());
        }
        relativeOffset += lineBytes;
      }
      this.desktopLogOffset += lastNewline + 1;
    } catch (error) {
      this.logger.warn(`Unable to poll Hermes Desktop log: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private desktopLogSize(): number {
    try {
      return statSync(this.config.hermesDesktopLogPath).size;
    } catch {
      return 0;
    }
  }

  private latestTuiSessionContext(): HermesSessionContext | undefined {
    if (!this.database) return undefined;
    try {
      return this.database.prepare(`
        SELECT s.id AS session_id,
          (SELECT u.content FROM messages u
           WHERE u.session_id = s.id AND u.role = 'user' AND u.active = 1
           ORDER BY u.id DESC LIMIT 1) AS task_summary
        FROM sessions s
        WHERE s.source = 'tui'
        ORDER BY s.started_at DESC
        LIMIT 1
      `).get() as HermesSessionContext | undefined;
    } catch {
      return undefined;
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
