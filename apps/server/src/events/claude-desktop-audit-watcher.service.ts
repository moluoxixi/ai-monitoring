import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { watch, type FSWatcher } from 'chokidar';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { AppConfigService } from '../config/app-config.service';
import { ChannelsService } from '../channels/channels.service';
import type { NormalizedEvent } from '../database/database.types';
import { EventIngestionService } from './event-ingestion.service';
import { hasClaudeDesktopEntrypoint } from './claude-desktop-transcript';
import { recordValue } from '../utils/event-record';
import { sanitizeFailureMessage, summarizeTask, truncateTail } from '../utils/event-text';

interface TranscriptFileState {
  offset: number;
  sessionId: string;
  taskSummary: string;
  answerSource: string;
  desktopTranscript: boolean;
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
  suppressProvisional?: boolean;
  event?: NormalizedEvent;
}

export const parseClaudeDesktopTranscriptLine = (
  line: string,
  currentSessionId = '',
  currentTaskSummary = '',
  currentAnswerSource = '',
  currentDesktopTranscript = false,
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
    };
  }
  const item = recordValue(raw);
  const desktopTranscript = currentDesktopTranscript || item.entrypoint === 'claude-desktop-3p';
  const sessionId = String(item.sessionId || item.session_id || currentSessionId);
  if (!desktopTranscript || item.isSidechain === true) {
    return { sessionId, taskSummary: currentTaskSummary, answerSource: currentAnswerSource, desktopTranscript };
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
      return { sessionId, taskSummary: currentTaskSummary, answerSource: currentAnswerSource, desktopTranscript };
    }
    return {
      sessionId,
      taskSummary: summary,
      answerSource: '',
      desktopTranscript,
      suppressProvisional: Boolean(sessionId),
    };
  }

  if (item.type === 'assistant') {
    const message = recordValue(item.message);
    if (message.role !== 'assistant') {
      return { sessionId, taskSummary: currentTaskSummary, answerSource: currentAnswerSource, desktopTranscript };
    }
    const answer = textValue(message.content) || currentAnswerSource;
    if (String(message.stop_reason || '').toLowerCase() !== 'end_turn') {
      return { sessionId, taskSummary: currentTaskSummary, answerSource: answer, desktopTranscript };
    }
    if (!answer) {
      return { sessionId, taskSummary: currentTaskSummary, answerSource: '', desktopTranscript };
    }
    const turnId = String(message.id || item.uuid || item.timestamp || '');
    if (!sessionId || !turnId) {
      return { sessionId, taskSummary: currentTaskSummary, answerSource: answer, desktopTranscript };
    }
    return {
      sessionId,
      taskSummary: currentTaskSummary,
      answerSource: answer,
      desktopTranscript,
      event: {
        source_event_id: `${sessionId}:transcript:${turnId}:completed`,
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
          ...(currentTaskSummary ? { task_summary: currentTaskSummary } : {}),
          ...(answer ? { answer_source: answer } : {}),
        },
      },
    };
  }

  if (item.type === 'system' && item.subtype === 'api_error') {
    const error = recordValue(item.error);
    const failureMessage = sanitizeFailureMessage(textValue(error.message || item.error), true);
    const turnId = String(item.uuid || item.timestamp || '');
    if (!sessionId || !turnId) {
      return { sessionId, taskSummary: currentTaskSummary, answerSource: '', desktopTranscript };
    }
    return {
      sessionId,
      taskSummary: currentTaskSummary,
      answerSource: '',
      desktopTranscript,
      event: {
        source_event_id: `${sessionId}:transcript:${turnId}:failed`,
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
          ...(currentTaskSummary ? { task_summary: currentTaskSummary } : {}),
          ...(failureMessage ? { failure_message: failureMessage } : {}),
        },
      },
    };
  }

  return { sessionId, taskSummary: currentTaskSummary, answerSource: currentAnswerSource, desktopTranscript };
};

@Injectable()
export class ClaudeDesktopTranscriptWatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClaudeDesktopTranscriptWatcherService.name);
  private readonly transcriptFiles = new Map<string, TranscriptFileState>();
  private readonly startupTranscriptFiles = new Set<string>();
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
    this.captureStartupFiles(resolved, predicate).forEach((path) => this.startupTranscriptFiles.add(path));
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
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return;
    }
    const startup = this.startupTranscriptFiles.delete(path);
    const offset = startup ? size : 0;
    this.transcriptFiles.set(path, {
      offset,
      sessionId: '',
      taskSummary: '',
      answerSource: '',
      desktopTranscript: startup && this.isDesktopTranscript(path),
    });
    if (size > 0 && this.transcriptFiles.get(path)?.offset === 0) {
      this.enqueue(path);
    }
  }

  private enqueue(path: string): void {
    this.queue = this.queue.then(() => this.syncTranscriptFile(path)).catch((error) => {
      this.logger.warn(`Unable to read Claude Desktop transcript update: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private isDesktopTranscript(path: string): boolean {
    try {
      return hasClaudeDesktopEntrypoint(readFileSync(path, 'utf8'));
    } catch {
      return false;
    }
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
    const current = this.transcriptFiles.get(path) || {
      offset: 0,
      sessionId: '',
      taskSummary: '',
      answerSource: '',
      desktopTranscript: false,
    };
    if (bytes.length < current.offset) {
      current.offset = 0;
      current.sessionId = '';
      current.taskSummary = '';
      current.answerSource = '';
      current.desktopTranscript = false;
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
      );
      current.sessionId = parsed.sessionId;
      current.taskSummary = parsed.taskSummary;
      current.answerSource = parsed.event ? '' : parsed.answerSource;
      current.desktopTranscript = parsed.desktopTranscript;
      if (parsed.suppressProvisional && parsed.sessionId) {
        this.ingestion.suppressProvisionalFailures?.('claude-desktop', parsed.sessionId);
      }
      if (!parsed.event) continue;
      const channels = this.channels.deliveryChannels();
      this.ingestion.ingest(parsed.event, channels, parsed.answerSource || undefined);
    }
    current.offset += lastNewline + 1;
    this.transcriptFiles.set(path, current);
  }
}

/** Compatibility export for integrations that imported the pre-session watcher name. */
export { ClaudeDesktopTranscriptWatcherService as ClaudeDesktopAuditWatcherService };
