import { Injectable } from '@nestjs/common';
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
  readonly clientConfigPath = this.path(process.env.AIMONITOR_CLIENT_CONFIG_PATH || 'data/client-config.json');
  readonly openClawBindingsPath = this.path(
    process.env.AIMONITOR_OPENCLAW_BINDINGS_PATH || 'data/openclaw-channels.json',
  );
  readonly phoenixUrl = process.env.AIMONITOR_PHOENIX_URL?.trim() || 'http://127.0.0.1:6006';
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
