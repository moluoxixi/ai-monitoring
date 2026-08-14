import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { load as parseYaml } from 'js-yaml';
import { AppConfigService } from '../config/app-config.service';
import type { ExtensionRuntimeState } from './extension.types';

export interface PlatformScanSnapshot {
  scanScope: 'host' | 'unsupported';
  scannedAt: string | null;
  platforms: Record<string, ExtensionRuntimeState>;
}

type Probe = {
  commands: string[];
  executables: string[];
  processNames: string[];
  processPathFragments?: string[];
  paths: string[];
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
const containerMarker = (): boolean => Boolean(
  process.env.AIMONITOR_SCAN_SCOPE === 'unsupported'
  || process.env.DOCKER_CONTAINER === 'true'
  || process.env.CONTAINER === 'true'
  || existsSync('/.dockerenv')
  || existsSync('/run/.containerenv'),
);

const probes: Record<string, Probe> = {
  'codex-cli': {
    commands: ['codex'], executables: [], processNames: ['codex.exe', 'codex-cli.exe', 'openai.codex.exe'],
    paths: [join(homedir(), '.codex'), envPath(process.env.LOCALAPPDATA, 'Codex')],
    monitorPaths: [join(homedir(), '.codex', 'config.toml')], monitorKind: 'hooks',
  },
  'codex-desktop': {
    commands: [], executables: [envPath(process.env.LOCALAPPDATA, 'Programs', 'Codex', 'Codex.exe')],
    processNames: ['codex-desktop.exe', 'openai.codex.exe'],
    paths: [envPath(process.env.LOCALAPPDATA, 'Codex'), join(homedir(), '.codex')],
    monitorPaths: [], monitorKind: 'sessions',
  },
  'claude-cli': {
    commands: ['claude'], executables: [], processNames: ['claude-code.exe'],
    paths: [join(homedir(), '.claude')],
    monitorPaths: [join(homedir(), '.claude', 'settings.json')],
    monitorKind: 'hooks',
  },
  'claude-desktop': {
    commands: [], executables: [envPath(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'Claude.exe')], processNames: ['claude.exe'],
    paths: [envPath(process.env.LOCALAPPDATA, 'Claude'), envPath(process.env.LOCALAPPDATA, 'Packages', 'Claude_pzs8sxrjxfjjc')],
    monitorPaths: [], monitorKind: 'audit',
  },
  'qoder-cli': {
    commands: ['qoder'], executables: [join(homedir(), '.qoder', 'bin', 'qodercli', 'qodercli.exe')], processNames: [],
    paths: [join(homedir(), '.qoder')],
    monitorPaths: [join(homedir(), '.qoder', 'settings.json')],
    monitorKind: 'hooks',
  },
  'qoder-desktop': {
    commands: [], executables: [envPath(process.env.LOCALAPPDATA, 'Programs', 'Qoder', 'Qoder.exe')], processNames: ['qoder.exe'],
    paths: [envPath(process.env.APPDATA, 'Qoder'), envPath(process.env.LOCALAPPDATA, '.qoder')],
    monitorPaths: [join(homedir(), '.qoder', 'settings.json')], monitorKind: 'hooks',
  },
  'qoder-quest': {
    // Quest sessions are not distinguishable from the desktop process by
    // executable name. Never report a generic qoder.exe as Quest.
    commands: [], executables: [], processNames: [],
    paths: [envPath(process.env.APPDATA, 'Qoder', 'logs')],
    monitorPaths: [join(homedir(), '.qoder', 'settings.json')], monitorKind: 'hooks',
  },
  'hermes-cli': {
    commands: ['hermes'], executables: [envPath(process.env.LOCALAPPDATA, 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe')], processNames: [],
    processPathFragments: ['\\hermes-agent\\venv\\scripts\\hermes.exe'],
    paths: [envPath(process.env.LOCALAPPDATA, 'hermes'), join(homedir(), '.hermes')],
    monitorPaths: [envPath(process.env.LOCALAPPDATA, 'hermes', 'config.yaml'), join(homedir(), '.hermes', 'config.yaml')],
    monitorKind: 'config',
  },
  'hermes-desktop': {
    commands: [], executables: [
      envPath(process.env.LOCALAPPDATA, 'Programs', 'Hermes', 'Hermes.exe'),
      envPath(process.env.LOCALAPPDATA, 'hermes', 'hermes-agent', 'apps', 'desktop', 'release', 'win-unpacked', 'Hermes.exe'),
    ], processNames: [],
    processPathFragments: ['\\hermes-agent\\apps\\desktop\\', '\\programs\\hermes\\hermes.exe'],
    paths: [envPath(process.env.LOCALAPPDATA, 'hermes'), join(homedir(), '.hermes')],
    monitorPaths: [
      envPath(process.env.LOCALAPPDATA, 'hermes', 'state.db'),
      envPath(process.env.LOCALAPPDATA, 'hermes', 'sessions'),
    ],
    monitorKind: 'sessions',
  },
  'cursor-cli': {
    commands: ['cursor'], executables: [envPath(process.env.LOCALAPPDATA, 'Programs', 'Cursor', 'resources', 'app', 'bin', 'cursor.cmd')], processNames: [],
    paths: [join(homedir(), '.cursor')],
    monitorPaths: [join(homedir(), '.cursor', 'hooks.json')], monitorKind: 'hooks',
  },
  'cursor-desktop': {
    commands: [], executables: [envPath(process.env.LOCALAPPDATA, 'Programs', 'Cursor', 'Cursor.exe')], processNames: ['cursor.exe'],
    paths: [join(homedir(), '.cursor'), envPath(process.env.APPDATA, 'Cursor')],
    monitorPaths: [join(homedir(), '.cursor', 'hooks.json')],
    monitorKind: 'hooks',
  },
};

@Injectable()
export class PlatformScannerService implements OnModuleInit {
  private readonly logger = new Logger(PlatformScannerService.name);
  private snapshotValue: PlatformScanSnapshot = {
    scanScope: process.platform === 'win32' && !containerMarker() ? 'host' : 'unsupported',
    scannedAt: null,
    platforms: Object.fromEntries(Object.keys(probes).map((key) => [key, { ...EMPTY_STATE, detectionSignals: [] }])),
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
      platforms: Object.fromEntries(Object.entries(this.snapshotValue.platforms).map(([key, state]) => [key, {
        ...state,
        detectionSignals: [...state.detectionSignals],
      }])),
    };
  }

  scan(): PlatformScanSnapshot {
    const supportedHost = process.platform === 'win32' && !containerMarker();
    if (!supportedHost) {
      this.snapshotValue = {
        scanScope: 'unsupported',
        scannedAt: new Date().toISOString(),
        platforms: Object.fromEntries(Object.keys(probes).map((key) => [key, { ...EMPTY_STATE, detectionSignals: [] }])),
      };
      return this.snapshot();
    }
    const running = this.runningProcesses();
    const runningPaths = this.runningExecutablePaths();
    const next: Record<string, ExtensionRuntimeState> = {};
    for (const [key, probe] of Object.entries(probes)) {
      try {
        const cliAvailable = process.platform === 'win32' && (
          probe.commands.some((command) => this.commandAvailable(command))
          || probe.executables.some((path) => Boolean(path) && existsSync(path))
        );
        const runningNow = probe.processPathFragments?.length
          ? probe.processPathFragments.some((fragment) => [...runningPaths].some((path) => path.includes(fragment.toLowerCase())))
          : probe.processNames.some((name) => running.has(name.toLowerCase()));
        const configPathFound = probe.paths.some((path) => Boolean(path) && existsSync(path));
        const monitorConfigured = key === 'codex-desktop'
          ? this.hasSessionFile(this.config.codexSessionsPath)
          : this.monitorConfigured(key, probe);
        const detectionSignals = [
          ...(cliAvailable ? ['cli'] : []),
          ...(runningNow ? ['running'] : []),
          ...(configPathFound ? ['config'] : []),
          ...(monitorConfigured ? [probe.monitorKind] : []),
        ];
        next[key] = {
          detected: detectionSignals.length > 0,
          cliAvailable,
          running: runningNow,
          monitorConfigured,
          detectionSignals: [...new Set(detectionSignals)],
        };
      } catch (error) {
        this.logger.warn(`Platform probe failed for ${key}: ${error instanceof Error ? error.message : String(error)}`);
        next[key] = { ...EMPTY_STATE, detectionSignals: [] };
      }
    }
    this.snapshotValue = { scanScope: 'host', scannedAt: new Date().toISOString(), platforms: next };
    return this.snapshot();
  }

  private commandAvailable(command: string): boolean {
    try {
      execFileSync('where.exe', [command], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      return true;
    } catch {
      return false;
    }
  }

  private runningProcesses(): Set<string> {
    try {
      const output = execFileSync('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
      return new Set(output.split(/\r?\n/).map((line) => {
        const match = /^"([^"]+)"/.exec(line.trim());
        return match?.[1]?.toLowerCase() || '';
      }).filter(Boolean));
    } catch {
      return new Set<string>();
    }
  }

  private runningExecutablePaths(): Set<string> {
    try {
      const output = execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-Process -Name Hermes -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Path } catch {} }',
      ], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      return new Set(output.split(/\r?\n/).map((path) => path.trim().toLowerCase()).filter(Boolean));
    } catch {
      return new Set<string>();
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
