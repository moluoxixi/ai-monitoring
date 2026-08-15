import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppConfigService } from '../src/config/app-config.service';

const keys = [
  'AIMONITOR_RESOURCE_ROOT',
  'AIMONITOR_PROJECT_ROOT',
  'AIMONITOR_DATA_ROOT',
  'AIMONITOR_DB_PATH',
  'AIMONITOR_OPENCLAW_BINDINGS_PATH',
  'AIMONITOR_WEB_DIST_PATH',
  'AIMONITOR_CLAUDE_DESKTOP_TRANSCRIPTS_PATH',
  'AIMONITOR_HERMES_DESKTOP_LOG_PATH',
] as const;

describe('AppConfigService desktop paths', () => {
  const previous = new Map<string, string | undefined>();
  const temporary: string[] = [];

  afterEach(() => {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    previous.clear();
    for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  const setEnv = (values: Partial<Record<(typeof keys)[number], string>>): void => {
    for (const key of keys) previous.set(key, process.env[key]);
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
  };

  it('keeps resources read-only and resolves runtime files under dataRoot', () => {
    const resourceRoot = mkdtempSync(join(tmpdir(), 'ai-monitor-resources-'));
    const dataRoot = mkdtempSync(join(tmpdir(), 'ai-monitor-data-'));
    temporary.push(resourceRoot, dataRoot);
    setEnv({
      AIMONITOR_RESOURCE_ROOT: resourceRoot,
      AIMONITOR_DATA_ROOT: dataRoot,
      AIMONITOR_DB_PATH: 'data/monitor.db',
      AIMONITOR_OPENCLAW_BINDINGS_PATH: 'bindings.json',
      AIMONITOR_WEB_DIST_PATH: join(resourceRoot, 'web'),
    });

    const config = new AppConfigService();

    expect(config.resourceRoot).toBe(resourceRoot);
    expect(config.dataRoot).toBe(dataRoot);
    expect(config.projectRoot).toBe(resourceRoot);
    expect(config.dbPath).toBe(join(dataRoot, 'monitor.db'));
    expect(config.openClawBindingsPath).toBe(join(dataRoot, 'bindings.json'));
    expect(config.webDistPath).toBe(join(resourceRoot, 'web'));
  });

  it('accepts absolute paths without rebasing them', () => {
    const resourceRoot = mkdtempSync(join(tmpdir(), 'ai-monitor-resources-'));
    const dataRoot = mkdtempSync(join(tmpdir(), 'ai-monitor-data-'));
    const database = join(tmpdir(), 'ai-monitor-absolute.db');
    temporary.push(resourceRoot, dataRoot);
    setEnv({
      AIMONITOR_RESOURCE_ROOT: resourceRoot,
      AIMONITOR_DATA_ROOT: dataRoot,
      AIMONITOR_DB_PATH: database,
    });

    expect(new AppConfigService().dbPath).toBe(database);
  });

  it('accepts an explicit Hermes Desktop log path', () => {
    const logPath = join(tmpdir(), 'hermes-desktop.log');
    setEnv({ AIMONITOR_HERMES_DESKTOP_LOG_PATH: logPath });

    expect(new AppConfigService().hermesDesktopLogPath).toBe(logPath);
  });

  it('uses an explicit Claude Desktop transcript root', () => {
    const transcriptsPath = join(tmpdir(), 'claude-transcripts');
    setEnv({
      AIMONITOR_CLAUDE_DESKTOP_TRANSCRIPTS_PATH: `  ${transcriptsPath}  `,
    });

    const config = new AppConfigService();

    expect(config.claudeDesktopTranscriptsPath).toBe(resolve(transcriptsPath));
  });
});
