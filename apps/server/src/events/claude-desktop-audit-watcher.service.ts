import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { watch, type FSWatcher } from 'chokidar';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { AppConfigService } from '../config/app-config.service';
import { ChannelsService } from '../channels/channels.service';
import type { NormalizedEvent } from '../database/database.types';
import { EventIngestionService } from './event-ingestion.service';
import { scopedSourceEventId } from './event-normalizer';
import { recordValue } from '../utils/event-record';
import { sanitizeFailureMessage, summarizeTask, truncateTail } from '../utils/event-text';

interface TranscriptFileState {
  offset: number;
  sessionId: string;
  taskSummary: string;
  answerSource: string;
  desktopTranscript: boolean;
  cwd: string;
  birthtimeMs: number;
  prefixDigest: string;
}

const contentText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n');
  if (value === null || typeof value !== 'object') return '';
  const record = recordValue(value);
  if (record.type === 'text' && typeof record.text === 'string') return record.text;
  // Traverse only known transcript containers; arbitrary fields such as
  // private thinking payloads must not become notification content.
  for (const key of ['content', 'text', 'message']) {
    const text = contentText(record[key]);
    if (text) return text;
  }
  return '';
};

const textValue = (value: unknown, limit = 24_000): string => {
  const text = contentText(value).replace(/\s+/g, ' ').trim();
  return text ? truncateTail(text, limit) : '';
};

const isSyntheticUserRecord = (item: Record<string, unknown>): boolean =>
  item.tool_use_result !== undefined
  || item.parent_tool_use_id !== undefined
  || item.isReplay === true
  || item.is_replay === true
  || item.isSynthetic === true
  || item.is_synthetic === true;

export interface ClaudeDesktopTranscriptResult {
  sessionId: string;
  taskSummary: string;
  answerSource: string;
  desktopTranscript: boolean;
  cwd: string;
  suppressProvisional?: boolean;
  terminalIdentity?: string;
  terminalTimestampMs?: number;
  event?: NormalizedEvent;
}

export const claudeDesktopTerminalEventId = (
  kind: 'assistant' | 'system',
  stableId: string,
  status: 'completed' | 'failed',
): string => `claude-desktop:${kind}:${stableId}:${status}`;

const transcriptTimestampMs = (value: unknown): number | undefined => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const parseClaudeDesktopTranscriptLine = (
  line: string,
  currentSessionId = '',
  currentTaskSummary = '',
  currentAnswerSource = '',
  currentDesktopTranscript = false,
  currentCwd = '',
): ClaudeDesktopTranscriptResult => {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return {
      sessionId: currentSessionId,
      taskSummary: currentTaskSummary,
      answerSource: currentAnswerSource,
      desktopTranscript: currentDesktopTranscript,
      cwd: currentCwd,
    };
  }
  const item = recordValue(raw);
  const sidechain = item.isSidechain === true;
  const desktopTranscript = currentDesktopTranscript
    || (!sidechain && item.entrypoint === 'claude-desktop-3p');
  const sessionId = String(item.sessionId || item.session_id || currentSessionId);
  const cwd = typeof item.cwd === 'string' && item.cwd.trim() ? item.cwd.trim() : currentCwd;
  if (!desktopTranscript || sidechain) {
    return { sessionId, taskSummary: currentTaskSummary, answerSource: currentAnswerSource, desktopTranscript, cwd };
  }

  if (item.type === 'user') {
    const message = recordValue(item.message);
    const origin = recordValue(item.origin);
    const promptContent = !Array.isArray(message.content)
      || message.content.some((part) => recordValue(part).type === 'text');
    const humanPrompt = message.role === 'user'
      && !isSyntheticUserRecord(item)
      && (origin.kind === 'human' || origin.kind === undefined)
      && promptContent;
    const summary = humanPrompt ? summarizeTask(textValue(message.content, 2_000)) : '';
    if (!summary) {
      return { sessionId, taskSummary: currentTaskSummary, answerSource: currentAnswerSource, desktopTranscript, cwd };
    }
    return {
      sessionId,
      taskSummary: summary,
      answerSource: '',
      desktopTranscript,
      cwd,
      suppressProvisional: Boolean(sessionId),
    };
  }

  if (item.type === 'assistant') {
    const message = recordValue(item.message);
    if (message.role !== 'assistant') {
      return { sessionId, taskSummary: currentTaskSummary, answerSource: currentAnswerSource, desktopTranscript, cwd };
    }
    const answer = textValue(message.content) || currentAnswerSource;
    if (String(message.stop_reason || '').toLowerCase() !== 'end_turn') {
      return { sessionId, taskSummary: currentTaskSummary, answerSource: answer, desktopTranscript, cwd };
    }
    if (!answer) {
      return { sessionId, taskSummary: currentTaskSummary, answerSource: '', desktopTranscript, cwd };
    }
    const turnId = String(message.id || item.uuid || '');
    const terminalIdentity = turnId
      ? claudeDesktopTerminalEventId('assistant', turnId, 'completed')
      : '';
    if (!sessionId || !turnId) {
      return { sessionId, taskSummary: currentTaskSummary, answerSource: answer, desktopTranscript, cwd };
    }
    return {
      sessionId,
      taskSummary: currentTaskSummary,
      answerSource: answer,
      desktopTranscript,
      cwd,
      terminalIdentity,
      terminalTimestampMs: transcriptTimestampMs(item.timestamp),
      event: {
        source_event_id: scopedSourceEventId('claude-desktop', 'claude-desktop', terminalIdentity),
        source: 'claude-desktop',
        client: 'claude-desktop',
        kind: 'assistant',
        status: 'completed',
        title: 'Claude Desktop task completed',
        message: 'Claude Desktop task completed',
        error_code: null,
        metadata: {
          session_id: sessionId,
          turn_id: turnId,
          ...(cwd ? { cwd } : {}),
          ...(currentTaskSummary ? { task_summary: currentTaskSummary } : {}),
          ...(answer ? { answer_source: answer } : {}),
        },
      },
    };
  }

  if (item.type === 'system' && item.subtype === 'api_error') {
    const error = recordValue(item.error);
    const failureMessage = sanitizeFailureMessage(textValue(error.message || item.error), true);
    const turnId = String(item.uuid || '');
    const terminalIdentity = turnId
      ? claudeDesktopTerminalEventId('system', turnId, 'failed')
      : '';
    if (!sessionId || !turnId) {
      return { sessionId, taskSummary: currentTaskSummary, answerSource: '', desktopTranscript, cwd };
    }
    return {
      sessionId,
      taskSummary: currentTaskSummary,
      answerSource: '',
      desktopTranscript,
      cwd,
      terminalIdentity,
      terminalTimestampMs: transcriptTimestampMs(item.timestamp),
      event: {
        source_event_id: scopedSourceEventId('claude-desktop', 'claude-desktop', terminalIdentity),
        source: 'claude-desktop',
        client: 'claude-desktop',
        kind: 'api_error',
        status: 'failed',
        title: 'Claude Desktop task failed',
        message: failureMessage || 'Claude Desktop task failed',
        error_code: 'claude_desktop_api_error',
        metadata: {
          session_id: sessionId,
          turn_id: turnId,
          ...(cwd ? { cwd } : {}),
          ...(currentTaskSummary ? { task_summary: currentTaskSummary } : {}),
          ...(failureMessage ? { failure_message: failureMessage } : {}),
        },
      },
    };
  }

  return { sessionId, taskSummary: currentTaskSummary, answerSource: currentAnswerSource, desktopTranscript, cwd };
};

@Injectable()
export class ClaudeDesktopTranscriptWatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClaudeDesktopTranscriptWatcherService.name);
  private readonly transcriptFiles = new Map<string, TranscriptFileState>();
  private readonly startupTranscriptFiles = new Map<string, number>();
  private readonly seenTerminalIds = new Set<string>();
  private readonly watchedRoots = new Set<string>();
  private readonly watchers: FSWatcher[] = [];
  private queue = Promise.resolve();
  private discoveryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: AppConfigService,
    private readonly channels: ChannelsService,
    private readonly ingestion: EventIngestionService,
  ) {}

  onModuleInit(): void {
    this.discoverRoots();
    this.discoveryTimer = setInterval(() => this.discoverRoots(), 2_000);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    await Promise.all(this.watchers.map((watcher) => watcher.close()));
    await this.queue;
  }

  private discoverRoots(): void {
    this.watchRoot(this.config.claudeDesktopTranscriptsPath);
  }

  private watchRoot(root: string): void {
    if (!root || !existsSync(root)) return;
    const resolved = resolve(root);
    const normalized = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    const key = `transcript:${normalized}`;
    if (this.watchedRoots.has(key)) return;
    const predicate = (path: string): boolean => extname(path).toLowerCase() === '.jsonl'
      && !path.toLowerCase().endsWith('audit.jsonl');
    this.captureStartupFiles(resolved, predicate).forEach((path) => {
      try {
        this.startupTranscriptFiles.set(path, statSync(path).size);
      } catch {
        // Chokidar will treat files that disappear during discovery normally.
      }
    });
    const watcher = watch(resolved, {
      ignoreInitial: false,
      ignored: (path, stats) => Boolean(stats?.isFile()) && !predicate(path),
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });
    watcher.on('add', (path) => this.addFile(path, predicate));
    watcher.on('change', (path) => {
      if (predicate(path)) this.enqueue(path);
    });
    watcher.on('unlink', (path) => {
      this.transcriptFiles.delete(path);
    });
    watcher.on('error', (error) => this.logger.warn(
      `Claude Desktop transcript watcher failed: ${error instanceof Error ? error.message : String(error)}`,
    ));
    this.watchedRoots.add(key);
    this.watchers.push(watcher);
  }

  private addFile(path: string, predicate: (path: string) => boolean): void {
    if (!predicate(path)) return;
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(path);
    } catch {
      return;
    }
    const size = stats.size;
    const observedAt = Date.now();
    const birthtimeMs = Number.isFinite(stats.birthtimeMs) && stats.birthtimeMs > 0
      ? stats.birthtimeMs
      : observedAt;
    const startupSize = this.startupTranscriptFiles.get(path);
    this.startupTranscriptFiles.delete(path);
    const state = startupSize !== undefined
      ? this.seedStartupFile(path, startupSize, birthtimeMs)
      : this.emptyFileState(birthtimeMs);
    this.transcriptFiles.set(path, state);
    if (size > state.offset) {
      this.enqueue(path);
    }
  }

  private enqueue(path: string): void {
    this.queue = this.queue.then(() => this.syncTranscriptFile(path)).catch((error) => {
      this.logger.warn(`Unable to read Claude Desktop transcript update: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private emptyFileState(birthtimeMs: number): TranscriptFileState {
    return {
      offset: 0,
      sessionId: '',
      taskSummary: '',
      answerSource: '',
      desktopTranscript: false,
      cwd: '',
      birthtimeMs,
      prefixDigest: '',
    };
  }

  private seedStartupFile(path: string, snapshotSize: number, birthtimeMs: number): TranscriptFileState {
    const state = this.emptyFileState(birthtimeMs);
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      state.offset = snapshotSize;
      return state;
    }
    const snapshotEnd = Math.min(snapshotSize, bytes.length);
    const lastNewline = bytes.subarray(0, snapshotEnd).lastIndexOf(0x0a);
    state.offset = lastNewline < 0 ? 0 : lastNewline + 1;
    state.prefixDigest = this.prefixDigest(bytes, state.offset);
    const source = bytes.subarray(0, state.offset).toString('utf8');
    for (const rawLine of source.split(/\r?\n/)) {
      if (!rawLine.trim()) continue;
      const parsed = parseClaudeDesktopTranscriptLine(
        rawLine,
        state.sessionId,
        state.taskSummary,
        state.answerSource,
        state.desktopTranscript,
        state.cwd,
      );
      state.sessionId = parsed.sessionId;
      state.taskSummary = parsed.taskSummary;
      state.answerSource = parsed.event ? '' : parsed.answerSource;
      state.desktopTranscript = parsed.desktopTranscript;
      state.cwd = parsed.cwd;
      if (parsed.terminalIdentity) this.seenTerminalIds.add(parsed.terminalIdentity);
    }
    return state;
  }

  private prefixDigest(bytes: Buffer, length: number): string {
    return createHash('sha256').update(bytes.subarray(0, length)).digest('hex');
  }

  private captureStartupFiles(root: string, predicate: (path: string) => boolean): string[] {
    const files: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile() && predicate(path)) files.push(path);
      }
    };
    visit(root);
    return files;
  }

  private syncTranscriptFile(path: string): void {
    if (!existsSync(path)) return;
    const bytes = readFileSync(path);
    const current = this.transcriptFiles.get(path) || this.emptyFileState(Date.now());
    const rewrittenPrefix = current.offset > 0
      && bytes.length >= current.offset
      && current.prefixDigest
      && this.prefixDigest(bytes, current.offset) !== current.prefixDigest;
    if (bytes.length < current.offset || rewrittenPrefix) {
      current.offset = 0;
      current.sessionId = '';
      current.taskSummary = '';
      current.answerSource = '';
      current.desktopTranscript = false;
      current.cwd = '';
      current.prefixDigest = '';
    }
    const chunk = bytes.subarray(current.offset);
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline < 0) return;
    const complete = chunk.subarray(0, lastNewline + 1).toString('utf8');
    for (const rawLine of complete.split('\n')) {
      if (!rawLine.trim()) continue;
      const parsed = parseClaudeDesktopTranscriptLine(
        rawLine,
        current.sessionId,
        current.taskSummary,
        current.answerSource,
        current.desktopTranscript,
        current.cwd,
      );
      current.sessionId = parsed.sessionId;
      current.taskSummary = parsed.taskSummary;
      current.answerSource = parsed.event ? '' : parsed.answerSource;
      current.desktopTranscript = parsed.desktopTranscript;
      current.cwd = parsed.cwd;
      if (parsed.suppressProvisional && parsed.sessionId) {
        this.ingestion.suppressProvisionalFailures?.('claude-desktop', parsed.sessionId);
      }
      if (!parsed.event) continue;
      const duplicateTerminal = Boolean(
        parsed.terminalIdentity && this.seenTerminalIds.has(parsed.terminalIdentity),
      );
      const copiedHistory = parsed.terminalTimestampMs !== undefined
        && parsed.terminalTimestampMs < current.birthtimeMs;
      if (parsed.terminalIdentity) this.seenTerminalIds.add(parsed.terminalIdentity);
      if (duplicateTerminal || copiedHistory) continue;
      const channels = this.channels.deliveryChannels();
      this.ingestion.ingest(parsed.event, channels, parsed.answerSource || undefined);
    }
    current.offset += lastNewline + 1;
    current.prefixDigest = this.prefixDigest(bytes, current.offset);
    this.transcriptFiles.set(path, current);
  }
}

/** Compatibility export for integrations that imported the pre-session watcher name. */
export { ClaudeDesktopTranscriptWatcherService as ClaudeDesktopAuditWatcherService };
