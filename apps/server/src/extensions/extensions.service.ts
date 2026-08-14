import { Injectable, NotFoundException } from '@nestjs/common';
import type { ExtensionDefinition, ExtensionRuntimeState } from './extension.types';

const EXTENSIONS: ExtensionDefinition[] = [
  {
    key: 'codex-cli', product: 'Codex', runtime: 'cli',
    label: 'Codex CLI',
    adapter: {
      id: 'codex-monitor',
      active: true,
      capabilities: { completed: true, failed: true, interrupted: true, toolFailed: true, tracing: true },
    },
  },
  {
    key: 'codex-desktop', product: 'Codex', runtime: 'desktop',
    label: 'Codex Desktop',
    adapter: {
      id: 'codex-desktop-session',
      active: true,
      capabilities: { completed: true, failed: true, interrupted: true, toolFailed: true, tracing: true },
    },
  },
  {
    key: 'claude-cli', product: 'Claude', runtime: 'cli',
    label: 'Claude CLI',
    adapter: {
      id: 'claude-hooks',
      active: true,
      capabilities: { completed: true, failed: true, interrupted: false, toolFailed: true, tracing: true },
    },
  },
  {
    key: 'claude-desktop', product: 'Claude', runtime: 'desktop',
    label: 'Claude Desktop',
    adapter: {
      id: 'claude-desktop-audit',
      active: true,
      capabilities: { completed: true, failed: true, interrupted: false, toolFailed: false, tracing: false },
    },
  },
  {
    key: 'qoder-cli', product: 'Qoder', runtime: 'cli',
    label: 'Qoder CLI',
    adapter: {
      id: 'qoder-hooks',
      active: true,
      capabilities: { completed: true, failed: true, interrupted: false, toolFailed: true, tracing: true },
    },
  },
  {
    key: 'qoder-desktop', product: 'Qoder', runtime: 'desktop',
    label: 'Qoder Desktop',
    adapter: {
      id: 'qoder-desktop-hooks',
      active: true,
      capabilities: { completed: true, failed: true, interrupted: false, toolFailed: true, tracing: true },
    },
  },
  {
    key: 'qoder-quest', product: 'Qoder', runtime: 'quest',
    label: 'Qoder Quest',
    adapter: {
      id: 'qoder-quest-hooks',
      active: true,
      capabilities: { completed: true, failed: false, interrupted: false, toolFailed: false, tracing: false },
    },
  },
  {
    key: 'hermes-cli', product: 'Hermes', runtime: 'cli',
    label: 'Hermes CLI',
    adapter: {
      id: 'hermes-hooks',
      active: true,
      capabilities: { completed: true, failed: true, interrupted: false, toolFailed: true, tracing: false },
    },
  },
  {
    key: 'hermes-desktop', product: 'Hermes', runtime: 'desktop',
    label: 'Hermes Desktop',
    adapter: {
      id: 'hermes-desktop-state-watcher',
      active: true,
      capabilities: { completed: true, failed: true, interrupted: false, toolFailed: true, tracing: false },
    },
  },
  {
    key: 'cursor-cli', product: 'Cursor', runtime: 'cli',
    label: 'Cursor CLI',
    adapter: {
      id: 'cursor-cli-hooks',
      active: true,
      capabilities: { completed: true, failed: false, interrupted: false, toolFailed: true, tracing: false },
    },
  },
  {
    key: 'cursor-desktop', product: 'Cursor', runtime: 'desktop',
    label: 'Cursor Desktop',
    adapter: {
      id: 'cursor-hooks',
      active: true,
      capabilities: { completed: true, failed: false, interrupted: false, toolFailed: true, tracing: false },
    },
  },
];

const normalizeName = (value: string): string => value.trim().toLowerCase().replace(/[\s_]+/g, '-');

const LEGACY_KEY_MIGRATION: Record<string, string> = {
  codex: 'codex-cli',
  'codex-notify': 'codex-cli',
  'codex-app-server': 'codex-cli',
  'codex-session': 'codex-desktop',
  claude: 'claude-cli',
  'claude-code': 'claude-cli',
  qoder: 'qoder-cli',
  'hermes-agent': 'hermes-cli',
  hermes: 'hermes-cli',
  cursor: 'cursor-desktop',
  'cursor-editor': 'cursor-desktop',
};

@Injectable()
export class ExtensionsService {
  private readonly extensions = new Map(EXTENSIONS.map((extension) => [extension.key, extension]));

  definitions(): ExtensionDefinition[] {
    return EXTENSIONS.map((extension) => this.copy(extension));
  }

  cards(states: Record<string, ExtensionRuntimeState>): Array<ExtensionDefinition & ExtensionRuntimeState> {
    return this.definitions().map((extension) => ({
      ...extension,
      ...(states[extension.key] || {
        detected: false,
        cliAvailable: false,
        running: false,
        monitorConfigured: false,
        detectionSignals: [],
      }),
    }));
  }

  get(key: string): ExtensionDefinition {
    const extension = this.extensions.get(normalizeName(key));
    if (!extension) throw new NotFoundException('unsupported AI extension');
    return this.copy(extension);
  }

  resolve(value: string | null | undefined, runtime?: string | null): string {
    const normalized = normalizeName(value || '');
    const requestedRuntime = normalizeName(runtime || '');
    const extension = this.extensions.get(normalized);
    if (!extension) return 'other';
    return requestedRuntime && requestedRuntime !== extension.runtime ? 'other' : extension.key;
  }

  migrateLegacyKey(value: string | null | undefined): string | null {
    const normalized = normalizeName(value || '');
    return this.extensions.has(normalized) ? normalized : LEGACY_KEY_MIGRATION[normalized] || null;
  }

  legacyMigration(value: string | null | undefined): string | null {
    const normalized = normalizeName(value || '');
    return LEGACY_KEY_MIGRATION[normalized] || null;
  }

  legacyMigrations(): Array<readonly [string, string]> {
    return Object.entries(LEGACY_KEY_MIGRATION);
  }

  private copy(extension: ExtensionDefinition): ExtensionDefinition {
    return {
      ...extension,
      adapter: {
        ...extension.adapter,
        capabilities: { ...extension.adapter.capabilities },
      },
    };
  }
}
