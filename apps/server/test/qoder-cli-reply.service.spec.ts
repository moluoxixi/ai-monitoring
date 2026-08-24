import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../src/config/app-config.service';
import {
  QoderCliReplyService,
  qoderProcessInvocation,
  type QoderProcessFactory,
} from '../src/replies/qoder-cli-reply.service';

class FakeQoderProcess extends EventEmitter {
  readonly pid = 23_456;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
}

const serviceFor = (configOverrides: Partial<AppConfigService> = {}) => {
  const child = new FakeQoderProcess();
  let prompt = '';
  child.stdin.on('data', (chunk) => { prompt += String(chunk); });
  const factory = vi.fn(() => child as never) as unknown as QoderProcessFactory;
  const config = {
    qoderCommand: 'qodercli',
    projectRoot: 'D:\\fallback-project',
    qoderSessionsPath: 'D:\\missing-qoder-sessions',
    qoderReplyRequestTimeoutMs: 1_000,
    qoderReplyTurnTimeoutMs: 60_000,
    ...configOverrides,
  } as AppConfigService;
  return { child, factory, prompt: () => prompt, service: new QoderCliReplyService(config, factory) };
};

describe('QoderCliReplyService', () => {
  it('forks through stream-json and keeps the prompt out of argv', async () => {
    const { child, factory, prompt, service } = serviceFor();
    const pending = service.dispatch({
      sessionId: 'source-session',
      text: 'continue & echo unsafe',
      cwd: 'D:\\project-new\\qoder-project',
    });
    child.stdout.write('{"type":"system","subtype":"init","session_id":"fork-session"}\n');
    const result = await pending;

    expect(result).toMatchObject({ threadId: 'fork-session', turnId: 'fork-session' });
    expect(prompt()).toBe('continue & echo unsafe');
    expect(factory).toHaveBeenCalledWith('qodercli', [
      '--print', '--verbose', '--output-format', 'stream-json',
      '--resume', 'source-session', '--fork-session', '--permission-mode', 'dont_ask',
    ], expect.objectContaining({ cwd: 'D:\\project-new\\qoder-project', windowsHide: true }));
    expect(JSON.stringify(vi.mocked(factory).mock.calls[0]?.[1])).not.toContain('echo unsafe');
    child.emit('exit', 0, null);
    await result.writerReleased;
  });

  it('recovers cwd recursively from a Qoder transcript', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-monitor-qoder-reply-'));
    try {
      const project = join(root, 'D--project-new--qoder');
      const transcript = join(project, 'transcript');
      mkdirSync(transcript, { recursive: true });
      writeFileSync(join(transcript, 'source-session.jsonl'), [
        'not-json',
        JSON.stringify({ type: 'session_meta', cwd: 'D:\\project-new\\qoder' }),
      ].join('\n'), 'utf8');
      const { child, factory, service } = serviceFor({ qoderSessionsPath: root });
      const pending = service.dispatch({ sessionId: 'source-session', text: 'continue' });
      child.stdout.write('{"type":"system","subtype":"init","session_id":"fork-session"}\n');
      await pending;
      expect(factory).toHaveBeenCalledWith(
        'qodercli', expect.any(Array), expect.objectContaining({ cwd: 'D:\\project-new\\qoder' }),
      );
      child.emit('exit', 0, null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects invalid init output and unusable source session ids', async () => {
    const { child, factory, service } = serviceFor();
    const invalid = service.dispatch({ sessionId: 'source-session', text: 'continue' });
    child.stdout.write('not-json\n');
    expect(child.kill).toHaveBeenCalledOnce();
    let settled = false;
    void invalid.catch(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit('exit', null, 'SIGTERM');
    await expect(invalid).rejects.toThrow('Qoder reply fork returned invalid stream-json');

    const second = serviceFor();
    await expect(second.service.dispatch({ sessionId: 'unknown-session', text: 'continue' }))
      .rejects.toThrow('usable session id');
    expect(second.factory).not.toHaveBeenCalled();
  });

  it('spawns the native Windows qodercli executable directly', () => {
    expect(qoderProcessInvocation(
      'C:\\Users\\wl\\.qoder\\bin\\qodercli\\qodercli.exe',
      ['--resume', 'safe-session'],
      'win32',
      'cmd.exe',
    )).toEqual({
      command: 'C:\\Users\\wl\\.qoder\\bin\\qodercli\\qodercli.exe',
      args: ['--resume', 'safe-session'],
    });
  });
});
