import { describe, expect, it, vi } from 'vitest';
import { PlatformScannerService } from '../src/extensions/platform-scanner.service';

describe('PlatformScannerService', () => {
  it('always returns a safe, complete support directory', () => {
    const scanner = new PlatformScannerService({ codexSessionsPath: '' } as never);
    const result = scanner.scan();

    expect(Object.keys(result.platforms)).toEqual([
      'codex-cli', 'codex-desktop', 'claude-cli', 'claude-desktop',
      'qoder-cli', 'qoder-desktop', 'qoder-quest', 'hermes-cli', 'hermes-desktop', 'cursor-cli', 'cursor-desktop',
    ]);
    for (const state of Object.values(result.platforms)) {
      expect(typeof state.detected).toBe('boolean');
      expect(typeof state.cliAvailable).toBe('boolean');
      expect(typeof state.running).toBe('boolean');
      expect(typeof state.monitorConfigured).toBe('boolean');
      expect(state.detectionSignals.every((signal) => /^[a-z]+$/.test(signal))).toBe(true);
    }
    expect(result.scannedAt).toEqual(expect.any(String));
  });

  it('does not inspect mounted paths when the runtime is marked unsupported', () => {
    const previous = process.env.AIMONITOR_SCAN_SCOPE;
    process.env.AIMONITOR_SCAN_SCOPE = 'unsupported';
    try {
      const scanner = new PlatformScannerService({ codexSessionsPath: process.cwd() } as never);
      const result = scanner.scan();
      expect(result.scanScope).toBe('unsupported');
      expect(Object.values(result.platforms).every((state) => !state.detected && !state.monitorConfigured)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.AIMONITOR_SCAN_SCOPE;
      else process.env.AIMONITOR_SCAN_SCOPE = previous;
    }
  });

  it('does not require installed desktop CLIs to be on PATH', () => {
    const scanner = new PlatformScannerService({ codexSessionsPath: '' } as never);
    const result = scanner.scan();
    expect(result.platforms['qoder-cli']?.cliAvailable).toBe(true);
    expect(result.platforms['cursor-cli']?.cliAvailable).toBe(true);
  });

  it('distinguishes Hermes Desktop from the same-named CLI process', () => {
    const scanner = new PlatformScannerService({ codexSessionsPath: '' } as never);
    const processScanner = scanner as unknown as {
      runningProcesses: () => Set<string>;
      runningExecutablePaths: () => Set<string>;
    };
    vi.spyOn(processScanner, 'runningProcesses').mockReturnValue(new Set(['hermes.exe']));
    vi.spyOn(processScanner, 'runningExecutablePaths').mockReturnValue(new Set([
      'c:\\users\\test\\appdata\\local\\hermes\\hermes-agent\\apps\\desktop\\release\\win-unpacked\\hermes.exe',
    ]));

    const result = scanner.scan();

    expect(result.platforms['hermes-cli']?.running).toBe(false);
    expect(result.platforms['hermes-desktop']?.running).toBe(true);
  });
});
