import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PlatformScannerService } from '../src/extensions/platform-scanner.service';

const stubProcessScan = (scanner: PlatformScannerService): void => {
  const internals = scanner as unknown as {
    runningProcesses: () => Set<string>;
    runningExecutablePaths: () => Set<string>;
  };
  vi.spyOn(internals, 'runningProcesses').mockReturnValue(new Set());
  vi.spyOn(internals, 'runningExecutablePaths').mockReturnValue(new Set());
};

describe('PlatformScannerService', () => {
  it('always returns a safe, complete support directory', () => {
    const scanner = new PlatformScannerService({ codexSessionsPath: '' } as never);
    stubProcessScan(scanner);
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
    stubProcessScan(scanner);
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

  it('requires the Cursor hook to name the matching runtime', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-monitor-cursor-scan-'));
    try {
      const adapterDirectory = join(directory, 'scripts', 'hooks');
      mkdirSync(adapterDirectory, { recursive: true });
      writeFileSync(join(adapterDirectory, 'cursor_event_adapter.py'), '# fixture\n');
      const configPath = join(directory, 'hooks.json');
      writeFileSync(configPath, JSON.stringify({ hooks: {
        stop: [{ type: 'command', command: 'python cursor_event_adapter.py --runtime desktop' }],
        postToolUseFailure: [{ type: 'command', command: 'python cursor_event_adapter.py --runtime desktop' }],
      } }));
      const scanner = new PlatformScannerService({ projectRoot: directory } as never);
      const configured = scanner as unknown as {
        jsonHooksConfigured: (path: string, adapter: string, events: string[], required?: string) => boolean;
      };

      expect(configured.jsonHooksConfigured(
        configPath, 'cursor_event_adapter.py', ['stop', 'postToolUseFailure'], '--runtime desktop',
      )).toBe(true);
      expect(configured.jsonHooksConfigured(
        configPath, 'cursor_event_adapter.py', ['stop', 'postToolUseFailure'], '--runtime cli',
      )).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('requires the Hermes CLI hook to assert its runtime', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-monitor-hermes-scan-'));
    try {
      const adapterDirectory = join(directory, 'scripts', 'hooks');
      mkdirSync(adapterDirectory, { recursive: true });
      writeFileSync(join(adapterDirectory, 'hermes_event_adapter.py'), '# fixture\n');
      const configPath = join(directory, 'config.yaml');
      const config = (runtime: string): string => [
        'hooks_auto_accept: true',
        'hooks:',
        '  on_session_end:',
        `    - command: python hermes_event_adapter.py${runtime}`,
        '  api_request_error:',
        `    - command: python hermes_event_adapter.py${runtime}`,
        '',
      ].join('\n');
      const scanner = new PlatformScannerService({ projectRoot: directory } as never);
      const configured = scanner as unknown as { hermesHooksConfigured: (path: string) => boolean };

      writeFileSync(configPath, config(' --runtime cli'));
      expect(configured.hermesHooksConfigured(configPath)).toBe(true);
      writeFileSync(configPath, config(''));
      expect(configured.hermesHooksConfigured(configPath)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
