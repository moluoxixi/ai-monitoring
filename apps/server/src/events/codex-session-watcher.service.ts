import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { watch, type FSWatcher } from 'chokidar';
import { createReadStream, existsSync, statSync, type Stats } from 'node:fs';
import { extname } from 'node:path';
import { createInterface } from 'node:readline';
import { AppConfigService } from '../config/app-config.service';
import { ChannelsService } from '../channels/channels.service';
import { DatabaseService } from '../database/database.service';
import type { NormalizedEvent } from '../database/database.types';

const INITIAL_TAIL_BYTES = 1024 * 1024;

interface FileState {
  identity: string;
  offset: number;
  sessionId: string;
}

interface ParsedTerminalEvent {
  event?: NormalizedEvent;
  sessionId: string;
  timestampMs: number | null;
}

const recordValue = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const safeErrorCode = (error: Record<string, unknown>): string => {
  const info = error.codex_error_info;
  const candidate = typeof info === 'string' ? info : Object.keys(recordValue(info))[0];
  return candidate && /^[a-z0-9_.:-]{1,100}$/i.test(candidate) ? candidate : 'codex_task_failed';
};

export const parseCodexSessionLine = (line: string, currentSessionId = ''): ParsedTerminalEvent => {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { sessionId: currentSessionId, timestampMs: null };
  }
  const item = recordValue(raw);
  const payload = recordValue(item.payload);
  if (item.type === 'session_meta') {
    const sessionId = String(payload.session_id || payload.id || currentSessionId);
    return { sessionId, timestampMs: null };
  }
  if (item.type !== 'event_msg') return { sessionId: currentSessionId, timestampMs: null };
  const kind = String(payload.type || '');
  if (!['task_complete', 'turn_aborted'].includes(kind)) {
    return { sessionId: currentSessionId, timestampMs: null };
  }
  const turnId = String(payload.turn_id || '');
  if (!currentSessionId || !turnId) return { sessionId: currentSessionId, timestampMs: null };

  const error = recordValue(payload.error);
  const failed = kind === 'task_complete' && Object.keys(error).length > 0;
  const status = failed ? 'failed' : kind === 'task_complete' ? 'completed' : 'interrupted';
  const labels = {
    completed: { title: 'Codex task completed', message: 'Codex turn completed' },
    failed: { title: 'Codex task failed', message: 'Codex turn failed' },
    interrupted: { title: 'Codex task interrupted', message: 'Codex turn was interrupted' },
  } as const;
  const timestamp = typeof item.timestamp === 'string' ? Date.parse(item.timestamp) : Number.NaN;
  return {
    sessionId: currentSessionId,
    timestampMs: Number.isFinite(timestamp) ? timestamp : null,
    event: {
      source_event_id: `${currentSessionId}:${turnId}:${status}`,
      source: 'codex-session',
      client: 'codex',
      kind,
      status,
      title: labels[status].title,
      message: labels[status].message,
      error_code: failed ? safeErrorCode(error) : null,
      metadata: { thread_id: currentSessionId, turn_id: turnId },
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
  private initialScanComplete = false;

  constructor(
    private readonly config: AppConfigService,
    private readonly database: DatabaseService,
    private readonly channels: ChannelsService,
  ) {}

  onModuleInit(): void {
    if (!existsSync(this.config.codexSessionsPath)) return;
    this.watcher = watch(this.config.codexSessionsPath, {
      ignoreInitial: false,
      ignored: (path, stats) => Boolean(stats?.isFile()) && extname(path).toLowerCase() !== '.jsonl',
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });
    this.watcher.on('add', (path) => {
      if (extname(path).toLowerCase() !== '.jsonl') return;
      const createDeliveries = this.initialScanComplete;
      const backfillEnd = createDeliveries ? undefined : statSync(path).size;
      this.enqueue(path, createDeliveries, backfillEnd);
    });
    this.watcher.on('change', (path) => {
      if (extname(path).toLowerCase() === '.jsonl') this.enqueue(path, true);
    });
    this.watcher.on('unlink', (path) => this.files.delete(path));
    this.watcher.on('ready', () => { this.initialScanComplete = true; });
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
        this.files.set(path, { identity, offset: readableSize, sessionId: '' });
        return;
      }
      state = {
        identity,
        offset: Math.max(0, readableSize - INITIAL_TAIL_BYTES),
        sessionId: await this.readSessionId(path),
      };
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
      const parsed = parseCodexSessionLine(line, state.sessionId);
      state.sessionId = parsed.sessionId;
      if (!parsed.event) continue;
      if (initial && parsed.timestampMs !== null && parsed.timestampMs < cutoff) continue;
      const channels = createDeliveries ? this.channels.channelsForClient(parsed.event.client) : [];
      this.database.insertEvent(parsed.event, channels);
    }
    state.offset = start + lastNewline + 1;
  }

  private enqueue(path: string, createDeliveries: boolean, readLimit?: number): void {
    this.queue = this.queue.then(() => this.syncFile(path, createDeliveries, readLimit)).catch((error: unknown) => {
      this.logger.warn(`Unable to read Codex session update: ${error instanceof Error ? error.message : String(error)}`);
    });
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

  private async readBytes(path: string, start: number, end: number): Promise<Buffer> {
    if (end <= start) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    const stream = createReadStream(path, { start, end: end - 1 });
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
}
