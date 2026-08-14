import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserSettingsService } from '../src/settings/user-settings.service';
import { ExtensionsService } from '../src/extensions/extensions.service';

const makeConfig = (path: string) => ({ userSettingsPath: path }) as never;

describe('UserSettingsService', () => {
  it('uses defaults and atomically persists validated updates', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-monitor-settings-'));
    const path = join(root, 'nested', 'user-settings.json');
    const service = new UserSettingsService(makeConfig(path), new ExtensionsService());

    expect(service.notification()).toEqual({ taskLimit: 100, resultLimit: 2000 });
    expect(service.defaultVisibleExtensions()).toContain('qoder-quest');
    expect(service.updateNotification({ taskLimit: 321, resultLimit: 4321 })).toEqual({ taskLimit: 321, resultLimit: 4321 });
    expect(JSON.parse(readFileSync(path, 'utf8')).notification).toEqual({ taskLimit: 321, resultLimit: 4321 });
    expect(new UserSettingsService(makeConfig(path), new ExtensionsService()).snapshot().hasVisiblePreference).toBe(false);
  });

  it('persists only platform verification metadata and reloads it', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-monitor-settings-'));
    const path = join(root, 'user-settings.json');
    const service = new UserSettingsService(makeConfig(path), new ExtensionsService());

    service.markMonitorVerified('codex-cli', 'codex', '2026-08-14T00:00:00.000Z');

    expect(new UserSettingsService(makeConfig(path), new ExtensionsService()).snapshot().monitorVerification).toEqual({
      'codex-cli': {
        monitorVerified: true,
        lastVerifiedAt: '2026-08-14T00:00:00.000Z',
        verificationSource: 'codex',
      },
    });
    expect(JSON.parse(readFileSync(path, 'utf8'))).not.toHaveProperty('monitorVerification.codex-cli.prompt');
  });

  it('does not trust corrupted settings and rejects unsupported extensions', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-monitor-settings-'));
    const path = join(root, 'user-settings.json');
    writeFileSync(path, '{broken', 'utf8');
    const service = new UserSettingsService(makeConfig(path), new ExtensionsService());

    expect(service.notification()).toEqual({ taskLimit: 100, resultLimit: 2000 });
    expect(() => service.updateNotification({ taskLimit: 0 })).toThrow();
    expect(() => service.updateVisibleExtensions(['unknown'], ['codex-cli'])).toThrow();
  });

  it('persists an explicit platform selection independently', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-monitor-settings-'));
    const path = join(root, 'user-settings.json');
    const service = new UserSettingsService(makeConfig(path), new ExtensionsService());

    expect(service.updateVisibleExtensions(['cursor-desktop'], ['codex-cli', 'cursor-desktop'])).toEqual(['cursor-desktop']);
    expect(new UserSettingsService(makeConfig(path), new ExtensionsService()).snapshot()).toMatchObject({
      visibleExtensions: ['cursor-desktop'],
      hasVisiblePreference: true,
    });
  });

  it('rewrites legacy platform keys when loading settings', () => {
    const root = mkdtempSync(join(tmpdir(), 'ai-monitor-settings-'));
    const path = join(root, 'user-settings.json');
    writeFileSync(path, JSON.stringify({
      version: 1,
      notification: { taskLimit: 100, resultLimit: 2000 },
      visibleExtensions: ['codex', 'claude-code'],
      visibleExtensionsConfigured: true,
      monitorVerification: {
        codex: { monitorVerified: true, lastVerifiedAt: '2026-08-14T00:00:00.000Z', verificationSource: 'codex' },
      },
    }), 'utf8');

    const snapshot = new UserSettingsService(makeConfig(path), new ExtensionsService()).snapshot();
    expect(snapshot.visibleExtensions).toEqual(['codex-cli', 'claude-cli']);
    expect(snapshot.monitorVerification).toHaveProperty('codex-cli');
    const persisted = JSON.parse(readFileSync(path, 'utf8'));
    expect(persisted.visibleExtensions).toEqual(['codex-cli', 'claude-cli']);
    expect(persisted.monitorVerification).not.toHaveProperty('codex');
  });
});
