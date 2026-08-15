import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { AppConfigService } from '../config/app-config.service';
import type { DeviceInfo, ExtensionRuntimeState } from './extension.types';

export interface PlatformScanSnapshot {
  scanScope: 'host' | 'unsupported';
  scanStatus: 'reliable' | 'degraded' | 'unavailable';
  scannedAt: string | null;
  device: DeviceInfo;
  platforms: Record<string, ExtensionRuntimeState>;
}

type ProbeResult<T> = { value: T; available: boolean };

type Probe = {
  commands: string[];
  executables: string[];
  processNames: string[];
  processPathFragments?: string[];
  detectionPaths?: string[];
  appxPackageNames?: string[];
  installedProductNames?: string[];
  monitorPaths: string[];
  monitorKind: 'sessions' | 'hooks' | 'audit' | 'config';
};

const EMPTY_STATE: ExtensionRuntimeState = {
  detected: false,
  cliAvailable: false,
  running: false,
  monitorConfigured: false,
  detectionSignals: [],
};

const envPath = (root: string | undefined, ...segments: string[]): string => root ? join(root, ...segments) : '';
const actualContainerMarker = (): boolean => Boolean(
  process.env.DOCKER_CONTAINER === 'true'
  || process.env.CONTAINER === 'true'
  || existsSync('/.dockerenv')
  || existsSync('/run/.containerenv'),
);
const containerMarker = (): boolean => Boolean(process.env.AIMONITOR_SCAN_SCOPE === 'unsupported' || actualContainerMarker());

const supportedKeys = [
  'codex-cli', 'codex-desktop', 'claude-cli', 'claude-desktop',
  'qoder-cli', 'qoder-desktop', 'qoder-quest', 'hermes-cli', 'hermes-desktop',
  'cursor-cli', 'cursor-desktop',
];

const emptyPlatforms = (): Record<string, ExtensionRuntimeState> => Object.fromEntries(
  supportedKeys.map((key) => [key, { ...EMPTY_STATE, detectionSignals: [] }]),
);

const normalizePath = (value: string): string => value.replace(/\\/g, '/').toLowerCase();

const deviceInfo = (): DeviceInfo => {
  const os = process.platform === 'win32' ? 'windows'
    : process.platform === 'darwin' ? 'macos'
      : process.platform === 'linux' ? 'linux' : 'other';
  return {
    os,
    label: os === 'windows' ? 'Windows' : os === 'macos' ? 'macOS' : os === 'linux' ? 'Linux' : '其他设备',
    container: actualContainerMarker(),
  };
};

const createProbes = (platform: NodeJS.Platform): Record<string, Probe> => {
  const mac = platform === 'darwin';
  const localAppData = mac ? join(homedir(), 'Library', 'Application Support') : process.env.LOCALAPPDATA;
  const app = (name: string, binary: string): string[] => mac
    ? [join('/Applications', `${name}.app`, 'Contents', 'MacOS', binary), join(homedir(), 'Applications', `${name}.app`, 'Contents', 'MacOS', binary)]
    : [envPath(localAppData, 'Programs', name, `${binary}.exe`)];
  const appFragment = (name: string): string[] => mac
    ? [`/applications/${name.toLowerCase()}.app/contents/macos/`]
    : [`/windowsapps/${name.toLowerCase()}_`];
  const appSupport = (...segments: string[]): string => join(localAppData || '', ...segments);

  return {
  'codex-cli': {
    // codex.exe is also spawned by Codex Desktop; PATH is the only reliable
    // CLI signal here, so never classify that shared process as the CLI.
    commands: ['codex'], executables: [], processNames: [],
    detectionPaths: [],
    monitorPaths: [join(homedir(), '.codex', 'config.toml')], monitorKind: 'hooks',
  },
  'codex-desktop': {
    commands: [], executables: app('Codex', 'Codex'),
    processNames: mac ? ['codex'] : [], processPathFragments: appFragment('openai.codex'),
    appxPackageNames: mac ? [] : ['openai.codex'],
    monitorPaths: [], monitorKind: 'sessions',
  },
  'claude-cli': {
    commands: ['claude'], executables: [], processNames: [], detectionPaths: [],
    monitorPaths: [join(homedir(), '.claude', 'settings.json')],
    monitorKind: 'hooks',
  },
  'claude-desktop': {
    commands: [], executables: app('Claude', 'Claude'), processNames: mac ? ['claude'] : ['claude.exe'],
    processPathFragments: appFragment('claude'), appxPackageNames: mac ? [] : ['claude'],
    monitorPaths: [], monitorKind: 'audit',
  },
  'qoder-cli': {
    commands: ['qoder'], executables: [join(homedir(), '.qoder', 'bin', 'qodercli', mac ? 'qodercli' : 'qodercli.exe')], processNames: [],
    detectionPaths: [],
    monitorPaths: [join(homedir(), '.qoder', 'settings.json')],
    monitorKind: 'hooks',
  },
  'qoder-desktop': {
    commands: [], executables: app('Qoder', 'Qoder'), processNames: mac ? ['qoder'] : ['qoder.exe'],
    processPathFragments: appFragment('qoder'), installedProductNames: mac ? [] : ['qoder ide (user)'],
    monitorPaths: [join(homedir(), '.qoder', 'settings.json')], monitorKind: 'hooks',
  },
  'qoder-quest': {
    // Quest sessions are not distinguishable from the desktop process by
    // executable name. Never report a generic qoder.exe as Quest.
    commands: [], executables: [], processNames: [],
    detectionPaths: [mac ? appSupport('Qoder', 'logs') : envPath(process.env.APPDATA, 'Qoder', 'logs')],
    monitorPaths: [join(homedir(), '.qoder', 'settings.json')], monitorKind: 'hooks',
  },
  'hermes-cli': {
    commands: ['hermes'], executables: [mac ? join(homedir(), '.hermes', 'bin', 'hermes') : envPath(process.env.LOCALAPPDATA, 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe')], processNames: [],
    processPathFragments: mac ? ['/.hermes/bin/hermes'] : ['\\hermes-agent\\venv\\scripts\\hermes.exe'],
    monitorPaths: [mac ? join(homedir(), 'Library', 'Application Support', 'hermes', 'config.yaml') : envPath(process.env.LOCALAPPDATA, 'hermes', 'config.yaml'), join(homedir(), '.hermes', 'config.yaml')],
    monitorKind: 'config',
  },
  'hermes-desktop': {
    commands: [], executables: mac
      ? app('Hermes', 'Hermes')
      : [envPath(process.env.LOCALAPPDATA, 'Programs', 'Hermes', 'Hermes.exe'), envPath(process.env.LOCALAPPDATA, 'hermes', 'hermes-agent', 'apps', 'desktop', 'release', 'win-unpacked', 'Hermes.exe')],
    processNames: mac ? ['hermes'] : [],
    processPathFragments: mac ? appFragment('hermes') : ['\\hermes-agent\\apps\\desktop\\', '\\programs\\hermes\\hermes.exe'],
    monitorPaths: [
      mac ? appSupport('hermes', 'state.db') : envPath(process.env.LOCALAPPDATA, 'hermes', 'state.db'),
      mac ? appSupport('hermes', 'sessions') : envPath(process.env.LOCALAPPDATA, 'hermes', 'sessions'),
    ],
    monitorKind: 'sessions',
  },
  'cursor-cli': {
    commands: ['agent', 'cursor-agent'], executables: [], processNames: [],
    monitorPaths: [join(homedir(), '.cursor', 'hooks.json')], monitorKind: 'hooks',
  },
  'cursor-desktop': {
    commands: [], executables: app('Cursor', 'Cursor'), processNames: mac ? ['cursor'] : ['cursor.exe'],
    processPathFragments: appFragment('cursor'), installedProductNames: mac ? [] : ['cursor (user)'],
    monitorPaths: [join(homedir(), '.cursor', 'hooks.json')],
    monitorKind: 'hooks',
  },
  };
};

@Injectable()
export class PlatformScannerService implements OnModuleInit {
  private readonly logger = new Logger(PlatformScannerService.name);
  private snapshotValue: PlatformScanSnapshot = {
    scanScope: ['win32', 'darwin'].includes(process.platform) && !containerMarker() ? 'host' : 'unsupported',
    scanStatus: 'unavailable',
    scannedAt: null,
    device: deviceInfo(),
    platforms: emptyPlatforms(),
  };

  constructor(private readonly config: AppConfigService) {
    void this.config;
  }

  onModuleInit(): void {
    this.scan();
  }

  snapshot(): PlatformScanSnapshot {
    return {
      ...this.snapshotValue,
      device: { ...this.snapshotValue.device },
      platforms: Object.fromEntries(Object.entries(this.snapshotValue.platforms).map(([key, state]) => [key, {
        ...state,
        detectionSignals: [...state.detectionSignals],
      }])),
    };
  }

  scan(): PlatformScanSnapshot {
    const supportedHost = ['win32', 'darwin'].includes(process.platform) && !containerMarker();
    if (!supportedHost) {
      this.snapshotValue = {
        scanScope: 'unsupported',
        scanStatus: 'unavailable',
        scannedAt: new Date().toISOString(),
        device: deviceInfo(),
        platforms: emptyPlatforms(),
      };
      return this.snapshot();
    }
    try {
      const probes = createProbes(process.platform);
      let degraded = false;
      const runningResult = this.runningProcesses();
      const runningPathsResult = this.runningExecutablePaths();
      const appxResult = this.installedAppxPackages();
      const productResult = this.installedProducts();
      degraded ||= !runningResult.available || !runningPathsResult.available || !appxResult.available || !productResult.available;
      const running = runningResult.value;
      const runningPaths = runningPathsResult.value;
      const next: Record<string, ExtensionRuntimeState> = {};
      for (const [key, probe] of Object.entries(probes)) {
        try {
          const commandResults = probe.commands.map((command) => this.commandAvailable(command));
          degraded ||= commandResults.some((result) => !result.available);
          const commandAvailable = commandResults.some((result) => result.value);
          const executableFound = probe.executables.some((path) => Boolean(path) && existsSync(path));
          const runningNow = probe.processPathFragments?.length
            ? probe.processPathFragments.some((fragment) => [...runningPaths].some((path) => normalizePath(path).includes(normalizePath(fragment))))
            : probe.processNames.some((name) => running.has(name.toLowerCase()));
          const detectionPathFound = probe.detectionPaths?.some((path) => Boolean(path) && existsSync(path)) || false;
          const appxPackageFound = probe.appxPackageNames?.some((name) => appxResult.value.has(name.toLowerCase())) || false;
          const installedProductFound = probe.installedProductNames?.some((name) => productResult.value.has(name.toLowerCase())) || false;
          const monitorConfigured = key === 'codex-desktop'
            ? this.hasSessionFile(this.config.codexSessionsPath)
            : this.monitorConfigured(key, probe);
          const detectionSignals = [
            ...((key.endsWith('-cli') && (commandAvailable || executableFound)) ? ['cli'] : []),
            ...((!key.endsWith('-cli') && (executableFound || appxPackageFound || installedProductFound)) ? ['installed'] : []),
            ...(runningNow ? ['running'] : []),
            ...(detectionPathFound ? ['activity'] : []),
            ...(monitorConfigured ? [probe.monitorKind] : []),
          ];
          const detected = key.endsWith('-cli')
            ? commandAvailable || executableFound || runningNow
            : executableFound || appxPackageFound || installedProductFound || runningNow || detectionPathFound;
          next[key] = {
            detected,
            cliAvailable: key.endsWith('-cli') && (commandAvailable || executableFound),
            running: runningNow,
            monitorConfigured,
            detectionSignals: [...new Set(detectionSignals)],
          };
        } catch (error) {
          this.logger.warn(`Platform probe failed for ${key}: ${error instanceof Error ? error.message : String(error)}`);
          degraded = true;
          next[key] = { ...EMPTY_STATE, detectionSignals: [] };
        }
      }
      this.snapshotValue = {
        scanScope: 'host',
        scanStatus: degraded ? 'degraded' : 'reliable',
        scannedAt: new Date().toISOString(),
        device: deviceInfo(),
        platforms: next,
      };
      return this.snapshot();
    } catch (error) {
      this.logger.warn(`Platform scan unavailable: ${error instanceof Error ? error.message : String(error)}`);
      this.snapshotValue = {
        scanScope: 'host',
        scanStatus: 'unavailable',
        scannedAt: new Date().toISOString(),
        device: deviceInfo(),
        platforms: emptyPlatforms(),
      };
      return this.snapshot();
    }
  }

  private commandAvailable(command: string): ProbeResult<boolean> {
    try {
      const executable = process.platform === 'win32' ? 'where.exe' : 'which';
      execFileSync(executable, [command], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      return { value: true, available: true };
    } catch (error) {
      // where.exe exits with status 1 for a normal "not found" result. Any
      // other failure means the command probe itself was unavailable.
      const status = (error as { status?: number }).status;
      return { value: false, available: status === 1 };
    }
  }

  private runningProcesses(): ProbeResult<Set<string>> {
    try {
      if (process.platform === 'darwin') {
        const output = execFileSync('ps', ['-axo', 'comm='], { encoding: 'utf8' });
        return { value: new Set(output.split(/\r?\n/).map((line) => line.trim().split('/').pop()?.toLowerCase() || '').filter(Boolean)), available: true };
      }
      const output = execFileSync('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
      return { value: new Set(output.split(/\r?\n/).map((line) => {
        const match = /^"([^"]+)"/.exec(line.trim());
        return match?.[1]?.toLowerCase() || '';
      }).filter(Boolean)), available: true };
    } catch {
      return { value: new Set<string>(), available: false };
    }
  }

  private runningExecutablePaths(): ProbeResult<Set<string>> {
    try {
      if (process.platform === 'darwin') {
        const output = execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' });
        return { value: new Set(output.split(/\r?\n/).map((path) => normalizePath(path.trim().split(/\s+/)[0] || '')).filter(Boolean)), available: true };
      }
      const output = execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^(Codex|Claude|Qoder|Cursor|Hermes)$' } | ForEach-Object { try { $_.Path } catch {} }",
      ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      return { value: new Set(output.split(/\r?\n/).map((path) => normalizePath(path.trim())).filter(Boolean)), available: true };
    } catch {
      return { value: new Set<string>(), available: false };
    }
  }

  private installedAppxPackages(): ProbeResult<Set<string>> {
    if (process.platform === 'darwin') return { value: new Set(), available: true };
    try {
      const output = execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-AppxPackage -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }',
      ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      return { value: new Set(output.split(/\r?\n/).map((name) => name.trim().toLowerCase()).filter(Boolean)), available: true };
    } catch {
      return { value: new Set<string>(), available: false };
    }
  }

  private installedProducts(): ProbeResult<Set<string>> {
    if (process.platform === 'darwin') return { value: new Set(), available: true };
    try {
      const output = execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$roots = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'; Get-ItemProperty $roots -ErrorAction SilentlyContinue | ForEach-Object { $_.DisplayName }",
      ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      return { value: new Set(output.split(/\r?\n/).map((name) => name.trim().toLowerCase()).filter(Boolean)), available: true };
    } catch {
      return { value: new Set<string>(), available: false };
    }
  }

  private monitorConfigured(key: string, probe: Probe): boolean {
    if (key === 'claude-cli') {
      return probe.monitorPaths.some((path) => this.jsonHooksConfigured(path, 'claude_event_adapter.py', ['Stop', 'StopFailure', 'PostToolUseFailure']));
    }
    if (key === 'claude-desktop') {
      return this.hasAuditFile(this.config.claudeDesktopSessionsPath);
    }
    if (key === 'qoder-cli') {
      return probe.monitorPaths.some((path) => this.jsonHooksConfigured(
        path,
        'qoder_event_adapter.py',
        ['Stop', 'PostToolUseFailure'],
        '--runtime cli',
      ));
    }
    if (key === 'qoder-desktop' || key === 'qoder-quest') return false;
    if (key === 'cursor-cli' || key === 'cursor-desktop') {
      const runtime = key === 'cursor-cli' ? 'cli' : 'desktop';
      return probe.monitorPaths.some((path) => this.jsonHooksConfigured(
        path,
        'cursor_event_adapter.py',
        ['stop', 'postToolUseFailure'],
        `--runtime ${runtime}`,
      ));
    }
    if (key === 'hermes-cli') {
      return probe.monitorPaths.some((path) => this.hermesHooksConfigured(path));
    }
    if (key === 'hermes-desktop') {
      return Boolean(this.config.hermesStatePath)
        && existsSync(this.config.hermesStatePath)
        && Boolean(this.config.hermesSessionsPath)
        && existsSync(this.config.hermesSessionsPath);
    }
    if (key === 'codex-cli') {
      return probe.monitorPaths.some((path) => this.textConfigContains(path, 'codex_notify_multiplexer.py'));
    }
    return false;
  }

  private textConfigContains(path: string, marker: string): boolean {
    try {
      return readFileSync(path, 'utf8').includes(marker);
    } catch {
      return false;
    }
  }

  private jsonHooksConfigured(path: string, adapterName: string, events: string[], requiredCommandFragment = ''): boolean {
    try {
      const document = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      const hooks = document.hooks;
      if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false;
      const adapterPath = join(this.config.projectRoot, 'scripts', 'hooks', adapterName).toLowerCase();
      if (!existsSync(adapterPath)) return false;
      const required = requiredCommandFragment.toLowerCase().replace(/\s+/g, ' ').trim();
      const commandConfigured = (value: unknown): boolean => {
        if (typeof value !== 'string') return false;
        const command = value.toLowerCase().replace(/\s+/g, ' ').trim();
        return command.includes(adapterName.toLowerCase()) && (!required || command.includes(required));
      };
      return events.every((event) => {
        const entries = (hooks as Record<string, unknown>)[event];
        if (!Array.isArray(entries)) return false;
        return entries.some((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
          const direct = entry as Record<string, unknown>;
          if (direct.type === 'command' && commandConfigured(direct.command)) return true;
          const nested = (entry as Record<string, unknown>).hooks;
          if (!Array.isArray(nested)) return false;
          return nested.some((hook) => {
            if (!hook || typeof hook !== 'object' || Array.isArray(hook)) return false;
            const candidate = hook as Record<string, unknown>;
            return candidate.type === 'command' && commandConfigured(candidate.command);
          });
        });
      });
    } catch {
      return false;
    }
  }

  private hermesHooksConfigured(path: string): boolean {
    try {
      const source = readFileSync(path, 'utf8');
      const document = parseYaml(source) as Record<string, unknown>;
      const hooks = document && typeof document === 'object' && !Array.isArray(document)
        ? document.hooks
        : undefined;
      if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return false;
      const adapterPath = join(this.config.projectRoot, 'scripts', 'hooks', 'hermes_event_adapter.py').toLowerCase();
      const configured = ['on_session_end', 'api_request_error'].every((event) => {
        const entries = (hooks as Record<string, unknown>)[event];
        return Array.isArray(entries) && entries.some((entry) => {
          const command = entry && typeof entry === 'object' && !Array.isArray(entry)
            ? (entry as Record<string, unknown>).command
            : undefined;
          if (typeof command !== 'string') return false;
          const normalized = command.toLowerCase().replace(/\s+/g, ' ');
          return normalized.includes('hermes_event_adapter.py')
            && normalized.includes('--runtime cli')
            && existsSync(adapterPath);
        });
      });
      if (!configured) return false;
      if (document.hooks_auto_accept === true) return true;
      return [
        join(homedir(), '.hermes', 'shell-hooks-allowlist.json'),
        envPath(process.env.LOCALAPPDATA, 'hermes', 'shell-hooks-allowlist.json'),
      ].some((allowlistPath) => {
        try {
          const allowlist = readFileSync(allowlistPath, 'utf8');
          return allowlist.includes('hermes_event_adapter.py')
            && allowlist.includes('on_session_end')
            && allowlist.includes('api_request_error');
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  }

  private hasSessionFile(root: string): boolean {
    return this.findFile(root, (name) => name.toLowerCase().endsWith('.jsonl'));
  }

  private hasAuditFile(root: string): boolean {
    return this.findFile(root, (name) => name.toLowerCase() === 'audit.jsonl');
  }

  private findFile(root: string, predicate: (name: string) => boolean, depth = 5): boolean {
    if (!root || depth < 0 || !existsSync(root)) return false;
    try {
      if (statSync(root).isFile()) return predicate(root.split(/[\\/]/).pop() || '');
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, entry.name);
        if (entry.isFile() && predicate(entry.name)) return true;
        if (entry.isDirectory() && this.findFile(path, predicate, depth - 1)) return true;
      }
    } catch {
      return false;
    }
    return false;
  }
}
