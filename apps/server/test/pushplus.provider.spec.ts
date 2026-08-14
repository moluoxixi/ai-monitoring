import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BadRequestException } from '@nestjs/common';
import { PushPlusProvider, PUSHPLUS } from '../src/channels/pushplus.provider';
import type { AppConfigService } from '../src/config/app-config.service';
import type { ProcessRunnerService } from '../src/channels/process-runner.service';

describe('PushPlusProvider', () => {
  let root: string;
  let config: AppConfigService;
  let run: ReturnType<typeof vi.fn>;
  let provider: PushPlusProvider;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ai-monitor-pushplus-'));
    config = {
      projectRoot: root,
      pushPlusBindingPath: join(root, 'nested', 'pushplus-binding.json'),
    } as AppConfigService;
    run = vi.fn(async () => 'sent');
    provider = new PushPlusProvider(config, { run } as unknown as ProcessRunnerService);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('always exposes a fixed status item without exposing the token', async () => {
    expect(provider.availableChannels()).toEqual([]);
    expect(await provider.status()).toEqual([expect.objectContaining({
      id: PUSHPLUS,
      label: 'PushPlus',
      bound: false,
      bindingMode: 'credential',
    })]);
  });

  it('validates and atomically persists a credential', async () => {
    const token = 'a'.repeat(32);
    await expect(provider.bindCredential(PUSHPLUS, token)).resolves.toMatchObject({ bound: true });
    expect(JSON.parse(readFileSync(config.pushPlusBindingPath, 'utf8'))).toEqual({ version: 1, token });
    expect((await provider.status())[0]).toMatchObject({ bound: true });
    expect(JSON.stringify(await provider.status())).not.toContain(token);
  });

  it('rejects malformed credentials without writing a file', async () => {
    await expect(provider.bindCredential(PUSHPLUS, 'too-short')).rejects.toBeInstanceOf(BadRequestException);
    expect(existsSync(config.pushPlusBindingPath)).toBe(false);
  });

  it('sends via the Apprise CLI and redacts token and URL', async () => {
    const token = 'Token_1234567890123456789012345678';
    await provider.bindCredential(PUSHPLUS, token);
    await provider.send(PUSHPLUS, 'AI Monitor', '任务已完成');
    const url = `pushplus://${token}`;
    expect(run).toHaveBeenCalledWith(
      expect.any(String),
      ['--title', 'AI Monitor', '--body', '任务已完成', url],
      expect.objectContaining({ redact: [token, url] }),
    );
  });

  it('does not send when the binding file is invalid and supports unbind', async () => {
    mkdirSync(join(root, 'nested'), { recursive: true });
    writeFileSync(config.pushPlusBindingPath, JSON.stringify({ version: 1, token: 'invalid' }));
    expect((await provider.status())[0]).toMatchObject({ bound: false, error: true });
    await expect(provider.send(PUSHPLUS, 'title', 'body')).rejects.toThrow('not bound');
    expect(await provider.unbind(PUSHPLUS)).toBe(true);
    expect(existsSync(config.pushPlusBindingPath)).toBe(false);
    expect(await provider.unbind(PUSHPLUS)).toBe(false);
  });
});
