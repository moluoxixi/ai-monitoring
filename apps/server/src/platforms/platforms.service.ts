import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppConfigService } from '../config/app-config.service';
import type { PlatformBinding, PlatformDefinition, PlatformIntegration, PlatformRecord } from './platform.types';

const BUILT_INS: PlatformDefinition[] = [
  {
    key: 'codex', label: 'Codex', aliases: ['codex', 'codex-cli', 'codex-desktop', 'codex-notify', 'codex-app-server'], custom: false,
    integration: {
      adapterId: 'codex-monitor', mode: 'notify-and-app-server', state: 'ready',
      capabilities: { completed: true, failed: true, interrupted: true, toolFailed: true, tracing: true },
      description: 'Notify 与结构化 session watcher 捕获任务终态，App Server 补充工具调用和 Trace 状态。',
    },
  },
  {
    key: 'claude', label: 'Claude', aliases: ['claude', 'claude-cli', 'claude-code', 'claude-desktop'], custom: false,
    integration: {
      adapterId: 'claude-hooks', mode: 'hooks', state: 'ready',
      capabilities: { completed: true, failed: true, interrupted: false, toolFailed: true, tracing: true },
      description: '通过 Stop、StopFailure 和 PostToolUseFailure hooks 采集。',
    },
  },
  {
    key: 'qoder', label: 'Qoder', aliases: ['qoder', 'qoder-cli', 'qoder-desktop'], custom: false,
    integration: {
      adapterId: 'qoder-hooks', mode: 'hooks', state: 'ready',
      capabilities: { completed: true, failed: true, interrupted: false, toolFailed: true, tracing: true },
      description: '通过 Qoder CLI hooks 采集完成、失败和工具错误。',
    },
  },
];

const normalizeName = (value: string): string => value.trim().toLowerCase().replace(/[\s_]+/g, '-');

const genericIntegration = (): PlatformIntegration => ({
  adapterId: 'generic-event-webhook',
  mode: 'generic-webhook',
  state: 'manual',
  capabilities: { completed: true, failed: true, interrupted: true, toolFailed: true, tracing: false },
  description: '已注册事件来源；需要由该软件的 hook 或插件调用通用事件接口，才会自动采集。',
});

@Injectable()
export class PlatformsService {
  private readonly records = new Map<string, PlatformRecord>();
  private aliases = new Map<string, string>();

  constructor(private readonly config: AppConfigService) {
    this.load();
  }

  definitions(): PlatformDefinition[] {
    return [...this.records.values()].map(({ definition }) => ({ ...definition, aliases: [...definition.aliases] }));
  }

  get(key: string): PlatformRecord {
    const record = this.records.get(normalizeName(key));
    if (!record) throw new NotFoundException('unsupported AI client');
    return {
      definition: { ...record.definition, aliases: [...record.definition.aliases] },
      binding: { ...record.binding },
    };
  }

  resolve(value: string | null | undefined): string {
    return this.aliases.get(normalizeName(value || '')) || 'other';
  }

  create(keyValue: string, labelValue: string, aliasesValue: string[]): PlatformRecord {
    const key = normalizeName(keyValue);
    const label = labelValue.trim();
    if (key !== keyValue.trim().toLowerCase() || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(key) || key === 'other') {
      throw new ConflictException('platform key must use 1-40 lowercase letters, numbers, or hyphens');
    }
    if (!label || label.length > 40) throw new ConflictException('platform label must contain 1-40 characters');
    if (this.records.has(key)) throw new ConflictException('platform key already exists');

    const aliases = [...new Set([key, ...aliasesValue.map(normalizeName).filter(Boolean)])];
    if (aliases.some((alias) => alias.length > 80)) throw new ConflictException('platform alias must not exceed 80 characters');
    for (const alias of aliases) {
      if (this.aliases.has(alias)) throw new ConflictException(`platform alias already exists: ${alias}`);
    }
    const record: PlatformRecord = {
      definition: { key, label, aliases, custom: true, integration: genericIntegration() },
      binding: { channel: null },
    };
    this.records.set(key, record);
    this.rebuildAliases();
    this.save();
    return this.get(key);
  }

  update(key: string, channel: string | null): PlatformBinding {
    const record = this.records.get(normalizeName(key));
    if (!record) throw new NotFoundException('unsupported AI client');
    record.binding = { channel };
    this.save();
    return { ...record.binding };
  }

  delete(key: string): void {
    const normalized = normalizeName(key);
    const record = this.records.get(normalized);
    if (!record) throw new NotFoundException('unsupported AI client');
    if (!record.definition.custom) throw new ConflictException('built-in AI clients cannot be deleted');
    this.records.delete(normalized);
    this.rebuildAliases();
    this.save();
  }

  private load(): void {
    const raw = this.readConfig();
    for (const definition of BUILT_INS) {
      const item = this.objectValue(raw.clients?.[definition.key]);
      this.records.set(definition.key, {
        definition: { ...definition, aliases: [...definition.aliases] },
        binding: this.bindingFrom(item),
      });
    }

    if (raw.version === 2 || raw.version === 3) {
      for (const [key, value] of Object.entries(raw.clients || {})) {
        if (this.records.has(key)) continue;
        const item = this.objectValue(value);
        if (!item.custom || typeof item.label !== 'string' || !Array.isArray(item.aliases)) continue;
        const aliases = item.aliases.filter((alias): alias is string => typeof alias === 'string');
        try {
          this.addLoadedCustom(key, item.label, aliases, this.bindingFrom(item));
        } catch {
          // Ignore malformed custom entries while preserving built-in platform availability.
        }
      }
    }
    this.rebuildAliases();
  }

  private addLoadedCustom(keyValue: string, labelValue: string, aliasesValue: string[], binding: PlatformBinding): void {
    const key = normalizeName(keyValue);
    const label = labelValue.trim();
    if (key !== keyValue || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(key) || key === 'other' || !label || label.length > 40) {
      throw new Error('invalid custom platform');
    }
    const aliases = [...new Set([key, ...aliasesValue.map(normalizeName).filter(Boolean)])];
    if (aliases.some((alias) => alias.length > 80)) throw new Error('invalid aliases');
    this.records.set(key, { definition: { key, label, aliases, custom: true, integration: genericIntegration() }, binding });
  }

  private bindingFrom(item: Record<string, unknown>): PlatformBinding {
    return {
      channel: typeof item.channel === 'string' && item.channel ? item.channel : null,
    };
  }

  private readConfig(): { version?: number; clients?: Record<string, unknown> } {
    if (!existsSync(this.config.clientConfigPath)) return {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.config.clientConfigPath, 'utf8'));
      return this.objectValue(parsed) as { version?: number; clients?: Record<string, unknown> };
    } catch {
      throw new Error('AI client configuration file is invalid');
    }
  }

  private objectValue(value: unknown): Record<string, any> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
  }

  private rebuildAliases(): void {
    const next = new Map<string, string>();
    for (const record of this.records.values()) {
      for (const alias of record.definition.aliases) {
        const existing = next.get(alias);
        if (existing && existing !== record.definition.key) throw new Error(`duplicate platform alias: ${alias}`);
        next.set(alias, record.definition.key);
      }
    }
    this.aliases = next;
  }

  private save(): void {
    const clients: Record<string, unknown> = {};
    for (const [key, record] of this.records) {
      clients[key] = {
        label: record.definition.label,
        aliases: record.definition.aliases,
        custom: record.definition.custom,
        channel: record.binding.channel,
      };
    }
    mkdirSync(dirname(this.config.clientConfigPath), { recursive: true });
    const temporary = `${this.config.clientConfigPath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ version: 3, clients }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.config.clientConfigPath);
  }
}
