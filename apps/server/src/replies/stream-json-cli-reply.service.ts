import { Logger } from '@nestjs/common';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface, type Interface as ReadLineInterface } from 'node:readline';
import type { ReplyDispatchResult } from './reply-dispatch.types';

export type StreamJsonCliProcessFactory = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    windowsHide?: boolean;
  },
) => ChildProcessWithoutNullStreams;

export interface StreamJsonCliDispatchInput {
  sessionId: string;
  text: string;
  cwd: string;
}

export interface StreamJsonCliDispatchOptions {
  command: string;
  args: readonly string[];
  requestTimeoutMs: number;
  turnTimeoutMs: number;
  platformLabel: string;
}

export class StreamJsonCliReplyRunner {
  private readonly active = new Map<ChildProcessWithoutNullStreams, () => void>();

  constructor(
    private readonly logger: Logger,
    private readonly processFactory: StreamJsonCliProcessFactory,
  ) {}

  async dispatch(
    input: StreamJsonCliDispatchInput,
    options: StreamJsonCliDispatchOptions,
  ): Promise<ReplyDispatchResult> {
    const sessionId = input.sessionId.trim();
    if (!sessionId || sessionId === 'unknown-session') {
      throw new Error(`the original ${options.platformLabel} event does not contain a usable session id`);
    }
    const child = this.processFactory(options.command, options.args, {
      cwd: input.cwd,
      env: process.env,
      windowsHide: true,
    });
    const reader = createInterface({ input: child.stdout });
    let initSettled = false;
    let accepted = false;
    let stderr = '';
    let initTimer: ReturnType<typeof setTimeout> | undefined;
    let turnTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveWriter!: () => void;
    let writerSettled = false;
    const writerReleased = new Promise<void>((resolveWriterPromise) => {
      resolveWriter = resolveWriterPromise;
    });
    const releaseWriter = (): void => {
      if (writerSettled) return;
      writerSettled = true;
      if (turnTimer) clearTimeout(turnTimer);
      this.active.delete(child);
      resolveWriter();
    };
    this.active.set(child, releaseWriter);

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr = `${stderr}${String(chunk)}`.slice(-4_000);
    });

    const result = new Promise<ReplyDispatchResult>((resolveDispatch, rejectDispatch) => {
      let initFailure: Error | null = null;
      let initFailureFinalized = false;
      const finalizeInitFailure = (fallback: Error): void => {
        if (initFailureFinalized) return;
        initFailureFinalized = true;
        releaseWriter();
        rejectDispatch(initFailure ?? fallback);
      };
      const stopBeforeInit = (error: Error): void => {
        if (initSettled) return;
        initSettled = true;
        initFailure = error;
        if (initTimer) clearTimeout(initTimer);
        reader.close();
        try { child.kill(); } catch { /* exit/error handling owns finalization */ }
        if (child.pid === undefined) finalizeInitFailure(error);
      };
      const processFailure = (prefix: string): Error => {
        const detail = stderr.trim();
        return new Error(detail ? `${prefix}: ${detail}` : prefix);
      };

      initTimer = setTimeout(() => {
        stopBeforeInit(processFailure(`${options.platformLabel} reply fork initialization timed out`));
      }, options.requestTimeoutMs);
      initTimer.unref();

      reader.on('line', (line) => {
        if (initSettled || !line.trim()) return;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          stopBeforeInit(new Error(`${options.platformLabel} reply fork returned invalid stream-json before initialization`));
          return;
        }
        if (event === null || typeof event !== 'object' || Array.isArray(event)) return;
        const record = event as Record<string, unknown>;
        if (record.type !== 'system' || record.subtype !== 'init') return;
        const forkSessionId = typeof record.session_id === 'string' ? record.session_id.trim() : '';
        if (!forkSessionId) {
          stopBeforeInit(new Error(`${options.platformLabel} reply fork did not return a session id`));
          return;
        }
        if (forkSessionId === sessionId) {
          stopBeforeInit(new Error(`${options.platformLabel} reply fork reused the source session id`));
          return;
        }
        initSettled = true;
        accepted = true;
        if (initTimer) clearTimeout(initTimer);
        turnTimer = setTimeout(() => {
          this.logger.warn(`${options.platformLabel} reply session timed out: ${forkSessionId}`);
          child.kill();
        }, options.turnTimeoutMs);
        turnTimer.unref();
        resolveDispatch({
          threadId: forkSessionId,
          turnId: forkSessionId,
          writerReleased,
          cancel: () => { child.kill(); },
        });
      });

      child.stdin.once('error', (error) => {
        if (!accepted) stopBeforeInit(new Error(`${options.platformLabel} reply prompt failed: ${error.message}`));
      });
      child.stdout.once('error', (error) => {
        if (!accepted) stopBeforeInit(new Error(`${options.platformLabel} reply output failed: ${error.message}`));
        else {
          this.logger.warn(`${options.platformLabel} reply output failed: ${error.message}`);
          child.kill();
        }
      });
      child.stderr.once('error', (error) => {
        if (!accepted) stopBeforeInit(new Error(`${options.platformLabel} reply error stream failed: ${error.message}`));
        else {
          this.logger.warn(`${options.platformLabel} reply error stream failed: ${error.message}`);
          child.kill();
        }
      });
      child.once('error', (error) => {
        if (!accepted) {
          const failure = new Error(`${options.platformLabel} reply process failed to start: ${error.message}`);
          stopBeforeInit(failure);
          if (child.pid === undefined) finalizeInitFailure(failure);
        } else {
          this.logger.warn(`${options.platformLabel} reply process error: ${error.message}`);
        }
      });
      child.once('exit', (code, signal) => {
        if (!accepted) {
          const failure = processFailure(
            `${options.platformLabel} reply process exited before initialization (${signal ?? code ?? 'unknown'})`,
          );
          if (!initSettled) {
            initSettled = true;
            if (initTimer) clearTimeout(initTimer);
            reader.close();
          }
          finalizeInitFailure(failure);
          return;
        }
        releaseWriter();
      });

      try {
        child.stdin.end(input.text);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        stopBeforeInit(new Error(`${options.platformLabel} reply prompt failed: ${message}`));
      }
    });

    return result;
  }

  destroy(): void {
    for (const child of this.active.keys()) child.kill();
  }
}
