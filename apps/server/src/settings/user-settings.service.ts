import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppConfigService } from '../config/app-config.service';
import { ExtensionsService } from '../extensions/extensions.service';
import {
  DEFAULT_RESULT_LIMIT,
  DEFAULT_TASK_LIMIT,
  MAX_RESULT_LIMIT,
  MAX_TASK_LIMIT,
  MIN_RESULT_LIMIT,
  MIN_TASK_LIMIT,
  type MonitorVerification,
  type NotificationSettings,
  type UserSettingsDocument,
  type UserSettingsSnapshot,
} from './user-settings.types';

const DEFAULT_VISIBLE_EXTENSIONS = [
  'codex-cli', 'codex-desktop', 'claude-cli', 'claude-desktop',
  'qoder-cli', 'qoder-desktop', 'qoder-quest', 'hermes-cli', 'hermes-desktop', 'cursor-cli', 'cursor-desktop',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isValidLimit = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum;

const cloneDocument = (document: UserSettingsDocument): UserSettingsDocument => ({
  version: 1,
  notification: { ...document.notification },
  visibleExtensions: [...document.visibleExtensions],
  visibleExtensionsConfigured: document.visibleExtensionsConfigured,
  monitorVerification: Object.fromEntries(Object.entries(document.monitorVerification).map(([key, value]) => [key, { ...value }])),
});

@Injectable()
export class UserSettingsService {
  private readonly logger = new Logger(UserSettingsService.name);
  private document: UserSettingsDocument;
  private hasVisiblePreference = false;

  constructor(private readonly config: AppConfigService, private readonly extensions: ExtensionsService) {
    const loaded = this.load();
    this.document = loaded.document;
    this.hasVisiblePreference = loaded.hasVisiblePreference;
    if (loaded.migrated) {
      try {
        this.persist();
      } catch (error) {
        this.logger.warn(`Unable to persist migrated user settings: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  snapshot(): UserSettingsSnapshot {
    return {
      ...cloneDocument(this.document),
      hasVisiblePreference: this.hasVisiblePreference,
    };
  }

  notification(): NotificationSettings {
    return { ...this.document.notification };
  }

  updateNotification(input: Partial<NotificationSettings>): NotificationSettings {
    const next = {
      taskLimit: input.taskLimit ?? this.document.notification.taskLimit,
      resultLimit: input.resultLimit ?? this.document.notification.resultLimit,
    };
    this.assertNotification(next);
    const previous = this.document;
    this.document = { ...this.document, notification: next };
    try {
      this.persist();
    } catch (error) {
      this.document = previous;
      throw error;
    }
    return this.notification();
  }

  updateVisibleExtensions(keys: string[], supported: string[]): string[] {
    const supportedSet = new Set(supported);
    const normalized = [...new Set(keys.map((key) => key.trim().toLowerCase()))];
    if (normalized.some((key) => !supportedSet.has(key))) {
      throw new BadRequestException('visibleExtensions contains an unsupported extension');
    }
    const previous = this.document;
    const previousPreference = this.hasVisiblePreference;
    this.document = { ...this.document, visibleExtensions: normalized, visibleExtensionsConfigured: true };
    this.hasVisiblePreference = true;
    try {
      this.persist();
    } catch (error) {
      this.document = previous;
      this.hasVisiblePreference = previousPreference;
      throw error;
    }
    return [...normalized];
  }

  markMonitorVerified(extensionKey: string, verificationSource: string, verifiedAt = new Date().toISOString()): void {
    const normalizedKey = extensionKey.trim().toLowerCase();
    const key = this.extensions.resolve(normalizedKey);
    const source = verificationSource.trim().toLowerCase();
    if (!key || !source || !Number.isFinite(Date.parse(verifiedAt))) return;
    const previous = this.document;
    this.document = {
      ...this.document,
      monitorVerification: {
        ...this.document.monitorVerification,
        [key]: { monitorVerified: true, lastVerifiedAt: verifiedAt, verificationSource: source },
      },
    };
    try {
      this.persist();
    } catch (error) {
      this.document = previous;
      throw error;
    }
  }

  defaultVisibleExtensions(): string[] {
    return [...DEFAULT_VISIBLE_EXTENSIONS];
  }

  private load(): { document: UserSettingsDocument; hasVisiblePreference: boolean; migrated: boolean } {
    const fallback: UserSettingsDocument = {
      version: 1,
      notification: { taskLimit: DEFAULT_TASK_LIMIT, resultLimit: DEFAULT_RESULT_LIMIT },
      visibleExtensions: this.defaultVisibleExtensions(),
      visibleExtensionsConfigured: false,
      monitorVerification: {},
    };
    if (!existsSync(this.config.userSettingsPath)) return { document: fallback, hasVisiblePreference: false, migrated: false };
    try {
      const parsed = JSON.parse(readFileSync(this.config.userSettingsPath, 'utf8')) as unknown;
      if (!isRecord(parsed) || parsed.version !== 1) throw new Error('unsupported settings version');
      const notification = parsed.notification;
      if (!isRecord(notification)
        || !isValidLimit(notification.taskLimit, MIN_TASK_LIMIT, MAX_TASK_LIMIT)
        || !isValidLimit(notification.resultLimit, MIN_RESULT_LIMIT, MAX_RESULT_LIMIT)) {
        throw new Error('invalid notification settings');
      }
      const visible = parsed.visibleExtensions;
      if (!Array.isArray(visible) || visible.some((value) => typeof value !== 'string')) {
        throw new Error('invalid visible extensions');
      }
      const normalizedVisible = [...new Set(visible.map((value) => this.extensions.migrateLegacyKey(value)).filter((value): value is string => Boolean(value)))];
      const normalizedVerification = this.parseMonitorVerification(parsed.monitorVerification);
      const migratedVisible = visible.some((value) => this.extensions.migrateLegacyKey(value) !== value.trim().toLowerCase());
      const rawVerification = isRecord(parsed.monitorVerification) ? parsed.monitorVerification : {};
      const migratedVerification = Object.keys(rawVerification).some((key) => this.extensions.legacyMigration(key) !== null);
      return {
        document: {
          version: 1,
          notification: { taskLimit: notification.taskLimit, resultLimit: notification.resultLimit },
          visibleExtensions: normalizedVisible,
          visibleExtensionsConfigured: parsed.visibleExtensionsConfigured === true,
          monitorVerification: normalizedVerification,
        },
        hasVisiblePreference: parsed.visibleExtensionsConfigured === true,
        migrated: migratedVisible || migratedVerification,
      };
    } catch (error) {
      this.logger.warn(`Ignoring invalid user settings: ${error instanceof Error ? error.message : String(error)}`);
      return { document: fallback, hasVisiblePreference: false, migrated: false };
    }
  }

  private parseMonitorVerification(value: unknown): Record<string, MonitorVerification> {
    if (!isRecord(value)) return {};
    return Object.fromEntries(Object.entries(value).flatMap(([key, candidate]) => {
      if (!isRecord(candidate)
        || candidate.monitorVerified !== true
        || typeof candidate.lastVerifiedAt !== 'string'
        || !Number.isFinite(Date.parse(candidate.lastVerifiedAt))
        || typeof candidate.verificationSource !== 'string'
        || !candidate.verificationSource.trim()) return [];
      const normalizedKey = this.extensions.migrateLegacyKey(key);
      if (!normalizedKey) return [];
      return [[normalizedKey, {
        monitorVerified: true,
        lastVerifiedAt: candidate.lastVerifiedAt,
        verificationSource: candidate.verificationSource.trim().toLowerCase(),
      } satisfies MonitorVerification]];
    }));
  }

  private assertNotification(value: NotificationSettings): void {
    if (!isValidLimit(value.taskLimit, MIN_TASK_LIMIT, MAX_TASK_LIMIT)
      || !isValidLimit(value.resultLimit, MIN_RESULT_LIMIT, MAX_RESULT_LIMIT)) {
      throw new BadRequestException('notification limits are out of range');
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.config.userSettingsPath), { recursive: true });
    const temporary = `${this.config.userSettingsPath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.config.userSettingsPath);
  }
}
