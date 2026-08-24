import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../src/config/app-config.service';
import {
  ClaudeCliReplyService,
  claudeProcessInvocation,
  type ClaudeProcessFactory,
} from '../src/replies/claude-cli-reply.service';

class FakeClaudeProcess extends EventEmitter {
  readonly pid = 12_345;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
}

const serviceFor = (configOverrides: Partial<AppConfigService> = {}) => {
  const child = new FakeClaudeProcess();
  let prompt = '';
  child.stdin.on('data', (chunk) => { prompt += String(chunk); });
  const factory = vi.fn(() => child as never) as unknown as ClaudeProcessFactory;
  const config = {
    claudeCommand: 'claude',
    projectRoot: 'D:\\fallback-project',
    claudeDesktopTranscriptsPath: 'D:\\missing-claude-transcripts',
    claudeReplyRequestTimeoutMs: 1_000,
    claudeReplyTurnTimeoutMs: 60_000,
    ...configOverrides,
  } as AppConfigService;
  return {
    child,
    factory,
    prompt: () => prompt,
    service: new ClaudeCliReplyService(config, factory),
  };
};

describe('ClaudeCliReplyService', () => {
  it('forks through stream-json, writes the prompt to stdin, and releases the writer on exit', async () => {
    const { child, factory, prompt, service } = serviceFor();
    const pending = service.dispatch({
      sessionId: 'source-session',
      text: 'continue without shell interpolation & echo unsafe',
      cwd: 'D:\\project-new\\AIRules',
    });

    child.stdout.write(`${JSON.stringify({
      type: 'system', subtype: 'init', session_id: 'fork-session',
    })}\n`);
    const result = await pending;

    expect(result).toMatchObject({ threadId: 'fork-session', turnId: 'fork-session' });
    expect(prompt()).toBe('continue without shell interpolation & echo unsafe');
    expect(factory).toHaveBeenCalledWith(
      'claude',
      [
        '--print', '--verbose', '--output-format', 'stream-json',
        '--resume', 'source-session', '--fork-session', '--permission-mode', 'dontAsk',
      ],
      expect.objectContaining({ cwd: 'D:\\project-new\\AIRules', windowsHide: true }),
    );
    expect(JSON.stringify(vi.mocked(factory).mock.calls[0]?.[1])).not.toContain('echo unsafe');

    let released = false;
    void result.writerReleased.then(() => { released = true; });
    await Promise.resolve();
    expect(released).toBe(false);
    child.emit('exit', 0, null);
    await result.writerReleased;
    expect(released).toBe(true);
  });

  it('uses the configured project root when event metadata has no absolute cwd', async () => {
    const { child, factory, service } = serviceFor();
    const pending = service.dispatch({ sessionId: 'source-session', text: 'continue', cwd: 'relative' });
    child.stdout.write('{"type":"system","subtype":"init","session_id":"fork-session"}\n');
    await pending;

    expect(factory).toHaveBeenCalledWith(
      'claude',
      expect.any(Array),
      expect.objectContaining({ cwd: 'D:\\fallback-project' }),
    );
    child.emit('exit', 0, null);
  });

  it('recovers cwd from a historical session transcript when metadata omits it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-monitor-claude-reply-'));
    try {
      const project = join(root, 'D--project-new--historical');
      mkdirSync(project);
      writeFileSync(join(project, 'source-session.jsonl'), [
        'not-json',
        JSON.stringify({ type: 'system', cwd: 'D:\\project-new\\historical' }),
      ].join('\n'), 'utf8');
      const { child, factory, service } = serviceFor({ claudeDesktopTranscriptsPath: root });
      const pending = service.dispatch({ sessionId: 'source-session', text: 'continue' });
      child.stdout.write('{"type":"system","subtype":"init","session_id":"fork-session"}\n');
      await pending;

      expect(factory).toHaveBeenCalledWith(
        'claude',
        expect.any(Array),
        expect.objectContaining({ cwd: 'D:\\project-new\\historical' }),
      );
      child.emit('exit', 0, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not release a cancelled writer until the process actually exits', async () => {
    const { child, service } = serviceFor();
    const pending = service.dispatch({ sessionId: 'source-session', text: 'continue' });
    child.stdout.write('{"type":"system","subtype":"init","session_id":"fork-session"}\n');
    const result = await pending;
    let released = false;
    void result.writerReleased.then(() => { released = true; });

    result.cancel?.();
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledOnce();
    expect(released).toBe(false);
    child.emit('exit', null, 'SIGTERM');
    await result.writerReleased;
    expect(released).toBe(true);
  });

  it('cleans up when writing the prompt throws synchronously', async () => {
    const { child, service } = serviceFor();
    (child.stdin as unknown as { end: (text: string) => void }).end = () => {
      throw new Error('stdin is closed');
    };

    const pending = service.dispatch({ sessionId: 'source-session', text: 'continue' });
    expect(child.kill).toHaveBeenCalledOnce();
    child.emit('exit', null, 'SIGTERM');
    await expect(pending).rejects.toThrow('Claude reply prompt failed: stdin is closed');
  });

  it.each([
    ['not-json', 'invalid stream-json'],
    ['{"type":"system","subtype":"init"}', 'did not return a session id'],
    ['{"type":"system","subtype":"init","session_id":"source-session"}', 'reused the source session id'],
  ])('rejects an invalid initialization record: %s', async (line, message) => {
    const { child, service } = serviceFor();
    const pending = service.dispatch({ sessionId: 'source-session', text: 'continue' });
    child.stdout.write(`${line}\n`);
    expect(child.kill).toHaveBeenCalled();
    let settled = false;
    void pending.catch(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit('exit', null, 'SIGTERM');
    await expect(pending).rejects.toThrow(message);
  });

  it('rejects unusable source session ids before spawning', async () => {
    const { factory, service } = serviceFor();
    await expect(service.dispatch({ sessionId: 'unknown-session', text: 'continue' }))
      .rejects.toThrow('usable session id');
    expect(factory).not.toHaveBeenCalled();
  });

  it('prefers the native Windows executable next to the Claude shim', () => {
    const native = 'D:\\code\\nvm\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
    const invocation = claudeProcessInvocation(
      'claude',
      ['--print'],
      'win32',
      'cmd.exe',
      'D:\\code\\nvm\\nodejs',
      (path) => path === native,
    );
    expect(invocation).toEqual({ command: native, args: ['--print'] });
  });

  it('uses a conservative cmd fallback without putting prompt text in arguments', () => {
    expect(claudeProcessInvocation(
      'claude', ['--resume', 'safe-session'], 'win32', 'cmd.exe', '', () => false,
    )).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'claude --resume safe-session'],
    });
    expect(() => claudeProcessInvocation(
      'claude', ['unsafe & echo'], 'win32', 'cmd.exe', '', () => false,
    )).toThrow('safely passed through cmd.exe');
  });
});
