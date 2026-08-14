import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { watch, type FSWatcher } from 'chokidar';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AppConfigService } from '../config/app-config.service';
import { ChannelsService } from '../channels/channels.service';
import type { NormalizedEvent } from '../database/database.types';
import { EventIngestionService } from './event-ingestion.service';
import { sanitizeFailureMessage, summarizeTask } from './codex-session-watcher.service';
import { truncateTail } from './event-text';

interface AuditFileState {
  offset: number;
  sessionId: string;
  taskSummary: string;
  answerSource: string;
}

const recordValue = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const contentText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join('\n');
  if (value === null || typeof value !== 'object') return '';
  const record = recordValue(value);
  if (record.type === 'text' && typeof record.text === 'string') return record.text;
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

export interface ClaudeDesktopAuditResult {
  sessionId: string;
  taskSummary: string;
  answerSource: string;
  event?: NormalizedEvent;
}

export const parseClaudeDesktopAuditLine = (
  line: string,
  currentSessionId = '',
  currentTaskSummary = '',
  currentAnswerSource = '',
): ClaudeDesktopAuditResult => {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { sessionId: currentSessionId, taskSummary: currentTaskSummary, answerSource: currentAnswerSource };
  }
  const item = recordValue(raw);
  const sessionId = String(item.session_id || currentSessionId);
  if (item.type === 'user') {
    if (isSyntheticUserRecord(item)) {
      return { sessionId, taskSummary: currentTaskSummary, answerSource: currentAnswerSource };
    }
    const message = recordValue(item.message);
    const summary = summarizeTask(textValue(message.content, 2_000));
    return { sessionId, taskSummary: summary || currentTaskSummary, answerSource: '' };
  }
  if (item.type === 'assistant') {
    const message = recordValue(item.message);
    const answer = textValue(message.content);
    return { sessionId, taskSummary: currentTaskSummary, answerSource: answer || currentAnswerSource };
  }
  if (item.type !== 'result') {
    return { sessionId, taskSummary: currentTaskSummary, answerSource: currentAnswerSource };
  }

  const subtype = String(item.subtype || 'result');
  const errorValue = item.error || item.result;
  const failed = item.is_error === true
    || item.status === 'failed'
    || subtype.includes('error')
    || item.api_error_status !== undefined && item.api_error_status !== null;
  const failureMessage = failed ? sanitizeFailureMessage(textValue(errorValue), true) : '';
  const answer = failed ? '' : textValue(item.result) || currentAnswerSource;
  const turnId = String(item.uuid || item._audit_timestamp || item.timestamp || `result-${Date.now()}`);
  const status = failed ? 'failed' : 'completed';
  return {
    sessionId,
    taskSummary: currentTaskSummary,
    answerSource: answer,
    event: {
      source_event_id: `${sessionId}:result:${turnId}`,
      source: 'claude-desktop',
      client: 'claude-desktop',
      kind: subtype,
      status,
      title: `Claude Desktop ${status === 'failed' ? 'task failed' : 'task completed'}`,
      message: failureMessage || (status === 'completed' ? 'Claude Desktop task completed' : 'Claude Desktop task failed'),
      error_code: failed ? (String(item.api_error_status || 'claude_desktop_task_failed')) : null,
      metadata: {
        session_id: sessionId,
        turn_id: turnId,
        ...(currentTaskSummary ? { task_summary: currentTaskSummary } : {}),
        ...(failureMessage ? { failure_message: failureMessage } : {}),
        ...(answer ? { answer_source: answer } : {}),
      },
    },
  };
};

@Injectable()
export class ClaudeDesktopAuditWatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ClaudeDesktopAuditWatcherService.name);
  private readonly files = new Map<string, AuditFileState>();
  private readonly startupFiles = new Set<string>();
  private watcher: FSWatcher | null = null;
  private queue = Promise.resolve();

  constructor(
    private readonly config: AppConfigService,
    private readonly channels: ChannelsService,
    private readonly ingestion: EventIngestionService,
  ) {}

  onModuleInit(): void {
    const root = this.config.claudeDesktopSessionsPath;
    if (!existsSync(root)) return;
    this.captureStartupFiles(root).forEach((path) => this.startupFiles.add(path));
    this.watcher = watch(root, {
      ignoreInitial: false,
      ignored: (path, stats) => Boolean(stats?.isFile()) && path.toLowerCase().endsWith('audit.jsonl') === false,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });
    this.watcher.on('add', (path) => {
      if (!path.toLowerCase().endsWith('audit.jsonl')) return;
      const size = statSync(path).size;
      if (this.startupFiles.delete(path)) {
        this.files.set(path, { offset: size, sessionId: '', taskSummary: '', answerSource: '' });
        return;
      }
      this.files.set(path, { offset: 0, sessionId: '', taskSummary: '', answerSource: '' });
      this.enqueue(path);
    });
    this.watcher.on('change', (path) => {
      if (path.toLowerCase().endsWith('audit.jsonl')) this.enqueue(path);
    });
    this.watcher.on('unlink', (path) => this.files.delete(path));
    this.watcher.on('error', (error) => this.logger.warn(`Claude Desktop audit watcher failed: ${String(error)}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.watcher?.close();
    await this.queue;
  }

  private enqueue(path: string): void {
    this.queue = this.queue.then(() => this.syncFile(path)).catch((error) => {
      this.logger.warn(`Unable to read Claude Desktop audit update: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private captureStartupFiles(root: string): string[] {
    const files: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile() && entry.name.toLowerCase() === 'audit.jsonl') files.push(path);
      }
    };
    visit(root);
    return files;
  }

  private syncFile(path: string): void {
    if (!existsSync(path)) return;
    const bytes = readFileSync(path);
    const current = this.files.get(path) || { offset: 0, sessionId: '', taskSummary: '', answerSource: '' };
    if (bytes.length < current.offset) current.offset = 0;
    const chunk = bytes.subarray(current.offset);
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline < 0) return;
    const complete = chunk.subarray(0, lastNewline + 1).toString('utf8');
    for (const rawLine of complete.split('\n')) {
      if (!rawLine.trim()) continue;
      const parsed = parseClaudeDesktopAuditLine(rawLine, current.sessionId, current.taskSummary, current.answerSource);
      current.sessionId = parsed.sessionId;
      current.taskSummary = parsed.taskSummary;
      current.answerSource = parsed.answerSource;
      if (!parsed.event) continue;
      const channels = this.channels.deliveryChannels();
      this.ingestion.ingest(parsed.event, channels, parsed.answerSource || undefined);
      current.answerSource = '';
    }
    current.offset += lastNewline + 1;
    this.files.set(path, current);
  }
}
