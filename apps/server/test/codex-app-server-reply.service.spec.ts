import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../src/config/app-config.service';
import {
  CodexAppServerReplyService,
  type CodexProcessFactory,
} from '../src/replies/codex-app-server-reply.service';

const fakeProcess = (requests: Array<Record<string, unknown>>): ChildProcessWithoutNullStreams => {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, {
    stdin, stdout, stderr, exitCode: null, signalCode: null,
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
      if (typeof request.id !== 'number') continue;
      const method = request.method;
      const result = method === 'turn/start'
        ? { turn: { id: 'turn-from-qq', status: 'inProgress', items: [], error: null } }
        : method === 'thread/resume' ? { thread: { id: 'thread-original' } } : {};
      stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
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
  it('initializes, resumes the original thread, and starts a no-approval text turn', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const factory = vi.fn(() => fakeProcess(requests)) as CodexProcessFactory;
    const config = {
      codexCommand: 'codex-test', projectRoot: 'D:/project', codexReplyRequestTimeoutMs: 1_000,
      codexReplyTurnTimeoutMs: 1_000,
    } as AppConfigService;
    const service = new CodexAppServerReplyService(config, factory);

    await expect(service.dispatch('thread-original', '继续完成测试')).resolves.toEqual({
      threadId: 'thread-original', turnId: 'turn-from-qq',
    });

    expect(factory).toHaveBeenCalledWith('codex-test', ['app-server'], expect.objectContaining({ cwd: 'D:/project' }));
    expect(requests.map((request) => request.method)).toEqual([
      'initialize', 'initialized', 'thread/resume', 'turn/start',
    ]);
    expect(requests[2]).toMatchObject({ params: { threadId: 'thread-original' } });
    expect(requests[3]).toMatchObject({
      params: {
        threadId: 'thread-original',
        input: [{ type: 'text', text: '继续完成测试' }],
        approvalPolicy: 'never',
      },
    });
    service.onModuleDestroy();
  });
});
