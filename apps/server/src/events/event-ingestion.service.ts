import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { DatabaseService } from '../database/database.service';
import type { NormalizedEvent } from '../database/database.types';
import { ExtensionsService } from '../extensions/extensions.service';
import { UserSettingsService } from '../settings/user-settings.service';
import { cleanAnswerText } from './event-text';

const VERIFIED_SOURCES: Record<string, Set<string>> = {
  'codex-cli': new Set(['codex', 'codex-notify', 'codex-app-server']),
  'codex-desktop': new Set(['codex-session']),
  'claude-cli': new Set(['claude']),
  'claude-desktop': new Set(['claude-desktop']),
  'qoder-cli': new Set(['qoder']),
  'qoder-desktop': new Set(['qoder']),
  'qoder-quest': new Set(['qoder']),
  'hermes-cli': new Set(['hermes']),
  'hermes-desktop': new Set(['hermes', 'hermes-desktop']),
  'cursor-cli': new Set(['cursor']),
  'cursor-desktop': new Set(['cursor']),
};

@Injectable()
export class EventIngestionService {
  private readonly logger = new Logger(EventIngestionService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly config: AppConfigService,
    private readonly extensions: ExtensionsService,
    private readonly settings: UserSettingsService,
  ) {}

  ingest(event: NormalizedEvent, channels: string[], answerSource?: unknown): [number, boolean] {
    if (this.extensions.resolve(event.client) === 'other') {
      const migrated = this.extensions.legacyMigration(event.client);
      if (migrated) {
        throw new BadRequestException(`client key "${event.client}" was migrated to "${migrated}"; send the canonical key`);
      }
      throw new BadRequestException('event client must be a canonical extension key');
    }
    const metadataSource = event.metadata.answer_source;
    delete event.metadata.answer_source;
    delete event.metadata.answer_text;
    const source = typeof answerSource === 'string'
      ? answerSource
      : typeof metadataSource === 'string' ? metadataSource : '';
    if (event.status === 'completed' && source) event.metadata.answer_text = cleanAnswerText(source);
    const deliveryDelay = event.status === 'completed' ? this.config.answerCaptureGraceMs : 0;
    const [eventId, inserted] = this.database.insertEvent(event, channels, deliveryDelay);
    const extensionKey = this.extensions.resolve(event.client);
    if (extensionKey !== 'other' && (VERIFIED_SOURCES[extensionKey]?.has(event.source.trim().toLowerCase()) ?? false) && inserted) {
      try {
        this.settings.markMonitorVerified(extensionKey, event.source);
      } catch (error) {
        this.logger.warn(`Unable to persist monitor verification: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return [eventId, inserted];
  }
}
