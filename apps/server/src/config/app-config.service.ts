import { Injectable } from '@nestjs/common';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const numberValue = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

@Injectable()
export class AppConfigService {
  readonly projectRoot = resolve(__dirname, '../../../..');
  readonly host = process.env.AIMONITOR_HOST?.trim() || '127.0.0.1';
  readonly port = numberValue(process.env.AIMONITOR_PORT, 8787);
  readonly dbPath = this.path(process.env.AIMONITOR_DB_PATH || 'data/monitor.db');
  readonly openClawBindingsPath = this.path(
    process.env.AIMONITOR_OPENCLAW_BINDINGS_PATH || 'data/openclaw-channels.json',
  );
  readonly pushPlusBindingPath = this.path(
    process.env.AIMONITOR_PUSHPLUS_BINDING_PATH || 'data/pushplus-binding.json',
  );
  readonly appriseChannelsPath = this.path(
    process.env.AIMONITOR_APPRISE_CHANNELS_PATH || 'data/apprise-channels.json',
  );
  readonly userSettingsPath = this.path(
    process.env.AIMONITOR_USER_SETTINGS_PATH || 'data/user-settings.json',
  );
  readonly answerCaptureGraceMs = Math.max(0, numberValue(process.env.AIMONITOR_ANSWER_CAPTURE_GRACE_MS, 1_500));
  readonly codexSessionsPath = resolve(process.env.AIMONITOR_CODEX_SESSIONS_PATH?.trim() || resolve(homedir(), '.codex', 'sessions'));
  readonly claudeDesktopSessionsPath = resolve(
    process.env.AIMONITOR_CLAUDE_DESKTOP_SESSIONS_PATH?.trim()
      || join(process.env.LOCALAPPDATA || '', 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Local', 'Claude-3p', 'local-agent-mode-sessions'),
  );
  readonly hermesStatePath = resolve(
    process.env.AIMONITOR_HERMES_STATE_PATH?.trim()
      || join(process.env.LOCALAPPDATA || '', 'hermes', 'state.db'),
  );
  readonly hermesSessionsPath = resolve(
    process.env.AIMONITOR_HERMES_SESSIONS_PATH?.trim()
      || join(process.env.LOCALAPPDATA || '', 'hermes', 'sessions'),
  );
  readonly codexBackfillMinutes = numberValue(process.env.AIMONITOR_CODEX_BACKFILL_MINUTES, 120);
  readonly ingestToken = process.env.AIMONITOR_INGEST_TOKEN || '';
  readonly appriseUrls = (process.env.AIMONITOR_APPRISE_URLS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  readonly retryBaseSeconds = numberValue(process.env.AIMONITOR_RETRY_BASE_SECONDS, 5);
  readonly retryMaxSeconds = numberValue(process.env.AIMONITOR_RETRY_MAX_SECONDS, 3600);
  readonly webDistPath = resolve(this.projectRoot, 'apps/web/dist');

  private path(value: string): string {
    return resolve(this.projectRoot, value);
  }
}
