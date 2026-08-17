import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { DatabaseService } from '../database/database.service';
import type { NormalizedEvent } from '../database/database.types';
import { ExtensionsService } from '../extensions/extensions.service';
import { PlatformScannerService } from '../extensions/platform-scanner.service';
import { UserSettingsService } from '../settings/user-settings.service';
import { cleanAnswerText, isRecoverableFailure } from '../utils/event-text';

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
    @Optional() private readonly scanner?: PlatformScannerService,
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
    const failureText = [
      event.message,
      event.error_code || '',
      typeof event.metadata.failure_message === 'string' ? event.metadata.failure_message : '',
    ].join(' ');
    const explicitlyDiagnostic = event.metadata.notification_state === 'diagnostic'
      || event.metadata.terminal === false
      || event.status === 'tool_failed';
    const recoverableFailure = event.status === 'failed' && !explicitlyDiagnostic && isRecoverableFailure(failureText);
    if (explicitlyDiagnostic) event.metadata.notification_state = 'diagnostic';
    else if (recoverableFailure) event.metadata.notification_state = 'provisional';

    const deliveryChannels = explicitlyDiagnostic ? [] : this.deliveryChannelsFor(event.client, channels);
    const deliveryDelay = event.status === 'completed'
      ? this.config.answerCaptureGraceMs
      : recoverableFailure ? Number(this.config.recoverableFailureGraceMs || 0) : 0;
    const [eventId, inserted] = this.database.insertEvent(event, deliveryChannels, deliveryDelay);
    const sessionId = typeof event.metadata.session_id === 'string'
      ? event.metadata.session_id
      : typeof event.metadata.thread_id === 'string' ? event.metadata.thread_id : '';
    if (sessionId && ['completed', 'interrupted'].includes(event.status)) {
      this.suppressProvisionalFailures(event.client, sessionId);
    }
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

  deliveryChannelsFor(client: string, channels: string[]): string[] {
    if (!this.scanner) return [...channels];
    const visible = new Set(this.extensions.effectiveVisibleKeys(this.scanner.snapshot(), this.settings.snapshot()));
    return visible.has(client) ? [...channels] : [];
  }

  /** Called by watchers when a user starts a follow-up turn. */
  suppressProvisionalFailures(client: string, sessionId: string): void {
    try {
      this.database.suppressProvisionalFailures(this.extensions.resolve(client), sessionId);
    } catch (error) {
      this.logger.warn(`Unable to suppress provisional failures: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
