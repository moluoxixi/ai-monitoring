import { Injectable } from '@nestjs/common';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

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
  readonly answerSummaryConfigPath = this.path(
    process.env.AIMONITOR_ANSWER_SUMMARY_CONFIG_PATH || 'data/answer-summary.json',
  );
  readonly answerSummaryTimeoutMs = Math.max(1_000, numberValue(process.env.AIMONITOR_ANSWER_SUMMARY_TIMEOUT_MS, 8_000));
  readonly answerSummaryGraceMs = Math.max(0, numberValue(process.env.AIMONITOR_ANSWER_SUMMARY_GRACE_MS, 1_500));
  readonly codexSessionsPath = resolve(process.env.AIMONITOR_CODEX_SESSIONS_PATH?.trim() || resolve(homedir(), '.codex', 'sessions'));
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
