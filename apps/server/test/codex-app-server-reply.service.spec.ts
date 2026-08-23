import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../src/config/app-config.service';
import {
  codexProcessInvocation,
  CodexAppServerReplyService,
  createCodexProcessFactory,
  type CodexProcessFactory,
} from '../src/replies/codex-app-server-reply.service';

const fakeProcess = (
  requests: Array<Record<string, unknown>>,
  respond = true,
  failMethod = '',
  failAfterResponseMethod = '',
): ChildProcessWithoutNullStreams => {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, {
    stdin, stdout, stderr, pid: 1234, exitCode: null, signalCode: null,
    kill: vi.fn(() => true),
  });
  let buffer = '';
  stdin.on('data', (chunk) => {
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const request = JSON.parse(line) as Record<string, unknown>;
      requests.push(request);
      if (!respond || typeof request.id !== 'number') continue;
      const method = request.method;
      if (method === failMethod) {
        stdout.write(`${JSON.stringify({ id: request.id, error: { message: `${method} rejected` } })}\n`);
        continue;
      }
      const result = method === 'turn/start'
        ? { turn: { id: 'turn-from-qq', status: 'inProgress', items: [], error: null } }
        : method === 'thread/fork' ? { thread: { id: 'thread-fork', forkedFromId: 'thread-original' } }
        : method === 'thread/resume' ? { thread: { id: 'thread-original' } } : {};
      stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
      if (method === failAfterResponseMethod) child.emit('error', new Error(`${method} connection lost`));
      if (method === 'turn/start') queueMicrotask(() => {
        stdout.write(`${JSON.stringify({
          method: 'turn/completed',
          params: { turn: { id: 'turn-from-qq', status: 'completed', items: [], error: null } },
        })}\n`);
      });
    }
  });
  return child;
};

describe('CodexAppServerReplyService', () => {
  it('runs the default Codex shim through cmd.exe on Windows', () => {
    expect(codexProcessInvocation('codex', ['app-server'], 'win32', 'C:\\Windows\\System32\\cmd.exe')).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'codex.CMD app-server'],
    });
    expect(codexProcessInvocation('codex', ['app-server'], 'linux')).toEqual({
      command: 'codex',
      args: ['app-server'],
    });
    expect(codexProcessInvocation('codex.CMD', ['app-server'], 'win32', '')).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'codex.CMD app-server'],
    });
    expect(codexProcessInvocation('C:\\tools\\codex.exe', ['app-server'], 'win32')).toEqual({
      command: 'C:\\tools\\codex.exe',
      args: ['app-server'],
    });

    const child = fakeProcess([], false);
    const spawnProcess = vi.fn(() => child) as unknown as typeof spawn;
    const factory = createCodexProcessFactory(spawnProcess, 'win32', 'C:\\Windows\\System32\\cmd.exe');
    const options = { cwd: 'D:/project', env: {}, windowsHide: true };

    expect(factory('codex', ['app-server'], options)).toBe(child);
    expect(spawnProcess).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', 'codex.CMD app-server'],
      { ...options, stdio: ['pipe', 'pipe', 'pipe'] },
    );
  });

  it('initializes, resumes the original thread, and starts a no-approval text turn', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const factory = vi.fn(() => fakeProcess(requests)) as CodexProcessFactory;
    const config = {
      codexCommand: 'codex-test', projectRoot: 'D:/project', codexReplyRequestTimeoutMs: 1_000,
      codexReplyTurnTimeoutMs: 1_000,
    } as AppConfigService;
    const service = new CodexAppServerReplyService(config, factory);

    const result = await service.dispatch({
      mode: 'resume', threadId: 'thread-original', text: '继续完成测试',
    });
    expect(result).toMatchObject({
      threadId: 'thread-original', turnId: 'turn-from-qq',
    });
    await result.writerReleased;

    expect(factory).toHaveBeenCalledWith('codex-test', ['app-server'], expect.objectContaining({ cwd: 'D:/project' }));
    expect(requests.map((request) => request.method)).toEqual([
      'initialize', 'initialized', 'thread/resume', 'turn/start',
    ]);
    expect(requests[2]).toMatchObject({ params: { threadId: 'thread-original' } });
    expect(requests[0]).toMatchObject({ params: { capabilities: { experimentalApi: false } } });
    expect(requests[3]).toMatchObject({
      params: {
        threadId: 'thread-original',
        input: [{ type: 'text', text: '继续完成测试' }],
        approvalPolicy: 'never',
      },
    });
    service.onModuleDestroy();
  });

  it('forks a persistent CLI-sourced thread before starting the first Desktop reply', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const factory = vi.fn(() => fakeProcess(requests)) as CodexProcessFactory;
    const config = {
      codexCommand: 'codex-test', projectRoot: 'D:/project', codexReplyRequestTimeoutMs: 1_000,
      codexReplyTurnTimeoutMs: 1_000,
    } as AppConfigService;
    const service = new CodexAppServerReplyService(config, factory);

    const result = await service.dispatch({
      mode: 'fork', threadId: 'thread-original', text: '从桌面通知继续',
    });
    expect(result).toMatchObject({ threadId: 'thread-fork', turnId: 'turn-from-qq' });
    await result.writerReleased;

    expect(requests.map((request) => request.method)).toEqual([
      'initialize', 'initialized', 'thread/fork', 'turn/start',
    ]);
    expect(requests[0]).toMatchObject({ params: { capabilities: { experimentalApi: true } } });
    expect(requests[2]).toMatchObject({
      params: {
        threadId: 'thread-original', ephemeral: false, threadSource: 'cli', approvalPolicy: 'never',
      },
    });
    expect(requests[3]).toMatchObject({
      params: {
        threadId: 'thread-fork',
        input: [{ type: 'text', text: '从桌面通知继续' }],
        approvalPolicy: 'never',
      },
    });
    expect(requests.some((request) => request.method === 'thread/resume')).toBe(false);
    service.onModuleDestroy();
  });

  it('cleans up the child process when a Desktop fork fails', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const child = fakeProcess(requests, true, 'thread/fork');
    const factory = vi.fn(() => child) as CodexProcessFactory;
    const config = {
      codexCommand: 'codex-test', projectRoot: 'D:/project', codexReplyRequestTimeoutMs: 1_000,
      codexReplyTurnTimeoutMs: 1_000,
    } as AppConfigService;
    const service = new CodexAppServerReplyService(config, factory);

    await expect(service.dispatch({
      mode: 'fork', threadId: 'thread-original', text: 'continue',
    })).rejects.toThrow('thread/fork rejected');
    expect(requests.map((request) => request.method)).toEqual(['initialize', 'initialized', 'thread/fork']);
    expect(child.stdin.writableEnded).toBe(true);
    expect(child.kill).toHaveBeenCalledOnce();
    service.onModuleDestroy();
  });

  it('releases the writer immediately when the connection closes after turn start', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const child = fakeProcess(requests, true, '', 'turn/start');
    const factory = vi.fn(() => child) as CodexProcessFactory;
    const config = {
      codexCommand: 'codex-test', projectRoot: 'D:/project', codexReplyRequestTimeoutMs: 1_000,
      codexReplyTurnTimeoutMs: 30_000,
    } as AppConfigService;
    const service = new CodexAppServerReplyService(config, factory);

    const result = await service.dispatch({ mode: 'resume', threadId: 'thread-original', text: 'continue' });
    await expect(Promise.race([
      result.writerReleased.then(() => 'released'),
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), 100)),
    ])).resolves.toBe('released');
    expect(child.kill).toHaveBeenCalledOnce();
    service.onModuleDestroy();
  });

  it('cleans up the child process when Codex fails to start', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const child = fakeProcess(requests, false);
    const factory = vi.fn(() => child) as CodexProcessFactory;
    const config = {
      codexCommand: 'codex-test', projectRoot: 'D:/project', codexReplyRequestTimeoutMs: 1_000,
      codexReplyTurnTimeoutMs: 1_000,
    } as AppConfigService;
    const service = new CodexAppServerReplyService(config, factory);

    const dispatch = service.dispatch({ mode: 'resume', threadId: 'thread-original', text: '继续完成测试' });
    child.emit('error', new Error('spawn EPERM'));

    await expect(dispatch).rejects.toThrow('Codex App Server failed to start: spawn EPERM');
    expect(child.stdin.writableEnded).toBe(true);
    expect(child.kill).toHaveBeenCalledOnce();
    service.onModuleDestroy();
  });

  it.each(['stdout', 'stderr'] as const)('cleans up when Codex %s fails', async (stream) => {
    const requests: Array<Record<string, unknown>> = [];
    const child = fakeProcess(requests, false);
    const factory = vi.fn(() => child) as CodexProcessFactory;
    const config = {
      codexCommand: 'codex-test', projectRoot: 'D:/project', codexReplyRequestTimeoutMs: 1_000,
      codexReplyTurnTimeoutMs: 1_000,
    } as AppConfigService;
    const service = new CodexAppServerReplyService(config, factory);

    const dispatch = service.dispatch({ mode: 'resume', threadId: 'thread-original', text: '继续完成测试' });
    child[stream].emit('error', new Error(`${stream} unavailable`));

    await expect(dispatch).rejects.toThrow(`Codex App Server ${stream} failed: ${stream} unavailable`);
    expect(child.stdin.writableEnded).toBe(true);
    expect(child.kill).toHaveBeenCalledOnce();
    service.onModuleDestroy();
  });
});
