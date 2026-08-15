import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PlatformScannerService } from '../src/extensions/platform-scanner.service';

const stubProcessScan = (scanner: PlatformScannerService): void => {
  const internals = scanner as unknown as {
    runningProcesses: () => { value: Set<string>; available: boolean };
    runningExecutablePaths: () => { value: Set<string>; available: boolean };
  };
  vi.spyOn(internals, 'runningProcesses').mockReturnValue({ value: new Set(), available: true });
  vi.spyOn(internals, 'runningExecutablePaths').mockReturnValue({ value: new Set(), available: true });
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
    expect(['reliable', 'degraded', 'unavailable']).toContain(result.scanStatus);
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

  it('falls back to an unavailable scan when the host probe itself throws', () => {
    const scanner = new PlatformScannerService({ codexSessionsPath: '' } as never);
    const internals = scanner as unknown as { runningProcesses: () => unknown };
    vi.spyOn(internals, 'runningProcesses').mockImplementation(() => { throw new Error('tasklist unavailable'); });

    const result = scanner.scan();

    expect(result.scanStatus).toBe('unavailable');
    expect(Object.values(result.platforms).every((platform) => !platform.detected)).toBe(true);
  });

  it('detects an exact CLI executable without treating a desktop launcher as a CLI', () => {
    const scanner = new PlatformScannerService({ codexSessionsPath: '' } as never);
    stubProcessScan(scanner);
    const result = scanner.scan();
    expect(result.platforms['qoder-cli']?.cliAvailable).toBe(true);
    expect(result.platforms['cursor-cli']?.cliAvailable).toBe(false);
  });

  it('distinguishes Hermes Desktop from the same-named CLI process', () => {
    const scanner = new PlatformScannerService({ codexSessionsPath: '' } as never);
    const processScanner = scanner as unknown as {
      runningProcesses: () => { value: Set<string>; available: boolean };
      runningExecutablePaths: () => { value: Set<string>; available: boolean };
    };
    vi.spyOn(processScanner, 'runningProcesses').mockReturnValue({ value: new Set(['hermes.exe']), available: true });
    vi.spyOn(processScanner, 'runningExecutablePaths').mockReturnValue({
      value: new Set([
        'c:\\users\\test\\appdata\\local\\hermes\\hermes-agent\\apps\\desktop\\release\\win-unpacked\\hermes.exe',
      ]),
      available: true,
    });

    const result = scanner.scan();

    expect(result.platforms['hermes-cli']?.running).toBe(false);
    expect(result.platforms['hermes-desktop']?.running).toBe(true);
  });

  it('scans macOS and keeps CLI/Desktop detection independent', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    try {
      const scanner = new PlatformScannerService({ codexSessionsPath: '' } as never);
      const internals = scanner as unknown as {
        commandAvailable: (command: string) => { value: boolean; available: boolean };
        runningProcesses: () => { value: Set<string>; available: boolean };
        runningExecutablePaths: () => { value: Set<string>; available: boolean };
      };
      vi.spyOn(internals, 'commandAvailable').mockImplementation((command) => ({ value: command === 'codex', available: true }));
      vi.spyOn(internals, 'runningProcesses').mockReturnValue({ value: new Set(['hermes']), available: true });
      vi.spyOn(internals, 'runningExecutablePaths').mockReturnValue({
        value: new Set(['/Applications/Hermes.app/Contents/MacOS/Hermes']),
        available: true,
      });

      const result = scanner.scan();

      expect(result.scanScope).toBe('host');
      expect(result.scanStatus).toBe('reliable');
      expect(result.device).toEqual({ os: 'macos', label: 'macOS', container: false });
      expect(result.platforms['codex-cli']?.cliAvailable).toBe(true);
      expect(result.platforms['codex-desktop']?.detected).toBe(false);
      expect(result.platforms['hermes-cli']?.running).toBe(false);
      expect(result.platforms['hermes-desktop']?.running).toBe(true);
    } finally {
      platform.mockRestore();
    }
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
