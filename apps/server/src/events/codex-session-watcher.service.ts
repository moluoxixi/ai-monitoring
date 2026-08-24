import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { watch, type FSWatcher } from 'chokidar';
import { createReadStream, existsSync, readdirSync, statSync, type Stats } from 'node:fs';
import { extname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { AppConfigService } from '../config/app-config.service';
import { ChannelsService } from '../channels/channels.service';
import type { NormalizedEvent } from '../database/database.types';
import { EventIngestionService } from './event-ingestion.service';
import { recordValue } from '../utils/event-record';
import { sanitizeFailureMessage, summarizeTask, truncateTail } from '../utils/event-text';
import { eventTiming, normalizeEventTimestamp } from '../utils/event-timing';

// Preserve the pre-refactor import path for integrations outside this workspace.
export { sanitizeFailureMessage, summarizeTask } from '../utils/event-text';

const INITIAL_TAIL_BYTES = 1024 * 1024;

interface FileState {
  identity: string;
  offset: number;
  ownerEstablished: boolean;
  sessionId: string;
  isFork: boolean;
  forkCreatedAtMs: number | null;
  ownedTurnIds: Set<string>;
  activeOwnedTurnId: string;
  taskSummary: string;
  answerSource: string;
  startedAt: string;
  startedTurnId: string;
  isSubagent: boolean;
  client: 'codex-cli' | 'codex-desktop';
}

interface ParsedTerminalEvent {
  event?: NormalizedEvent;
  answerSource: string;
  sessionId: string;
  taskSummary: string;
  isSubagent: boolean;
  client: 'codex-cli' | 'codex-desktop';
  timestampMs: number | null;
  /** Present only when a task_started record changes the active turn timing. */
  startedAt?: string;
  startedTurnId?: string;
  consumeStartedTiming?: boolean;
  /** A new user turn supersedes a provisional provider failure. */
  suppressProvisional?: boolean;
}

const sessionIdentity = (payload: Record<string, unknown>, currentClient: 'codex-cli' | 'codex-desktop' = 'codex-desktop'):
  { isSubagent: boolean; client: 'codex-cli' | 'codex-desktop' } => {
  const source = payload.source;
  const sourceObject = recordValue(source);
  const sourceText = typeof source === 'string' ? source.toLowerCase() : '';
  const threadSource = String(payload.thread_source || sourceObject.thread_source || '').toLowerCase();
  const originator = String(payload.originator || '').toLowerCase();
  const isSubagent = Boolean(sourceObject.subagent)
    || sourceText === 'subagent'
    || String(sourceObject.type || '').toLowerCase() === 'subagent'
    || String(sourceObject.kind || '').toLowerCase() === 'subagent'
    || threadSource === 'subagent';
  if (isSubagent) return { isSubagent: true, client: currentClient };
  if (threadSource === 'cli') return { isSubagent: false, client: 'codex-cli' };
  const runtimeText = `${sourceText} ${originator}`;
  if (/\b(cli|command[-_ ]line)\b/.test(runtimeText)) return { isSubagent: false, client: 'codex-cli' };
  if (/\b(desktop|vscode|ide)\b/.test(runtimeText)) return { isSubagent: false, client: 'codex-desktop' };
  return { isSubagent: false, client: currentClient };
};

const safeErrorCode = (error: Record<string, unknown>): string => {
  const info = error.codex_error_info;
  const candidate = typeof info === 'string' ? info : Object.keys(recordValue(info))[0];
  return candidate && /^[a-z0-9_.:-]{1,100}$/i.test(candidate) ? candidate : 'codex_task_failed';
};

const responseItemUserText = (item: Record<string, unknown>, payload: Record<string, unknown>): string => {
  if (item.type !== 'response_item' || payload.type !== 'message' || payload.role !== 'user') return '';
  if (!Array.isArray(payload.content)) return '';
  return payload.content
    .map((content) => recordValue(content))
    .filter((content) => content.type === 'input_text' && typeof content.text === 'string')
    .map((content) => String(content.text))
    .join('\n')
    .trim();
};

const protocolTimestampMs = (value: unknown): number | null => {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Math.abs(value) < 100_000_000_000 ? value * 1_000 : value;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.abs(numeric) < 100_000_000_000 ? numeric * 1_000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export const parseCodexSessionLine = (
  line: string,
  currentSessionId = '',
  currentTaskSummary = '',
  currentIsSubagent = false,
  currentAnswerSource = '',
  currentClient: 'codex-cli' | 'codex-desktop' = 'codex-desktop',
  currentStartedAt = '',
  currentStartedTurnId = '',
): ParsedTerminalEvent => {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { sessionId: currentSessionId, taskSummary: currentTaskSummary, answerSource: currentAnswerSource, isSubagent: currentIsSubagent, client: currentClient, timestampMs: null };
  }
  const item = recordValue(raw);
  const payload = recordValue(item.payload);
  if (item.type === 'session_meta') {
    const sessionId = String(payload.session_id || payload.id || currentSessionId);
    const identity = sessionIdentity({ ...item, ...payload }, currentClient);
    return { sessionId, taskSummary: currentTaskSummary, answerSource: currentAnswerSource, isSubagent: identity.isSubagent, client: identity.client, timestampMs: null };
  }
  const responseUserMessage = responseItemUserText(item, payload);
  if (responseUserMessage) {
    return {
      sessionId: currentSessionId,
      taskSummary: summarizeTask(responseUserMessage) || currentTaskSummary,
      answerSource: '',
      isSubagent: currentIsSubagent,
      client: currentClient,
      timestampMs: null,
      startedAt: '',
      startedTurnId: '',
      suppressProvisional: Boolean(currentSessionId && !currentIsSubagent),
    };
  }
  if (item.type !== 'event_msg') {
    return { sessionId: currentSessionId, taskSummary: currentTaskSummary, answerSource: currentAnswerSource, isSubagent: currentIsSubagent, client: currentClient, timestampMs: null };
  }
  const kind = String(payload.type || '');
  if (kind === 'user_message') {
    return {
      sessionId: currentSessionId,
      taskSummary: summarizeTask(payload.message) || currentTaskSummary,
      answerSource: '',
      isSubagent: currentIsSubagent,
      client: currentClient,
      timestampMs: null,
      startedAt: '',
      startedTurnId: '',
      suppressProvisional: Boolean(currentSessionId && !currentIsSubagent),
    };
  }
  if (kind === 'task_started') {
    return {
      sessionId: currentSessionId,
      taskSummary: currentTaskSummary,
      answerSource: currentAnswerSource,
      isSubagent: currentIsSubagent,
      client: currentClient,
      timestampMs: null,
      startedAt: normalizeEventTimestamp(item.timestamp),
      startedTurnId: String(payload.turn_id || ''),
      suppressProvisional: Boolean(currentSessionId && !currentIsSubagent),
    };
  }
  if (kind === 'agent_message') {
    const message = typeof payload.message === 'string' ? truncateTail(payload.message, 24_000) : '';
    return {
      sessionId: currentSessionId,
      taskSummary: currentTaskSummary,
      answerSource: message || currentAnswerSource,
      isSubagent: currentIsSubagent,
      client: currentClient,
      timestampMs: null,
    };
  }
  if (!['task_complete', 'turn_aborted'].includes(kind)) {
    return { sessionId: currentSessionId, taskSummary: currentTaskSummary, answerSource: currentAnswerSource, isSubagent: currentIsSubagent, client: currentClient, timestampMs: null };
  }
  const turnId = String(payload.turn_id || '');
  if (!currentSessionId || !turnId || currentIsSubagent) {
    return { sessionId: currentSessionId, taskSummary: '', answerSource: '', isSubagent: currentIsSubagent, client: currentClient, timestampMs: null };
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
  const matchesStartedTurn = currentStartedTurnId === turnId;
  const timing = eventTiming(matchesStartedTurn ? currentStartedAt : '', item.timestamp);
  return {
    sessionId: currentSessionId,
    taskSummary: '',
    isSubagent: currentIsSubagent,
    client: currentClient,
    timestampMs: terminalTimestamp,
    consumeStartedTiming: matchesStartedTurn,
    answerSource: status === 'completed'
      ? (typeof payload.last_agent_message === 'string' ? truncateTail(payload.last_agent_message, 24_000) : currentAnswerSource)
      : '',
    event: {
      source_event_id: `${currentSessionId}:${turnId}:${status}`,
      source: 'codex-session',
      client: currentClient,
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
        ...(timing ? { timing } : {}),
      },
    },
  };
};

const unchangedFileResult = (state: FileState): ParsedTerminalEvent => ({
  sessionId: state.sessionId,
  taskSummary: state.taskSummary,
  answerSource: state.answerSource,
  isSubagent: state.isSubagent,
  client: state.client,
  timestampMs: null,
});

const applyParsedFileResult = (state: FileState, parsed: ParsedTerminalEvent): void => {
  state.sessionId = parsed.sessionId;
  state.taskSummary = parsed.taskSummary;
  state.answerSource = parsed.event ? '' : parsed.answerSource;
  state.startedAt = parsed.consumeStartedTiming ? '' : parsed.startedAt ?? state.startedAt;
  state.startedTurnId = parsed.consumeStartedTiming ? '' : parsed.startedTurnId ?? state.startedTurnId;
  state.isSubagent = parsed.isSubagent;
  state.client = parsed.client;
};

const applyCodexSessionLine = (line: string, state: FileState): ParsedTerminalEvent => {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return unchangedFileResult(state);
  }
  const item = recordValue(raw);
  const payload = recordValue(item.payload);
  if (item.type === 'session_meta') {
    if (state.ownerEstablished) return unchangedFileResult(state);
    const sessionId = String(payload.session_id || payload.id || '').trim();
    if (!sessionId) return unchangedFileResult(state);
    const identity = sessionIdentity({ ...item, ...payload }, state.client);
    state.ownerEstablished = true;
    state.sessionId = sessionId;
    state.isSubagent = identity.isSubagent;
    state.client = identity.client;
    state.isFork = Boolean(String(payload.forked_from_id || '').trim());
    state.forkCreatedAtMs = state.isFork
      ? protocolTimestampMs(payload.timestamp) ?? protocolTimestampMs(item.timestamp)
      : null;
    return unchangedFileResult(state);
  }
  if (!state.ownerEstablished) return unchangedFileResult(state);

  const responseUserMessage = responseItemUserText(item, payload);
  const kind = item.type === 'event_msg' ? String(payload.type || '') : '';
  const turnId = String(payload.turn_id || '');
  if (state.isFork) {
    if (kind === 'task_started') {
      const startedAtMs = protocolTimestampMs(payload.started_at);
      const forkCreatedAtSecond = state.forkCreatedAtMs === null
        ? null
        : Math.floor(state.forkCreatedAtMs / 1_000) * 1_000;
      if (!turnId || forkCreatedAtSecond === null || startedAtMs === null || startedAtMs < forkCreatedAtSecond) {
        return unchangedFileResult(state);
      }
      state.ownedTurnIds.add(turnId);
      state.activeOwnedTurnId = turnId;
    } else if (responseUserMessage || kind === 'user_message' || kind === 'agent_message') {
      if (!state.activeOwnedTurnId || !state.ownedTurnIds.has(state.activeOwnedTurnId)) {
        return unchangedFileResult(state);
      }
    } else if (kind === 'task_complete' || kind === 'turn_aborted') {
      if (!turnId || !state.ownedTurnIds.has(turnId)) return unchangedFileResult(state);
    }
  }

  const preserveOwnedTiming = state.isFork
    && Boolean(responseUserMessage || kind === 'user_message')
    && state.startedTurnId === state.activeOwnedTurnId;
  const ownedStartedAt = state.startedAt;
  const ownedStartedTurnId = state.startedTurnId;
  const parsed = parseCodexSessionLine(
    line,
    state.sessionId,
    state.taskSummary,
    state.isSubagent,
    state.answerSource,
    state.client,
    state.startedAt,
    state.startedTurnId,
  );
  applyParsedFileResult(state, parsed);
  if (preserveOwnedTiming) {
    state.startedAt = ownedStartedAt;
    state.startedTurnId = ownedStartedTurnId;
  }
  if (state.isFork && parsed.event && turnId) {
    state.ownedTurnIds.delete(turnId);
    if (state.activeOwnedTurnId === turnId) state.activeOwnedTurnId = '';
  }
  return parsed;
};

const fileIdentity = (stats: Stats): string => `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`;

const emptyFileState = (identity: string, offset: number): FileState => ({
  identity,
  offset,
  ownerEstablished: false,
  sessionId: '',
  isFork: false,
  forkCreatedAtMs: null,
  ownedTurnIds: new Set<string>(),
  activeOwnedTurnId: '',
  taskSummary: '',
  answerSource: '',
  startedAt: '',
  startedTurnId: '',
  isSubagent: false,
  client: 'codex-desktop',
});

@Injectable()
export class CodexSessionWatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CodexSessionWatcherService.name);
  private readonly files = new Map<string, FileState>();
  private watcher: FSWatcher | null = null;
  private queue = Promise.resolve();
  private discoveryTimer: NodeJS.Timeout | null = null;
  private readonly discoveryPending = new Set<string>();

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
      // Recover terminal turns that completed while the relay was offline.
      // syncFile applies codexBackfillMinutes to startup reads, and the
      // database de-duplicates existing channel deliveries, so restarting
      // the service cannot replay already delivered notifications.
      this.enqueue(path, true, backfillEnd);
      this.enqueue(path, true);
    });
    this.watcher.on('change', (path) => {
      if (extname(path).toLowerCase() === '.jsonl') this.enqueue(path, true);
    });
    this.watcher.on('unlink', (path) => this.files.delete(path));
    this.watcher.on('error', (error) => {
      this.logger.error(`Codex session watcher failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.discoveryTimer = setInterval(() => this.discoverFiles(), 2_000);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
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
        const skippedState = emptyFileState(identity, readableSize);
        await this.readFileOwner(path, skippedState);
        this.files.set(path, skippedState);
        return;
      }
      state = emptyFileState(identity, Math.max(0, readableSize - INITIAL_TAIL_BYTES));
      if (state.offset > 0) {
        const context = await this.readContextBefore(path, state.offset);
        state.ownerEstablished = context.ownerEstablished;
        state.sessionId = context.sessionId;
        state.isFork = context.isFork;
        state.forkCreatedAtMs = context.forkCreatedAtMs;
        state.ownedTurnIds = context.ownedTurnIds;
        state.activeOwnedTurnId = context.activeOwnedTurnId;
        state.taskSummary = context.taskSummary;
        state.answerSource = context.answerSource;
        state.startedAt = context.startedAt;
        state.startedTurnId = context.startedTurnId;
        state.isSubagent = context.isSubagent;
        state.client = context.client;
      }
      this.files.set(path, state);
    }
    if (readableSize === state.offset) return;

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
      const parsed = applyCodexSessionLine(line, state);
      if (parsed.suppressProvisional && parsed.sessionId) {
        this.ingestion.suppressProvisionalFailures?.(parsed.client, parsed.sessionId);
      }
      if (!parsed.event) continue;
      if (initial && parsed.timestampMs !== null && parsed.timestampMs < cutoff) continue;
      const channels = createDeliveries ? this.channels.deliveryChannels() : [];
      if (parsed.answerSource) this.ingestion.ingest(parsed.event, channels, parsed.answerSource);
      else this.ingestion.ingest(parsed.event, channels);
    }
    state.offset = start + lastNewline + 1;
  }

  private enqueue(path: string, createDeliveries: boolean, readLimit?: number, fromDiscovery = false): void {
    if (fromDiscovery && this.discoveryPending.has(path)) return;
    if (fromDiscovery) this.discoveryPending.add(path);
    this.queue = this.queue.then(() => this.syncFile(path, createDeliveries, readLimit)).catch((error: unknown) => {
      this.logger.warn(`Unable to read Codex session update: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      if (fromDiscovery) this.discoveryPending.delete(path);
    });
  }

  private discoverFiles(): void {
    for (const [path, size] of this.captureStartupFiles(this.config.codexSessionsPath)) {
      const state = this.files.get(path);
      if (state?.offset === size) continue;
      if (!state) {
        this.files.set(path, emptyFileState('', 0));
      }
      this.enqueue(path, true, undefined, true);
    }
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

  private async readFileOwner(path: string, state: FileState): Promise<void> {
    const stream = createReadStream(path, { encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        applyCodexSessionLine(line, state);
        if (state.ownerEstablished) return;
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  }

  private async readContextBefore(path: string, end: number): Promise<Omit<FileState, 'identity' | 'offset'>> {
    const state = emptyFileState('', 0);
    const stream = createReadStream(path, { encoding: 'utf8', end: end - 1 });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        applyCodexSessionLine(line, state);
      }
      const { identity: _identity, offset: _offset, ...context } = state;
      return context;
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
