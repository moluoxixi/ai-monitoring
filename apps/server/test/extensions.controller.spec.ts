import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ChannelsService } from '../src/channels/channels.service';
import { DatabaseService } from '../src/database/database.service';
import { ExtensionsController } from '../src/extensions/extensions.controller';
import { ExtensionsService } from '../src/extensions/extensions.service';
import type { ExtensionRuntimeState } from '../src/extensions/extension.types';
import { PlatformScannerService, type PlatformScanSnapshot } from '../src/extensions/platform-scanner.service';
import { UserSettingsService } from '../src/settings/user-settings.service';

const state = (detected: boolean): ExtensionRuntimeState => ({
  detected,
  cliAvailable: detected,
  running: false,
  monitorConfigured: false,
  detectionSignals: detected ? ['cli'] : [],
});

const snapshot = (
  scanStatus: PlatformScanSnapshot['scanStatus'],
  detected: string[] = [],
): PlatformScanSnapshot => {
  const platforms = Object.fromEntries([
    'codex-cli', 'codex-desktop', 'claude-cli', 'claude-desktop',
    'qoder-cli', 'qoder-desktop', 'qoder-quest', 'hermes-cli', 'hermes-desktop', 'cursor-cli', 'cursor-desktop',
  ].map((key) => [key, state(detected.includes(key))])) as Record<string, ExtensionRuntimeState>;
  return {
    scanScope: scanStatus === 'unavailable' ? 'unsupported' : 'host',
    scanStatus,
    scannedAt: '2026-08-15T00:00:00.000Z',
    device: { os: 'windows', label: 'Windows', container: false },
    platforms,
  };
};

const makeController = (current: PlatformScanSnapshot, settings: UserSettingsService) => {
  const extensions = new ExtensionsService();
  const scanner = { snapshot: vi.fn(() => current), scan: vi.fn(() => current) } as unknown as PlatformScannerService;
  const channels = { status: vi.fn(async () => []) } as unknown as ChannelsService;
  const database = { countEvents: vi.fn(() => 0) } as unknown as DatabaseService;
  return new ExtensionsController(extensions, channels, database, scanner, settings);
};

const makeSettings = () => new UserSettingsService(
  { userSettingsPath: join(mkdtempSync(join(tmpdir(), 'ai-monitor-controller-')), 'user-settings.json') } as never,
  new ExtensionsService(),
);

describe('ExtensionsController platform selection', () => {
  it('uses only reliably detected platforms for initial display and configuration', async () => {
    const controller = makeController(snapshot('reliable', ['codex-cli', 'claude-desktop']), makeSettings());
    const result = await controller.list();

    expect(result.configurableExtensions).toEqual(['codex-cli', 'claude-desktop']);
    expect(result.visibleExtensions).toEqual(['codex-cli', 'claude-desktop']);
    expect(result.scanStatus).toBe('reliable');
    expect(result.device.label).toBe('Windows');
    expect(result.visibleEventCount).toBe(0);
  });

  it('falls back to all supported platforms only when host scanning is unavailable', async () => {
    const controller = makeController(snapshot('unavailable'), makeSettings());
    const result = await controller.list();

    expect(result.configurableExtensions).toHaveLength(11);
    expect(result.visibleExtensions).toEqual(result.configurableExtensions);
  });

  it('preserves an explicit empty display preference', async () => {
    const settings = makeSettings();
    settings.updateVisibleExtensions([], settings.defaultVisibleExtensions());
    const controller = makeController(snapshot('reliable', ['codex-cli']), settings);

    const result = await controller.list();

    expect(result.visibleExtensions).toEqual([]);
  });

  it('rejects a preference outside the currently detected set', () => {
    const settings = makeSettings();
    const controller = makeController(snapshot('reliable', ['codex-cli']), settings);

    expect(() => controller.savePreferences({ visibleExtensions: ['claude-cli'] })).toThrow();
    expect(controller.savePreferences({ visibleExtensions: ['codex-cli'] })).toEqual({ visibleExtensions: ['codex-cli'] });
  });
});
