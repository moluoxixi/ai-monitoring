import { Injectable } from '@nestjs/common';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const numberValue = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

@Injectable()
export class AppConfigService {
  /** Read-only application files (scripts, hooks and built frontend assets). */
  readonly resourceRoot = resolve(
    process.env.AIMONITOR_RESOURCE_ROOT?.trim() || process.env.AIMONITOR_PROJECT_ROOT?.trim() || resolve(__dirname, '../../../..'),
  );
  /** Writable runtime files (database, bindings, settings and outbox). */
  readonly dataRoot = resolve(
    process.env.AIMONITOR_DATA_ROOT?.trim() || join(this.resourceRoot, 'data'),
  );
  /** Kept as an API-compatible alias for integrations that use the project root as cwd. */
  readonly projectRoot = this.resourceRoot;
  readonly host = process.env.AIMONITOR_HOST?.trim() || '127.0.0.1';
  readonly port = numberValue(process.env.AIMONITOR_PORT, 8787);
  readonly dbPath = this.dataPath(process.env.AIMONITOR_DB_PATH || 'monitor.db');
  readonly openClawBindingsPath = this.dataPath(
    process.env.AIMONITOR_OPENCLAW_BINDINGS_PATH || 'openclaw-channels.json',
  );
  readonly pushPlusBindingPath = this.dataPath(
    process.env.AIMONITOR_PUSHPLUS_BINDING_PATH || 'pushplus-binding.json',
  );
  readonly appriseChannelsPath = this.dataPath(
    process.env.AIMONITOR_APPRISE_CHANNELS_PATH || 'apprise-channels.json',
  );
  readonly userSettingsPath = this.dataPath(
    process.env.AIMONITOR_USER_SETTINGS_PATH || 'user-settings.json',
  );
  readonly answerCaptureGraceMs = Math.max(0, numberValue(process.env.AIMONITOR_ANSWER_CAPTURE_GRACE_MS, 1_500));
  /** Delay recoverable provider failures so a follow-up/retry can suppress them. */
  readonly recoverableFailureGraceMs = Math.max(
    0,
    numberValue(process.env.AIMONITOR_RECOVERABLE_FAILURE_GRACE_MS, 10 * 60_000),
  );
  readonly codexSessionsPath = resolve(process.env.AIMONITOR_CODEX_SESSIONS_PATH?.trim() || resolve(homedir(), '.codex', 'sessions'));
  readonly qoderSessionsPath = resolve(
    process.env.AIMONITOR_QODER_SESSIONS_PATH?.trim() || resolve(homedir(), '.qoder', 'projects'),
  );
  private readonly qoderApplicationSupportPath = process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support')
    : (process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'));
  readonly qoderLogsPath = resolve(
    process.env.AIMONITOR_QODER_LOGS_PATH?.trim()
      || join(this.qoderApplicationSupportPath, 'Qoder', 'logs'),
  );
  private readonly applicationSupportPath = process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support')
    : (process.env.LOCALAPPDATA || '');
  /** Claude Desktop's embedded Claude Code writes live JSONL session transcripts here. */
  readonly claudeDesktopTranscriptsPath = resolve(
    process.env.AIMONITOR_CLAUDE_DESKTOP_TRANSCRIPTS_PATH?.trim()
      || join(homedir(), '.claude', 'projects'),
  );
  readonly hermesStatePath = resolve(
    process.env.AIMONITOR_HERMES_STATE_PATH?.trim()
      || join(this.applicationSupportPath, 'hermes', 'state.db'),
  );
  readonly hermesSessionsPath = resolve(
    process.env.AIMONITOR_HERMES_SESSIONS_PATH?.trim()
      || join(this.applicationSupportPath, 'hermes', 'sessions'),
  );
  readonly hermesDesktopLogPath = resolve(
    process.env.AIMONITOR_HERMES_DESKTOP_LOG_PATH?.trim()
      || join(this.applicationSupportPath, 'hermes', 'logs', 'desktop.log'),
  );
  readonly codexBackfillMinutes = numberValue(process.env.AIMONITOR_CODEX_BACKFILL_MINUTES, 120);
  readonly ingestToken = process.env.AIMONITOR_INGEST_TOKEN || '';
  readonly replyToken = process.env.AIMONITOR_REPLY_TOKEN?.trim() || this.ingestToken;
  readonly replyRouteTtlMs = Math.max(
    60_000,
    numberValue(process.env.AIMONITOR_REPLY_ROUTE_TTL_DAYS, 30) * 24 * 60 * 60_000,
  );
  readonly codexCommand = process.env.AIMONITOR_CODEX_COMMAND?.trim() || 'codex';
  readonly codexReplyRequestTimeoutMs = Math.max(
    1_000,
    numberValue(process.env.AIMONITOR_CODEX_REPLY_REQUEST_TIMEOUT_MS, 30_000),
  );
  readonly codexReplyTurnTimeoutMs = Math.max(
    60_000,
    numberValue(process.env.AIMONITOR_CODEX_REPLY_TURN_TIMEOUT_MS, 12 * 60 * 60_000),
  );
  readonly claudeCommand = process.env.AIMONITOR_CLAUDE_COMMAND?.trim() || 'claude';
  readonly claudeReplyRequestTimeoutMs = Math.max(
    1_000,
    numberValue(process.env.AIMONITOR_CLAUDE_REPLY_REQUEST_TIMEOUT_MS, 30_000),
  );
  readonly claudeReplyTurnTimeoutMs = Math.max(
    60_000,
    numberValue(process.env.AIMONITOR_CLAUDE_REPLY_TURN_TIMEOUT_MS, 12 * 60 * 60_000),
  );
  readonly qoderCommand = process.env.AIMONITOR_QODER_COMMAND?.trim() || 'qodercli';
  readonly qoderReplyRequestTimeoutMs = Math.max(
    1_000,
    numberValue(process.env.AIMONITOR_QODER_REPLY_REQUEST_TIMEOUT_MS, 30_000),
  );
  readonly qoderReplyTurnTimeoutMs = Math.max(
    60_000,
    numberValue(process.env.AIMONITOR_QODER_REPLY_TURN_TIMEOUT_MS, 12 * 60 * 60_000),
  );
  readonly appriseUrls = (process.env.AIMONITOR_APPRISE_URLS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  readonly retryBaseSeconds = numberValue(process.env.AIMONITOR_RETRY_BASE_SECONDS, 5);
  readonly retryMaxSeconds = numberValue(process.env.AIMONITOR_RETRY_MAX_SECONDS, 3600);
  readonly webDistPath = resolve(
    process.env.AIMONITOR_WEB_DIST_PATH?.trim() || join(this.resourceRoot, 'apps', 'web', 'dist'),
  );

  private dataPath(value: string): string {
    if (isAbsolute(value)) return resolve(value);
    const relative = value.replace(/^data[\\/]/, '');
    return resolve(this.dataRoot, relative);
  }
}
