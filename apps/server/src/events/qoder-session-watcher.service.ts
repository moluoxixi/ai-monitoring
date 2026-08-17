import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { watch, type FSWatcher } from 'chokidar';
import { createReadStream, existsSync, readdirSync, statSync, type Stats } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { AppConfigService } from '../config/app-config.service';
import { ChannelsService } from '../channels/channels.service';
import type { NormalizedEvent } from '../database/database.types';
import { recordValue } from '../utils/event-record';
import { summarizeTask, truncateTail } from '../utils/event-text';
import { EventIngestionService } from './event-ingestion.service';

type QoderClient = 'qoder-cli' | 'qoder-desktop' | 'qoder-quest';

interface FileState {
  identity: string;
  offset: number;
  prefixLength: number;
  prefix: string;
  anchorLength: number;
  anchor: string;
  sessionId: string;
  turnId: string;
  taskSummary: string;
  answerSource: string;
  client: QoderClient | null;
}

interface SessionContext {
  path: string;
  turnId: string;
  taskSummary: string;
  answerSource: string;
  client: 'qoder-desktop' | 'qoder-quest';
}

interface ParsedQoderLine {
  event?: NormalizedEvent;
  answerSource: string;
  sessionId: string;
  turnId: string;
  taskSummary: string;
  client: QoderClient | null;
}

export interface QoderDesktopCompletion {
  sessionId: string;
  completionId: string;
  client: 'qoder-desktop' | 'qoder-quest';
}

type SourceRoot = {
  root: string;
  accepts: (path: string) => boolean;
};

type PendingCompletion = {
  completion: QoderDesktopCompletion;
  retryTimer: NodeJS.Timeout;
  expiryTimer: NodeJS.Timeout;
};

const fileIdentity = (stats: Stats): string => `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`;
const normalizedPath = (path: string): string => path.replace(/\\/g, '/').toLowerCase();
const isQoderTranscript = (path: string): boolean => extname(path).toLowerCase() === '.jsonl';
const isQoderAgentLog = (path: string): boolean => basename(path).toLowerCase() === 'agent.log';
const isQuestSession = (sessionId: string): boolean => {
  const normalized = sessionId.toLowerCase();
  return normalized.endsWith('.session.execution') || normalized.includes('blank_session_quest');
};

const contentText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n');
  if (!value || typeof value !== 'object') return '';
  const item = recordValue(value);
  const type = String(item.type || '').toLowerCase();
  if (['thinking', 'tool_use', 'tool_result'].includes(type)) return '';
  if (type === 'text' && typeof item.text === 'string') return item.text;
  for (const key of ['content', 'text', 'message']) {
    const text = contentText(item[key]);
    if (text) return text;
  }
  return '';
};

const hasContentType = (value: unknown, expected: string): boolean => {
  if (Array.isArray(value)) return value.some((item) => hasContentType(item, expected));
  if (!value || typeof value !== 'object') return false;
  const item = recordValue(value);
  if (String(item.type || '').toLowerCase() === expected) return true;
  return hasContentType(item.content, expected);
};

const inferClient = (
  path: string,
  item: Record<string, unknown>,
  sessionId: string,
  current: QoderClient | null,
): QoderClient | null => {
  if (isQuestSession(sessionId)) return 'qoder-quest';
  if (String(item.entrypoint || '').toLowerCase() === 'cli') return 'qoder-cli';
  if (normalizedPath(path).includes('/transcript/')) return 'qoder-desktop';
  return current;
};

const timestampKey = (value: unknown): string => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
};

const completionEvent = (
  client: QoderClient,
  sessionId: string,
  completionId: string,
  taskSummary: string,
  prefix = 'qoder-session',
): NormalizedEvent => ({
  source_event_id: `${prefix}:${sessionId}:${completionId}`,
  source: 'qoder',
  client,
  kind: 'end_turn',
  status: 'completed',
  title: 'Qoder task completed',
  message: taskSummary ? `提问：${taskSummary}` : 'Qoder turn completed',
  error_code: null,
  metadata: {
    session_id: sessionId,
    turn_id: completionId,
    ...(taskSummary ? { task_summary: taskSummary } : {}),
  },
});

export const parseQoderSessionLine = (
  line: string,
  path: string,
  currentSessionId = '',
  currentTaskSummary = '',
  currentClient: QoderClient | null = null,
  currentAnswerSource = '',
  currentTurnId = '',
): ParsedQoderLine => {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return {
      sessionId: currentSessionId,
      turnId: currentTurnId,
      taskSummary: currentTaskSummary,
      client: currentClient,
      answerSource: currentAnswerSource,
    };
  }
  const item = recordValue(raw);
  const sessionId = String(item.sessionId || item.session_id || currentSessionId || '').trim();
  const client = inferClient(path, item, sessionId, currentClient);
  const message = recordValue(item.message);
  const role = String(message.role || '').toLowerCase();

  if (item.type === 'user' && role === 'user') {
    if (hasContentType(message.content, 'tool_result')) {
      return {
        sessionId,
        turnId: currentTurnId,
        taskSummary: currentTaskSummary,
        client,
        answerSource: currentAnswerSource,
      };
    }
    const taskSummary = summarizeTask(contentText(message.content)) || currentTaskSummary;
    const turnId = String(item.uuid || timestampKey(item.timestamp) || currentTurnId).trim();
    return { sessionId, turnId, taskSummary, client, answerSource: '' };
  }

  if (item.type !== 'assistant' || role !== 'assistant') {
    return {
      sessionId,
      turnId: currentTurnId,
      taskSummary: currentTaskSummary,
      client,
      answerSource: currentAnswerSource,
    };
  }
  const text = truncateTail(contentText(message.content).trim(), 24_000);
  const answerSource = text || currentAnswerSource;
  const stopReason = String(message.stop_reason || '').toLowerCase();
  const completionId = String(message.id || timestampKey(item.timestamp)).trim();
  if (client !== 'qoder-cli' || stopReason !== 'end_turn' || !sessionId || !completionId || !answerSource) {
    return { sessionId, turnId: currentTurnId, taskSummary: currentTaskSummary, client, answerSource };
  }

  return {
    sessionId,
    turnId: currentTurnId,
    taskSummary: '',
    client,
    answerSource,
    event: completionEvent(client, sessionId, completionId, currentTaskSummary),
  };
};

export const parseQoderDesktopCompletionLine = (line: string, path: string): QoderDesktopCompletion | null => {
  const match = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}).*\[ACPProgressStateMachine\] State transition: [^,]+ -> completed, trigger: chat_finish:success:200, sessionId: ([^\s,]+)/.exec(line);
  if (!match?.[1] || !match[2]) return null;
  const normalized = normalizedPath(path);
  const questWindow = normalized.includes('/questwindow/');
  const desktopWindow = /\/window\d+\//.test(normalized);
  if (!questWindow && !desktopWindow) return null;
  const sessionId = match[2].trim();
  if (!questWindow && isQuestSession(sessionId)) return null;
  return {
    sessionId,
    completionId: match[1].replace(/\D/g, ''),
    client: questWindow ? 'qoder-quest' : 'qoder-desktop',
  };
};

@Injectable()
export class QoderSessionWatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QoderSessionWatcherService.name);
  private readonly files = new Map<string, FileState>();
  private readonly sessions = new Map<string, SessionContext>();
  private readonly pendingCompletions = new Map<string, PendingCompletion>();
  private readonly deliveredTurns = new Set<string>();
  private readonly startupFiles = new Map<string, number>();
  private readonly roots: SourceRoot[] = [];
  private readonly watchers: FSWatcher[] = [];
  private queue = Promise.resolve();
  private discoveryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly channels: ChannelsService,
    private readonly ingestion: EventIngestionService,
  ) {}

  onModuleInit(): void {
    this.startRoot(this.config.qoderSessionsPath, isQoderTranscript);
    this.startRoot(this.config.qoderLogsPath, isQoderAgentLog);
    if (!this.roots.length) return;
    this.discoveryTimer = setInterval(() => {
      for (const { root, accepts } of this.roots) {
        for (const path of this.captureFiles(root, accepts).keys()) {
          if (!this.files.has(path) && !this.startupFiles.has(path)) this.enqueue(path, true);
        }
      }
    }, 2_000);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    for (const pending of this.pendingCompletions.values()) {
      clearTimeout(pending.retryTimer);
      clearTimeout(pending.expiryTimer);
    }
    this.pendingCompletions.clear();
    await Promise.all(this.watchers.map((watcher) => watcher.close()));
    await this.queue;
  }

  async syncFile(path: string, createDeliveries = true, readLimit?: number): Promise<void> {
    const stats = statSync(path);
    const readableSize = Math.min(stats.size, readLimit ?? stats.size);
    const identity = fileIdentity(stats);
    let state = this.files.get(path);
    let rewritten = false;
    if (state && state.identity === identity && state.offset > 0 && state.prefixLength > 0) {
      const prefixEnd = Math.min(readableSize, state.prefixLength);
      const prefix = prefixEnd === state.prefixLength
        ? (await this.readBytes(path, 0, prefixEnd)).toString('base64')
        : '';
      rewritten = prefix !== state.prefix;
    }
    if (!rewritten && state && state.identity === identity && state.offset > 0 && state.anchorLength > 0) {
      const anchorEnd = Math.min(readableSize, state.offset);
      const anchorStart = anchorEnd - state.anchorLength;
      const anchor = anchorStart >= 0 && anchorEnd === state.offset
        ? (await this.readBytes(path, anchorStart, anchorEnd)).toString('base64')
        : '';
      rewritten = anchor !== state.anchor;
    }
    if (!state || state.identity !== identity || readableSize < state.offset || rewritten) {
      const prefixLength = Math.min(readableSize, 128);
      state = {
        identity,
        offset: 0,
        prefixLength,
        prefix: prefixLength ? (await this.readBytes(path, 0, prefixLength)).toString('base64') : '',
        anchorLength: 0,
        anchor: '',
        sessionId: basename(path, extname(path)),
        turnId: '',
        taskSummary: '',
        answerSource: '',
        client: null,
      };
      this.files.set(path, state);
    }
    if (readableSize === state.offset) return;

    const start = state.offset;
    const bytes = await this.readBytes(path, start, readableSize);
    const lastNewline = bytes.lastIndexOf(0x0a);
    if (lastNewline < 0) return;
    const lines = bytes.subarray(0, lastNewline + 1).toString('utf8').split('\n');
    for (const rawLine of lines) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (!line) continue;
      if (isQoderAgentLog(path)) await this.handleAgentLogLine(line, path, createDeliveries);
      else this.handleTranscriptLine(line, path, state, createDeliveries);
    }
    state.offset = start + lastNewline + 1;
    if (state.prefixLength === 0 && state.offset > 0) {
      state.prefixLength = Math.min(state.offset, 128);
      state.prefix = (await this.readBytes(path, 0, state.prefixLength)).toString('base64');
    }
    state.anchorLength = Math.min(state.offset, 128);
    state.anchor = state.anchorLength
      ? (await this.readBytes(path, state.offset - state.anchorLength, state.offset)).toString('base64')
      : '';
    if (!isQoderAgentLog(path)) {
      this.deliverPending(state.sessionId);
    }
  }

  private startRoot(root: string, accepts: (path: string) => boolean): void {
    if (!root || !existsSync(root)) return;
    this.roots.push({ root, accepts });
    for (const [path, size] of this.captureFiles(root, accepts)) this.startupFiles.set(path, size);
    const watcher = watch(root, {
      ignoreInitial: false,
      ignored: (path, stats) => Boolean(stats?.isFile()) && !accepts(path),
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    watcher.on('add', (path) => {
      if (!accepts(path)) return;
      const baseline = this.startupFiles.get(path);
      this.startupFiles.delete(path);
      if (baseline === undefined) {
        this.enqueue(path, true);
        return;
      }
      this.enqueue(path, false, baseline);
      this.enqueue(path, true);
    });
    watcher.on('change', (path) => {
      if (accepts(path)) this.enqueue(path, true);
    });
    watcher.on('unlink', (path) => {
      this.startupFiles.delete(path);
      this.files.delete(path);
    });
    watcher.on('error', (error) => {
      this.logger.error(`Qoder watcher failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    this.watchers.push(watcher);
  }

  private handleTranscriptLine(line: string, path: string, state: FileState, createDeliveries: boolean): void {
    const parsed = parseQoderSessionLine(
      line,
      path,
      state.sessionId,
      state.taskSummary,
      state.client,
      state.answerSource,
      state.turnId,
    );
    state.sessionId = parsed.sessionId;
    state.turnId = parsed.turnId;
    state.taskSummary = parsed.taskSummary;
    state.answerSource = parsed.answerSource;
    state.client = parsed.client;
    if (parsed.client === 'qoder-desktop' || parsed.client === 'qoder-quest') {
      this.sessions.set(parsed.sessionId, {
        path,
        turnId: parsed.turnId,
        taskSummary: parsed.taskSummary,
        answerSource: parsed.answerSource,
        client: parsed.client,
      });
    }
    if (!parsed.event) return;
    const channels = createDeliveries ? this.channels.deliveryChannels() : [];
    this.ingestion.ingest(parsed.event, channels, parsed.answerSource);
  }

  private async handleAgentLogLine(line: string, path: string, createDeliveries: boolean): Promise<void> {
    const completion = parseQoderDesktopCompletionLine(line, path);
    if (!completion) return;
    if (!createDeliveries) return;
    this.setPendingCompletion(completion);
    await this.refreshSessionContext(completion.sessionId);
    this.deliverPending(completion.sessionId);
  }

  private async refreshSessionContext(sessionId: string): Promise<SessionContext | undefined> {
    let context = this.sessions.get(sessionId);
    const transcriptPath = context?.path || this.findTranscriptPath(sessionId);
    if (transcriptPath && existsSync(transcriptPath)) {
      await this.syncFile(transcriptPath, false);
      context = this.sessions.get(sessionId);
    }
    return context;
  }

  private setPendingCompletion(completion: QoderDesktopCompletion): void {
    this.clearPendingCompletion(completion.sessionId);
    const retryDelay = Math.max(100, this.config.answerCaptureGraceMs || 0);
    const retryTimer = setTimeout(() => {
      this.queue = this.queue.then(async () => {
        await this.refreshSessionContext(completion.sessionId);
        this.deliverPending(completion.sessionId);
      }).catch((error: unknown) => {
        this.logger.warn(`Unable to retry Qoder completion: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, retryDelay);
    const expiryTimer = setTimeout(() => this.clearPendingCompletion(completion.sessionId), 60_000);
    this.pendingCompletions.set(completion.sessionId, { completion, retryTimer, expiryTimer });
  }

  private deliverPending(sessionId: string): void {
    const pending = this.pendingCompletions.get(sessionId);
    const context = this.sessions.get(sessionId);
    if (!pending || !context || context.client !== pending.completion.client) return;
    const deliveredKey = context.turnId
      ? `${pending.completion.client}:${sessionId}:${context.turnId}`
      : '';
    if (deliveredKey && this.deliveredTurns.has(deliveredKey)) {
      this.clearPendingCompletion(sessionId);
      return;
    }
    if (!context.answerSource) return;
    const event = completionEvent(
      pending.completion.client,
      sessionId,
      pending.completion.completionId,
      context.taskSummary,
      'qoder-log',
    );
    this.ingestion.ingest(event, this.channels.deliveryChannels(), context.answerSource);
    if (deliveredKey) this.rememberDelivered(deliveredKey);
    this.clearPendingCompletion(sessionId);
    this.clearSessionContext(sessionId, context.path);
  }

  private rememberDelivered(key: string): void {
    this.deliveredTurns.add(key);
    if (this.deliveredTurns.size <= 2_048) return;
    const oldest = this.deliveredTurns.values().next().value as string | undefined;
    if (oldest) this.deliveredTurns.delete(oldest);
  }

  private clearPendingCompletion(sessionId: string): void {
    const pending = this.pendingCompletions.get(sessionId);
    if (!pending) return;
    clearTimeout(pending.retryTimer);
    clearTimeout(pending.expiryTimer);
    this.pendingCompletions.delete(sessionId);
  }

  private findTranscriptPath(sessionId: string): string {
    if (!this.config.qoderSessionsPath || !existsSync(this.config.qoderSessionsPath)) return '';
    const expected = `${sessionId}.jsonl`.toLowerCase();
    for (const path of this.captureFiles(this.config.qoderSessionsPath, isQoderTranscript).keys()) {
      if (basename(path).toLowerCase() === expected && normalizedPath(path).includes('/transcript/')) return path;
    }
    return '';
  }

  private clearSessionContext(sessionId: string, path: string): void {
    const context = this.sessions.get(sessionId);
    if (context) this.sessions.set(sessionId, { ...context, taskSummary: '', answerSource: '' });
    const state = this.files.get(path);
    if (state?.sessionId === sessionId) {
      state.taskSummary = '';
      state.answerSource = '';
    }
  }

  private enqueue(path: string, createDeliveries: boolean, readLimit?: number): void {
    this.queue = this.queue.then(() => this.syncFile(path, createDeliveries, readLimit)).catch((error: unknown) => {
      this.logger.warn(`Unable to read Qoder update: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private captureFiles(root: string, accepts: (path: string) => boolean): Map<string, number> {
    const files = new Map<string, number>();
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile() && accepts(path)) files.set(path, statSync(path).size);
      }
    };
    try {
      visit(root);
    } catch {
      return new Map();
    }
    return files;
  }

  private async readBytes(path: string, start: number, end: number): Promise<Buffer> {
    if (end <= start) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    const stream = createReadStream(path, { start, end: end - 1 });
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
}
