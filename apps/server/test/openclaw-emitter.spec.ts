import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = resolve(process.cwd(), '../..');
const emitterPath = join(projectRoot, 'scripts', 'openclaw-emit-notification.mjs');
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function createOutboundPath(): { outboundDir: string; messagePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'ai-monitor-emitter-'));
  temporary.push(root);
  const outboundDir = join(root, 'openclaw-outbound');
  mkdirSync(outboundDir, { recursive: true });
  return { outboundDir, messagePath: join(outboundDir, 'notification-test.txt') };
}

describe('openclaw notification emitter', () => {
  it('reads and removes a payload from the explicit outbound directory', () => {
    const { outboundDir, messagePath } = createOutboundPath();
    writeFileSync(messagePath, 'title\n\nbody', 'utf8');

    const result = spawnSync(process.execPath, [emitterPath, outboundDir, messagePath], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('title\n\nbody');
    expect(result.stderr).toBe('');
    expect(existsSync(messagePath)).toBe(false);
  });

  it('reports a missing payload without a Node internal stack trace', () => {
    const { outboundDir, messagePath } = createOutboundPath();

    const result = spawnSync(process.execPath, [emitterPath, outboundDir, messagePath], { encoding: 'utf8' });

    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('AI_MONITOR_NOTIFICATION_PAYLOAD_MISSING\n');
    expect(result.stderr).not.toContain('node:internal');
  });

  it('rejects paths outside the declared outbound directory without reading them', () => {
    const { outboundDir } = createOutboundPath();
    const externalPath = join(outboundDir, '..', 'notification-external.txt');
    writeFileSync(externalPath, 'secret', 'utf8');

    const result = spawnSync(process.execPath, [emitterPath, outboundDir, externalPath], { encoding: 'utf8' });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('AI_MONITOR_NOTIFICATION_ARGUMENT_INVALID\n');
    expect(existsSync(externalPath)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('rejects a payload symlink that points outside the outbound directory', () => {
    const { outboundDir, messagePath } = createOutboundPath();
    const externalPath = join(outboundDir, '..', 'external.txt');
    writeFileSync(externalPath, 'secret', 'utf8');
    symlinkSync(externalPath, messagePath);

    const result = spawnSync(process.execPath, [emitterPath, outboundDir, messagePath], { encoding: 'utf8' });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('AI_MONITOR_NOTIFICATION_ARGUMENT_INVALID\n');
    expect(existsSync(externalPath)).toBe(true);
  });
});
