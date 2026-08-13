import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformsService } from '../src/platforms/platforms.service';
import type { AppConfigService } from '../src/config/app-config.service';

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('PlatformsService', () => {
  it('registers dynamic aliases and keeps one channel', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-monitor-'));
    temporary.push(root);
    const config = { clientConfigPath: join(root, 'clients.json'), phoenixUrl: 'http://127.0.0.1:6006' } as AppConfigService;
    const service = new PlatformsService(config);
    service.create('gemini', 'Gemini', ['gemini-cli']);
    service.update('gemini', 'openclaw-qq');
    service.update('gemini', 'channel-1');
    expect(service.resolve('Gemini_CLI')).toBe('gemini');
    expect(service.get('gemini').binding.channel).toBe('channel-1');
    expect(service.get('gemini').definition.integration.state).toBe('manual');
  });

  it('loads version 2 configs but drops per-platform detail URLs when saving', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-monitor-'));
    temporary.push(root);
    const clientConfigPath = join(root, 'clients.json');
    const config = { clientConfigPath, phoenixUrl: 'http://127.0.0.1:6006' } as AppConfigService;
    writeFileSync(clientConfigPath, JSON.stringify({
      version: 2,
      clients: { codex: { channel: 'channel-1', detail_url: 'https://old.invalid' } },
    }));
    const service = new PlatformsService(config);
    service.update('codex', 'channel-1');
    const saved = JSON.parse(readFileSync(clientConfigPath, 'utf8'));
    expect(saved.version).toBe(3);
    expect(saved.clients.codex.detail_url).toBeUndefined();
  });
});
