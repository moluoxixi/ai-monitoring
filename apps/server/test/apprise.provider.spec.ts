import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AppConfigService } from '../src/config/app-config.service';
import { AppriseProvider } from '../src/channels/apprise.provider';
import type { ProcessRunnerService } from '../src/channels/process-runner.service';

describe('AppriseProvider', () => {
  let root: string;
  let config: AppConfigService;
  let run: ReturnType<typeof vi.fn>;
  let provider: AppriseProvider;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ai-monitor-apprise-'));
    config = {
      projectRoot: root,
      appriseChannelsPath: join(root, 'nested', 'apprise-channels.json'),
      appriseUrls: ['wecombot://legacy-key'],
    } as AppConfigService;
    run = vi.fn(async () => 'validated');
    provider = new AppriseProvider(config, { run } as unknown as ProcessRunnerService);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('shows fixed unbound platforms and keeps legacy channels available', async () => {
    const statuses = await provider.status();
    expect(statuses).toContainEqual(expect.objectContaining({ id: 'apprise-wecom', bound: false, bindingMode: 'credential' }));
    expect(statuses).toContainEqual(expect.objectContaining({ id: 'channel-1', bound: true, bindingMode: 'none' }));
    expect(provider.availableChannels()).toEqual(['channel-1']);
  });

  it('validates through Apprise dry-run, persists locally, and never returns secrets in status', async () => {
    const values = { key: 'secret_key-123' };
    await provider.bindCredential('apprise-wecom', values);
    expect(run).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['--dry-run', 'wecombot://secret_key-123']),
      expect.objectContaining({ redact: expect.arrayContaining(['secret_key-123', 'wecombot://secret_key-123']) }),
    );
    expect(provider.availableChannels()).toEqual(['apprise-wecom', 'channel-1']);
    expect(JSON.stringify(await provider.status())).not.toContain('secret_key-123');
    expect(JSON.parse(readFileSync(config.appriseChannelsPath, 'utf8')).channels['apprise-wecom']).toEqual({ values });
  });

  it('sends through the configured URL with full redaction and supports unbind', async () => {
    await provider.bindCredential('apprise-feishu', { token: 'feishu_token-123' });
    run.mockClear();
    await provider.send('apprise-feishu', 'title', 'body');
    expect(run).toHaveBeenCalledWith(
      expect.any(String),
      ['--title', 'title', '--body', 'body', 'feishu://feishu_token-123'],
      expect.objectContaining({ redact: expect.arrayContaining(['feishu_token-123', 'feishu://feishu_token-123']) }),
    );
    expect(await provider.unbind('apprise-feishu')).toBe(true);
    expect(provider.availableChannels()).toEqual(['channel-1']);
    expect(await provider.unbind('apprise-feishu')).toBe(false);
  });

  it('does not write invalid configuration', async () => {
    await expect(provider.bindCredential('apprise-telegram', { botToken: 'invalid', chatId: 'owner' })).rejects.toThrow('格式无效');
    expect(existsSync(config.appriseChannelsPath)).toBe(false);
  });

  it('surfaces a corrupt binding file without blocking legacy channels or overwriting it', async () => {
    mkdirSync(join(root, 'nested'), { recursive: true });
    writeFileSync(config.appriseChannelsPath, '{invalid');
    const statuses = await provider.status();
    expect(statuses.find((item) => item.id === 'apprise-wecom')).toMatchObject({ bound: false, error: true });
    expect(provider.availableChannels()).toEqual(['channel-1']);
    await expect(provider.bindCredential('apprise-wecom', { key: 'valid_key' })).rejects.toThrow('配置文件损坏');
    expect(readFileSync(config.appriseChannelsPath, 'utf8')).toBe('{invalid');
  });
});
