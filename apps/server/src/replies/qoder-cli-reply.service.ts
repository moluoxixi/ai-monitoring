import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { AppConfigService } from '../config/app-config.service';
import type { ReplyDispatchResult } from './reply-dispatch.types';
import { StreamJsonCliReplyRunner, type StreamJsonCliProcessFactory } from './stream-json-cli-reply.service';

export const QODER_PROCESS_FACTORY = Symbol('QODER_PROCESS_FACTORY');
export type QoderProcessFactory = StreamJsonCliProcessFactory;
export type QoderSpawn = typeof spawn;

export interface QoderReplyDispatchInput { sessionId: string; text: string; cwd?: string; }

const WINDOWS_COMMAND_ARG = /^[A-Za-z0-9._:/\\-]+$/;

export const qoderProcessInvocation = (
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  comSpec = process.env.ComSpec,
): { command: string; args: string[] } => {
  if (platform !== 'win32' || !['qoder', 'qodercli', 'qoder.cmd', 'qodercli.cmd'].includes(basename(command).toLowerCase())) {
    return { command, args: [...args] };
  }
  if (!command.toLowerCase().endsWith('.cmd')) return { command, args: [...args] };
  if (!args.every((arg) => WINDOWS_COMMAND_ARG.test(arg))) throw new Error('Qoder command arguments cannot be safely passed through cmd.exe');
  const commandToken = /\s/.test(command) ? `"${command}"` : command;
  return { command: comSpec?.trim() || 'cmd.exe', args: ['/d', '/s', '/c', [commandToken, ...args].join(' ')] };
};

export const createQoderProcessFactory = (
  spawnProcess: QoderSpawn = spawn,
  platform: NodeJS.Platform = process.platform,
  comSpec = process.env.ComSpec,
): QoderProcessFactory => (command, args, options) => {
  const invocation = qoderProcessInvocation(command, args, platform, comSpec);
  return spawnProcess(invocation.command, invocation.args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
};

@Injectable()
export class QoderCliReplyService implements OnModuleDestroy {
  private readonly runner: StreamJsonCliReplyRunner;

  constructor(
    private readonly config: AppConfigService,
    @Inject(QODER_PROCESS_FACTORY) processFactory: QoderProcessFactory,
  ) { this.runner = new StreamJsonCliReplyRunner(new Logger(QoderCliReplyService.name), processFactory); }

  dispatch(input: QoderReplyDispatchInput): Promise<ReplyDispatchResult> {
    const sessionId = input.sessionId.trim();
    return this.runner.dispatch({ sessionId, text: input.text, cwd: this.resolveReplyCwd(input.cwd, sessionId) }, {
      command: this.config.qoderCommand,
      args: ['--print', '--verbose', '--output-format', 'stream-json', '--resume', sessionId, '--fork-session', '--permission-mode', 'dont_ask'],
      requestTimeoutMs: this.config.qoderReplyRequestTimeoutMs,
      turnTimeoutMs: this.config.qoderReplyTurnTimeoutMs,
      platformLabel: 'Qoder',
    });
  }

  onModuleDestroy(): void { this.runner.destroy(); }

  private resolveReplyCwd(configuredCwd: string | undefined, sessionId: string): string {
    const normalized = configuredCwd?.trim();
    if (normalized && isAbsolute(normalized)) return resolve(normalized);
    if (/^[A-Za-z0-9._-]+$/.test(sessionId)) {
      try {
        const find = (directory: string): string => {
          for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
              const found = find(path);
              if (found) return found;
            } else if (entry.isFile() && entry.name.toLowerCase() === `${sessionId}.jsonl`.toLowerCase()) {
              for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
                try {
                  const item = JSON.parse(line) as Record<string, unknown>;
                  if (typeof item.cwd === 'string' && isAbsolute(item.cwd.trim())) return resolve(item.cwd.trim());
                } catch { /* malformed historical line */ }
              }
            }
          }
          return '';
        };
        const found = find(this.config.qoderSessionsPath);
        if (found) return found;
      } catch { /* use project-root compatibility fallback */ }
    }
    return this.config.projectRoot;
  }
}

export const defaultQoderProcessFactory = createQoderProcessFactory();
