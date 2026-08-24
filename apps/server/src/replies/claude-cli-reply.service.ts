import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { AppConfigService } from '../config/app-config.service';
import type { ReplyDispatchResult } from './reply-dispatch.types';
import { StreamJsonCliReplyRunner, type StreamJsonCliProcessFactory } from './stream-json-cli-reply.service';

export const CLAUDE_PROCESS_FACTORY = Symbol('CLAUDE_PROCESS_FACTORY');
export type ClaudeProcessFactory = StreamJsonCliProcessFactory;
export type ClaudeSpawn = typeof spawn;

export interface ClaudeReplyDispatchInput { sessionId: string; text: string; cwd?: string; }
export interface ClaudeProcessInvocation { command: string; args: string[]; }

const WINDOWS_COMMAND_ARG = /^[A-Za-z0-9._:/\\-]+$/;
const CLAUDE_NATIVE_RELATIVE_PATH = join('node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');

const nativeClaudeExecutable = (command: string, pathValue: string | undefined, fileExists: (path: string) => boolean): string | null => {
  if (basename(command).toLowerCase() === 'claude.exe') return command;
  const commandDirectory = dirname(command);
  if (commandDirectory !== '.') {
    const adjacent = join(commandDirectory, CLAUDE_NATIVE_RELATIVE_PATH);
    if (fileExists(adjacent)) return adjacent;
  }
  for (const directory of String(pathValue || '').split(';').map((value) => value.trim()).filter(Boolean)) {
    const direct = join(directory, 'claude.exe');
    if (fileExists(direct)) return direct;
    const adjacent = join(directory, CLAUDE_NATIVE_RELATIVE_PATH);
    if (fileExists(adjacent)) return adjacent;
  }
  return null;
};

export const claudeProcessInvocation = (
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  comSpec = process.env.ComSpec,
  pathValue = process.env.PATH,
  fileExists: (path: string) => boolean = existsSync,
): ClaudeProcessInvocation => {
  if (platform !== 'win32') return { command, args: [...args] };
  const native = nativeClaudeExecutable(command, pathValue, fileExists);
  if (native) return { command: native, args: [...args] };
  const normalized = basename(command).trim().toLowerCase();
  if (!['claude', 'claude.cmd'].includes(normalized)) return { command, args: [...args] };
  if (!args.every((arg) => WINDOWS_COMMAND_ARG.test(arg))) throw new Error('Claude command arguments cannot be safely passed through cmd.exe');
  const commandToken = /\s/.test(command) ? `"${command}"` : command;
  return { command: comSpec?.trim() || 'cmd.exe', args: ['/d', '/s', '/c', [commandToken, ...args].join(' ')] };
};

export const createClaudeProcessFactory = (
  spawnProcess: ClaudeSpawn = spawn,
  platform: NodeJS.Platform = process.platform,
  comSpec = process.env.ComSpec,
  pathValue = process.env.PATH,
): ClaudeProcessFactory => (command, args, options) => {
  const invocation = claudeProcessInvocation(command, args, platform, comSpec, pathValue);
  return spawnProcess(invocation.command, invocation.args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
};

@Injectable()
export class ClaudeCliReplyService implements OnModuleDestroy {
  private readonly runner: StreamJsonCliReplyRunner;

  constructor(
    private readonly config: AppConfigService,
    @Inject(CLAUDE_PROCESS_FACTORY) processFactory: ClaudeProcessFactory,
  ) { this.runner = new StreamJsonCliReplyRunner(new Logger(ClaudeCliReplyService.name), processFactory); }

  dispatch(input: ClaudeReplyDispatchInput): Promise<ReplyDispatchResult> {
    const sessionId = input.sessionId.trim();
    return this.runner.dispatch({ sessionId, text: input.text, cwd: this.resolveReplyCwd(input.cwd, sessionId) }, {
      command: this.config.claudeCommand,
      args: ['--print', '--verbose', '--output-format', 'stream-json', '--resume', sessionId, '--fork-session', '--permission-mode', 'dontAsk'],
      requestTimeoutMs: this.config.claudeReplyRequestTimeoutMs,
      turnTimeoutMs: this.config.claudeReplyTurnTimeoutMs,
      platformLabel: 'Claude',
    });
  }

  onModuleDestroy(): void { this.runner.destroy(); }

  private resolveReplyCwd(configuredCwd: string | undefined, sessionId: string): string {
    const normalized = configuredCwd?.trim();
    if (normalized && isAbsolute(normalized)) return resolve(normalized);
    if (/^[A-Za-z0-9._-]+$/.test(sessionId)) {
      try {
        for (const entry of readdirSync(this.config.claudeDesktopTranscriptsPath, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const transcriptPath = join(this.config.claudeDesktopTranscriptsPath, entry.name, `${sessionId}.jsonl`);
          if (!existsSync(transcriptPath)) continue;
          for (const line of readFileSync(transcriptPath, 'utf8').split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
              const item = JSON.parse(line) as unknown;
              if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
              const cwd = (item as Record<string, unknown>).cwd;
              if (typeof cwd === 'string' && cwd.trim() && isAbsolute(cwd.trim())) return resolve(cwd.trim());
            } catch { /* malformed historical line */ }
          }
        }
      } catch { /* use project-root compatibility fallback */ }
    }
    return this.config.projectRoot;
  }
}

export const defaultClaudeProcessFactory = createClaudeProcessFactory();
