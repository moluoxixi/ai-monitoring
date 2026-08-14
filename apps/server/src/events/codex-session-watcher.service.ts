import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { watch, type FSWatcher } from 'chokidar';
import { createReadStream, existsSync, readdirSync, statSync, type Stats } from 'node:fs';
import { extname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { AppConfigService } from '../config/app-config.service';
import { ChannelsService } from '../channels/channels.service';
import type { NormalizedEvent } from '../database/database.types';
import { EventIngestionService } from './event-ingestion.service';

const INITIAL_TAIL_BYTES = 1024 * 1024;

interface FileState {
  identity: string;
  offset: number;
  sessionId: string;
  taskSummary: string;
  answerSource: string;
  isSubagent: boolean;
}

interface ParsedTerminalEvent {
  event?: NormalizedEvent;
  answerSource: string;
  sessionId: string;
  taskSummary: string;
  isSubagent: boolean;
  timestampMs: number | null;
}

const recordValue = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const safeErrorCode = (error: Record<string, unknown>): string => {
  const info = error.codex_error_info;
  const candidate = typeof info === 'string' ? info : Object.keys(recordValue(info))[0];
  return candidate && /^[a-z0-9_.:-]{1,100}$/i.test(candidate) ? candidate : 'codex_task_failed';
};

export const sanitizeFailureMessage = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\b(Authorization\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi, '$1<redacted>')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1<redacted>')
    .replace(/\b((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, '$1<redacted>')
    .replace(/([?&](?:api[_-]?key|token|secret|password|access_token)=)[^&#\s]+/gi, '$1<redacted>')
    .replace(/\bC:\\Users\\[^\\\s]+/gi, 'C:\\Users\\<user>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2_000);
};

export const summarizeTask = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/gi, ' ')
    .replace(/##\s*My request:\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^The following is the Codex agent history whose request action you are assessing\./i.test(cleaned)) return '';
  return cleaned.length > 160 ? `${cleaned.slice(0, 157).trimEnd()}...` : cleaned;
};

export const parseCodexSessionLine = (
  line: string,
  currentSessionId = '',
  currentTaskSummary = '',
  currentIsSubagent = false,
  currentAnswerSource = '',
): ParsedTerminalEvent => {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { sessionId: currentSessionId, taskSummary: currentTaskSummary, answerSource: currentAnswerSource, isSubagent: currentIsSubagent, timestampMs: null };
  }
  const item = recordValue(raw);
  const payload = recordValue(item.payload);
  if (item.type === 'session_meta') {
    const sessionId = String(payload.session_id || payload.id || currentSessionId);
    const isSubagent = Boolean(recordValue(payload.source).subagent);
    return { sessionId, taskSummary: currentTaskSummary, answerSource: currentAnswerSource, isSubagent, timestampMs: null };
  }
  if (item.type !== 'event_msg') {
    return { sessionId: currentSessionId, taskSummary: currentTaskSummary, answerSource: currentAnswerSource, isSubagent: currentIsSubagent, timestampMs: null };
  }
  const kind = String(payload.type || '');
  if (kind === 'user_message') {
    return {
      sessionId: currentSessionId,
      taskSummary: summarizeTask(payload.message) || currentTaskSummary,
      answerSource: '',
      isSubagent: currentIsSubagent,
      timestampMs: null,
    };
  }
  if (kind === 'agent_message') {
    const message = typeof payload.message === 'string' ? payload.message.slice(-24_000) : '';
    return {
      sessionId: currentSessionId,
      taskSummary: currentTaskSummary,
      answerSource: message || currentAnswerSource,
      isSubagent: currentIsSubagent,
      timestampMs: null,
    };
  }
  if (!['task_complete', 'turn_aborted'].includes(kind)) {
    return { sessionId: currentSessionId, taskSummary: currentTaskSummary, answerSource: currentAnswerSource, isSubagent: currentIsSubagent, timestampMs: null };
  }
  const turnId = String(payload.turn_id || '');
  if (!currentSessionId || !turnId || currentIsSubagent) {
    return { sessionId: currentSessionId, taskSummary: '', answerSource: '', isSubagent: currentIsSubagent, timestampMs: null };
  }

  const error = recordValue(payload.error);
  const failed = kind === 'task_complete' && Object.keys(error).length > 0;
  const failureMessage = failed ? sanitizeFailureMessage(error.message) : '';
  const status = failed ? 'failed' : kind === 'task_complete' ? 'completed' : 'interrupted';
  const labels = {
    completed: { title: 'Codex task completed', message: 'Codex turn completed' },
    failed: { title: 'Codex task failed', message: 'Codex turn failed' },
    interrupted: { title: 'Codex task interrupted', message: 'Codex turn was interrupted' },
  } as const;
  const timestamp = typeof item.timestamp === 'string' ? Date.parse(item.timestamp) : Number.NaN;
  const terminalTimestamp = Number.isFinite(timestamp) ? timestamp : null;
  return {
    sessionId: currentSessionId,
    taskSummary: '',
    isSubagent: currentIsSubagent,
    timestampMs: terminalTimestamp,
    answerSource: status === 'completed'
      ? (typeof payload.last_agent_message === 'string' ? payload.last_agent_message.slice(-24_000) : currentAnswerSource)
      : '',
    event: {
      source_event_id: `${currentSessionId}:${turnId}:${status}`,
      source: 'codex-session',
      client: 'codex',
      kind,
      status,
      title: labels[status].title,
      message: currentTaskSummary ? `提问：${currentTaskSummary}` : labels[status].message,
      error_code: failed ? safeErrorCode(error) : null,
      metadata: {
        thread_id: currentSessionId,
        turn_id: turnId,
        ...(currentTaskSummary ? { task_summary: currentTaskSummary } : {}),
        ...(failureMessage ? { failure_message: failureMessage } : {}),
      },
    },
  };
};

const fileIdentity = (stats: Stats): string => `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`;

@Injectable()
export class CodexSessionWatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CodexSessionWatcherService.name);
  private readonly files = new Map<string, FileState>();
  private watcher: FSWatcher | null = null;
  private queue = Promise.resolve();

  constructor(
    private readonly config: AppConfigService,
    private readonly channels: ChannelsService,
    private readonly ingestion: EventIngestionService,
  ) {}

  onModuleInit(): void {
    if (!existsSync(this.config.codexSessionsPath)) return;
    const startupFiles = this.captureStartupFiles(this.config.codexSessionsPath);
    this.watcher = watch(this.config.codexSessionsPath, {
      ignoreInitial: false,
      ignored: (path, stats) => Boolean(stats?.isFile()) && extname(path).toLowerCase() !== '.jsonl',
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });
    this.watcher.on('add', (path) => {
      if (extname(path).toLowerCase() !== '.jsonl') return;
      const backfillEnd = startupFiles.get(path);
      startupFiles.delete(path);
      if (backfillEnd === undefined) {
        this.enqueue(path, true);
        return;
      }
      this.enqueue(path, false, backfillEnd);
      this.enqueue(path, true);
    });
    this.watcher.on('change', (path) => {
      if (extname(path).toLowerCase() === '.jsonl') this.enqueue(path, true);
    });
    this.watcher.on('unlink', (path) => this.files.delete(path));
    this.watcher.on('error', (error) => {
      this.logger.error(`Codex session watcher failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.watcher?.close();
    await this.queue;
  }

  async syncFile(path: string, createDeliveries = true, readLimit?: number): Promise<void> {
    const stats = statSync(path);
    const readableSize = Math.min(stats.size, readLimit ?? stats.size);
    const identity = fileIdentity(stats);
    let state = this.files.get(path);
    const initial = !state || state.identity !== identity || readableSize < state.offset;
    if (!state || state.identity !== identity || readableSize < state.offset) {
      const cutoff = Date.now() - this.config.codexBackfillMinutes * 60_000;
      if (stats.mtimeMs < cutoff) {
        this.files.set(path, { identity, offset: readableSize, sessionId: '', taskSummary: '', answerSource: '', isSubagent: false });
        return;
      }
      state = {
        identity,
        offset: Math.max(0, readableSize - INITIAL_TAIL_BYTES),
        sessionId: '',
        taskSummary: '',
        answerSource: '',
        isSubagent: false,
      };
      if (state.offset > 0) {
        const context = await this.readContextBefore(path, state.offset);
        state.sessionId = context.sessionId;
        state.taskSummary = context.taskSummary;
        state.answerSource = context.answerSource;
      }
      this.files.set(path, state);
    }
    if (readableSize === state.offset) return;
    if (!state.sessionId) state.sessionId = await this.readSessionId(path);

    const start = state.offset;
    const bytes = await this.readBytes(path, start, readableSize);
    const lastNewline = bytes.lastIndexOf(0x0a);
    if (lastNewline < 0) return;
    const complete = bytes.subarray(0, lastNewline + 1).toString('utf8');
    const lines = complete.split('\n');
    if (initial && start > 0) lines.shift();
    const cutoff = Date.now() - this.config.codexBackfillMinutes * 60_000;
    for (const rawLine of lines) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line) continue;
      const parsed = parseCodexSessionLine(line, state.sessionId, state.taskSummary, state.isSubagent, state.answerSource);
      state.sessionId = parsed.sessionId;
      state.taskSummary = parsed.taskSummary;
      state.answerSource = parsed.event ? '' : parsed.answerSource;
      state.isSubagent = parsed.isSubagent;
      if (!parsed.event) continue;
      if (initial && parsed.timestampMs !== null && parsed.timestampMs < cutoff) continue;
      const channels = createDeliveries ? this.channels.deliveryChannels() : [];
      if (parsed.answerSource) this.ingestion.ingest(parsed.event, channels, parsed.answerSource);
      else this.ingestion.ingest(parsed.event, channels);
    }
    state.offset = start + lastNewline + 1;
  }

  private enqueue(path: string, createDeliveries: boolean, readLimit?: number): void {
    this.queue = this.queue.then(() => this.syncFile(path, createDeliveries, readLimit)).catch((error: unknown) => {
      this.logger.warn(`Unable to read Codex session update: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private captureStartupFiles(root: string): Map<string, number> {
    const files = new Map<string, number>();
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile() && extname(entry.name).toLowerCase() === '.jsonl') files.set(path, statSync(path).size);
      }
    };
    visit(root);
    return files;
  }

  private async readSessionId(path: string): Promise<string> {
    const stream = createReadStream(path, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) return parseCodexSessionLine(line).sessionId;
      return '';
    } finally {
      lines.close();
      stream.destroy();
    }
  }

  private async readContextBefore(path: string, end: number): Promise<Pick<FileState, 'sessionId' | 'taskSummary' | 'answerSource' | 'isSubagent'>> {
    let sessionId = '';
    let taskSummary = '';
    let answerSource = '';
    let isSubagent = false;
    const stream = createReadStream(path, { encoding: 'utf8', end: end - 1 });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        const parsed = parseCodexSessionLine(line, sessionId, taskSummary, isSubagent, answerSource);
        sessionId = parsed.sessionId;
        taskSummary = parsed.taskSummary;
        answerSource = parsed.event ? '' : parsed.answerSource;
        isSubagent = parsed.isSubagent;
      }
      return { sessionId, taskSummary, answerSource, isSubagent };
    } finally {
      lines.close();
      stream.destroy();
    }
  }

  private async readBytes(path: string, start: number, end: number): Promise<Buffer> {
    if (end <= start) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    const stream = createReadStream(path, { start, end: end - 1 });
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
}
