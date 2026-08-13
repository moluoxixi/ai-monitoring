import { Injectable, NotFoundException } from '@nestjs/common';
import type { ExtensionDefinition } from './extension.types';

const EXTENSIONS: ExtensionDefinition[] = [
  {
    key: 'codex',
    label: 'Codex',
    aliases: ['codex', 'codex-cli', 'codex-desktop', 'codex-notify', 'codex-app-server'],
    adapter: {
      id: 'codex-monitor',
      active: true,
      capabilities: { completed: true, failed: true, interrupted: true, toolFailed: true, tracing: true },
    },
  },
  {
    key: 'claude',
    label: 'Claude',
    aliases: ['claude', 'claude-cli', 'claude-code', 'claude-desktop'],
    adapter: {
      id: 'claude-hooks',
      active: true,
      capabilities: { completed: true, failed: true, interrupted: false, toolFailed: true, tracing: true },
    },
  },
  {
    key: 'qoder',
    label: 'Qoder',
    aliases: ['qoder', 'qoder-cli', 'qoder-desktop'],
    adapter: {
      id: 'qoder-hooks',
      active: true,
      capabilities: { completed: true, failed: true, interrupted: false, toolFailed: true, tracing: true },
    },
  },
];

const normalizeName = (value: string): string => value.trim().toLowerCase().replace(/[\s_]+/g, '-');

@Injectable()
export class ExtensionsService {
  private readonly extensions = new Map(EXTENSIONS.map((extension) => [extension.key, extension]));
  private readonly aliases = new Map(
    EXTENSIONS.flatMap((extension) => extension.aliases.map((alias) => [alias, extension.key] as const)),
  );

  definitions(): ExtensionDefinition[] {
    return EXTENSIONS.map((extension) => this.copy(extension));
  }

  get(key: string): ExtensionDefinition {
    const extension = this.extensions.get(normalizeName(key));
    if (!extension) throw new NotFoundException('unsupported AI extension');
    return this.copy(extension);
  }

  resolve(value: string | null | undefined): string {
    return this.aliases.get(normalizeName(value || '')) || 'other';
  }

  private copy(extension: ExtensionDefinition): ExtensionDefinition {
    return {
      ...extension,
      aliases: [...extension.aliases],
      adapter: {
        ...extension.adapter,
        capabilities: { ...extension.adapter.capabilities },
      },
    };
  }
}
