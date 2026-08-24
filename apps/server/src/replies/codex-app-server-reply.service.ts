import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { createInterface, type Interface as ReadLineInterface } from 'node:readline';
import { AppConfigService } from '../config/app-config.service';
import type { ReplyDispatchResult } from './reply-dispatch.types';

export const CODEX_PROCESS_FACTORY = Symbol('CODEX_PROCESS_FACTORY');

export type CodexProcessFactory = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export type CodexSpawn = typeof spawn;

export interface CodexReplyDispatchInput {
  mode: 'resume' | 'fork';
  threadId: string;
  text: string;
}

export type CodexReplyDispatchResult = ReplyDispatchResult;

interface CodexProcessInvocation {
  command: string;
  args: string[];
}

const WINDOWS_COMMAND_ARG = /^[A-Za-z0-9._/-]+$/;

export const codexProcessInvocation = (
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  comSpec = process.env.ComSpec,
): CodexProcessInvocation => {
  const normalized = command.trim().toLowerCase();
  if (platform !== 'win32' || !['codex', 'codex.cmd'].includes(normalized)) {
    return { command, args: [...args] };
  }
  if (!args.every((arg) => WINDOWS_COMMAND_ARG.test(arg))) {
    throw new Error('Codex command arguments cannot be safely passed through cmd.exe');
  }
  return {
    command: comSpec?.trim() || 'cmd.exe',
    args: ['/d', '/s', '/c', ['codex.CMD', ...args].join(' ')],
  };
};

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface CompletionWaiter {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const objectValue = (value: unknown): Record<string, unknown> => value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  ? value as Record<string, unknown>
  : {};

export class CodexAppServerConnection {
  private readonly reader: ReadLineInterface;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly completions = new Map<string, Record<string, unknown>>();
  private readonly completionWaiters = new Map<string, CompletionWaiter>();
  private nextId = 1;
  private closed = false;
  private cleanedUp = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly requestTimeoutMs: number,
  ) {
    this.reader = createInterface({ input: child.stdout });
    this.reader.on('line', (line) => this.consume(line));
    this.reader.on('error', (error) => this.fail(new Error(`Codex App Server stdout failed: ${error.message}`)));
    child.stderr.on('data', () => undefined);
    child.stdin.on('error', (error) => this.fail(new Error(`Codex App Server stdin failed: ${error.message}`)));
    child.stdout.on('error', (error) => this.fail(new Error(`Codex App Server stdout failed: ${error.message}`)));
    child.stderr.on('error', (error) => this.fail(new Error(`Codex App Server stderr failed: ${error.message}`)));
    child.once('error', (error) => this.fail(new Error(`Codex App Server failed to start: ${error.message}`)));
    child.once('exit', (code, signal) => {
      if (!this.closed) this.fail(new Error(`Codex App Server exited before completion (${signal ?? code ?? 'unknown'})`));
    });
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw new Error('Codex App Server connection is closed');
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.write({ id, method, params });
    return result;
  }

  notify(method: string, params: Record<string, unknown>): void {
    if (this.closed) throw new Error('Codex App Server connection is closed');
    this.write({ method, params });
  }

  waitForTurn(turnId: string, timeoutMs: number): Promise<Record<string, unknown>> {
    const completed = this.completions.get(turnId);
    if (completed) return Promise.resolve(completed);
    if (this.closed) return Promise.reject(new Error('Codex App Server connection is closed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.completionWaiters.delete(turnId);
        reject(new Error(`Codex turn timed out: ${turnId}`));
      }, timeoutMs);
      this.completionWaiters.set(turnId, { resolve, reject, timer });
    });
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.rejectAll(new Error('Codex App Server connection closed'));
    }
    this.cleanup();
  }

  private write(payload: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private consume(line: string): void {
    let payload: Record<string, unknown>;
    try {
      payload = objectValue(JSON.parse(line));
    } catch {
      return;
    }
    if (typeof payload.id === 'number') {
      const pending = this.pending.get(payload.id);
      if (!pending) return;
      this.pending.delete(payload.id);
      clearTimeout(pending.timer);
      if (payload.error) {
        const error = objectValue(payload.error);
        pending.reject(new Error(typeof error.message === 'string' ? error.message : 'Codex App Server request failed'));
      } else {
        pending.resolve(payload.result);
      }
      return;
    }
    if (payload.method !== 'turn/completed') return;
    const turn = objectValue(objectValue(payload.params).turn);
    const turnId = typeof turn.id === 'string' ? turn.id : '';
    if (!turnId) return;
    this.completions.set(turnId, turn);
    const waiter = this.completionWaiters.get(turnId);
    if (!waiter) return;
    this.completionWaiters.delete(turnId);
    clearTimeout(waiter.timer);
    waiter.resolve(turn);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(error);
    this.cleanup();
  }

  private cleanup(): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    this.reader.close();
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.completionWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.completionWaiters.clear();
  }
}

@Injectable()
export class CodexAppServerReplyService implements OnModuleDestroy {
  private readonly logger = new Logger(CodexAppServerReplyService.name);
  private readonly active = new Set<CodexAppServerConnection>();

  constructor(
    private readonly config: AppConfigService,
    @Inject(CODEX_PROCESS_FACTORY) private readonly processFactory: CodexProcessFactory,
  ) {}

  async dispatch(input: CodexReplyDispatchInput): Promise<CodexReplyDispatchResult> {
    const child = this.processFactory(this.config.codexCommand, ['app-server'], {
      cwd: this.config.projectRoot,
      env: process.env,
      windowsHide: true,
    });
    const connection = new CodexAppServerConnection(child, this.config.codexReplyRequestTimeoutMs);
    this.active.add(connection);
    try {
      await connection.request('initialize', {
        clientInfo: { name: 'ai-monitor', title: 'AI Monitor', version: '1.0.10' },
        capabilities: {
          experimentalApi: input.mode === 'fork',
          optOutNotificationMethods: ['item/agentMessage/delta'],
        },
      });
      connection.notify('initialized', {});
      let targetThreadId = input.threadId;
      if (input.mode === 'fork') {
        const fork = objectValue(await connection.request('thread/fork', {
          threadId: input.threadId,
          ephemeral: false,
          threadSource: 'cli',
          approvalPolicy: 'never',
        }));
        const forkThread = objectValue(fork.thread);
        targetThreadId = typeof forkThread.id === 'string' ? forkThread.id.trim() : '';
        if (!targetThreadId) throw new Error('Codex App Server did not return a fork thread id');
      } else {
        await connection.request('thread/resume', { threadId: targetThreadId });
      }
      const response = objectValue(await connection.request('turn/start', {
        threadId: targetThreadId,
        input: [{ type: 'text', text: input.text }],
        approvalPolicy: 'never',
      }));
      const turnId = typeof objectValue(response.turn).id === 'string' ? objectValue(response.turn).id as string : '';
      if (!turnId) throw new Error('Codex App Server did not return a turn id');
      const writerReleased = connection.waitForTurn(turnId, this.config.codexReplyTurnTimeoutMs)
        .then(() => undefined)
        .catch((error: unknown) => {
          this.logger.warn(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          this.active.delete(connection);
          connection.close();
        });
      return {
        threadId: targetThreadId,
        turnId,
        writerReleased,
        cancel: () => connection.close(),
      };
    } catch (error) {
      this.active.delete(connection);
      connection.close();
      throw error;
    }
  }

  onModuleDestroy(): void {
    for (const connection of this.active) connection.close();
    this.active.clear();
  }
}

export const createCodexProcessFactory = (
  spawnProcess: CodexSpawn = spawn,
  platform: NodeJS.Platform = process.platform,
  comSpec = process.env.ComSpec,
): CodexProcessFactory => (command, args, options) => {
    const invocation = codexProcessInvocation(command, args, platform, comSpec);
    return spawnProcess(invocation.command, invocation.args, {
      ...options,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  };

export const defaultCodexProcessFactory = createCodexProcessFactory();
