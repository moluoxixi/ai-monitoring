import { describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../src/config/app-config.service';
import type { DatabaseService } from '../src/database/database.service';
import type { NormalizedEvent } from '../src/database/database.types';
import { EventIngestionService } from '../src/events/event-ingestion.service';
import { ExtensionsService } from '../src/extensions/extensions.service';

const event = (metadata: Record<string, unknown> = {}): NormalizedEvent => ({
  source_event_id: 'session:turn:completed', source: 'codex', client: 'codex-cli', kind: 'complete', status: 'completed',
  title: 'done', message: 'task', error_code: null, metadata,
});

const serviceFor = (insertEvent = vi.fn(() => [7, true, 1])) => ({
  insertEvent,
  database: { insertEvent } as unknown as DatabaseService,
  config: { answerCaptureGraceMs: 1_500, recoverableFailureGraceMs: 600_000 } as AppConfigService,
  extensions: new ExtensionsService(),
  markMonitorVerified: vi.fn(),
});

describe('EventIngestionService', () => {
  it('persists a cleaned final answer and delays completed delivery briefly', () => {
    const setup = serviceFor();
    const service = new EventIngestionService(setup.database, setup.config, setup.extensions, { markMonitorVerified: setup.markMonitorVerified } as never);

    expect(service.ingest(event(), ['pushplus'], 'answer\nAuthorization: Bearer secret-token')).toEqual([7, true]);
    expect(setup.insertEvent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { answer_text: 'answer\nAuthorization: <redacted>' },
    }), ['pushplus'], 1_500);
    expect(setup.markMonitorVerified).toHaveBeenCalledWith('codex-cli', 'codex');
  });

  it('keeps the final answer when no notification channel is bound', () => {
    const setup = serviceFor(vi.fn(() => [7, true, 0]));
    const service = new EventIngestionService(setup.database, setup.config, setup.extensions, { markMonitorVerified: setup.markMonitorVerified } as never);

    service.ingest(event(), [], 'private final answer');

    expect(setup.insertEvent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: { answer_text: 'private final answer' },
    }), [], 1_500);
  });

  it('normalizes heartbeat findings before persistence and delivery', () => {
    const setup = serviceFor();
    const service = new EventIngestionService(setup.database, setup.config, setup.extensions, { markMonitorVerified: setup.markMonitorVerified } as never);

    service.ingest({
      ...event({ task_summary: '<heartbeat>internal prompt</heartbeat>' }),
      source: 'codex-session',
      client: 'codex-desktop',
    }, ['pushplus'], [
      '<heartbeat>',
      '<automation_id>vite-cli</automation_id>',
      '<decision>NOTIFY</decision>',
      '<message>Publish succeeded.</message>',
      '</heartbeat>',
    ].join('\n'));

    expect(setup.insertEvent).toHaveBeenCalledWith(expect.objectContaining({
      title: 'vite-cli 有新进展',
      message: 'Publish succeeded.',
      metadata: {
        task_summary: 'vite-cli',
        automation_id: 'vite-cli',
        automation_decision: 'NOTIFY',
        answer_text: 'Publish succeeded.',
      },
    }), ['pushplus'], 1_500);
  });

  it('keeps quiet heartbeat checks in history without creating notifications', () => {
    const setup = serviceFor(vi.fn(() => [7, true, 0]));
    const service = new EventIngestionService(setup.database, setup.config, setup.extensions, { markMonitorVerified: setup.markMonitorVerified } as never);

    service.ingest({
      ...event(),
      source: 'codex-session',
      client: 'codex-desktop',
    }, ['pushplus'], '<heartbeat><automation_id>vite-cli</automation_id><decision>DONT_NOTIFY</decision><message>Still running.</message></heartbeat>');

    expect(setup.insertEvent).toHaveBeenCalledWith(expect.objectContaining({
      title: 'vite-cli 状态检查',
      message: 'Still running.',
      metadata: expect.objectContaining({
        automation_decision: 'DONT_NOTIFY',
        notification_state: 'diagnostic',
        terminal: false,
      }),
    }), [], 1_500);
  });

  it('does not reinterpret heartbeat-shaped answers from other clients', () => {
    const setup = serviceFor();
    const service = new EventIngestionService(setup.database, setup.config, setup.extensions, { markMonitorVerified: setup.markMonitorVerified } as never);
    const answer = '<heartbeat><automation_id>vite-cli</automation_id><decision>DONT_NOTIFY</decision><message>Ordinary answer.</message></heartbeat>';

    service.ingest(event(), ['pushplus'], answer);

    expect(setup.insertEvent).toHaveBeenCalledWith(expect.objectContaining({
      title: 'done',
      message: 'task',
      metadata: { answer_text: answer },
    }), ['pushplus'], 1_500);
  });

  it('does not persist an answer attached to a failed event', () => {
    const setup = serviceFor(vi.fn(() => [7, true, 0]));
    const service = new EventIngestionService(setup.database, setup.config, setup.extensions, { markMonitorVerified: setup.markMonitorVerified } as never);

    service.ingest({ ...event({ answer_text: 'untrusted answer' }), status: 'failed' }, [], 'private answer');

    expect(setup.insertEvent).toHaveBeenCalledWith(expect.objectContaining({ metadata: {} }), [], 0);
  });

  it('uses a zero delivery delay for non-completed events', () => {
    const setup = serviceFor(vi.fn(() => [7, true, 1]));
    const service = new EventIngestionService(setup.database, setup.config, setup.extensions, { markMonitorVerified: setup.markMonitorVerified } as never);

    service.ingest({ ...event(), status: 'interrupted' }, ['pushplus'], 'ignored answer');

    expect(setup.insertEvent).toHaveBeenCalledWith(expect.objectContaining({ metadata: {} }), ['pushplus'], 0);
  });

  it('holds recoverable provider failures until a follow-up can supersede them', () => {
    const setup = serviceFor(vi.fn(() => [7, true, 1]));
    const service = new EventIngestionService(setup.database, setup.config, setup.extensions, { markMonitorVerified: setup.markMonitorVerified } as never);

    service.ingest({
      ...event({ session_id: 'session', failure_message: 'stream disconnected before completion' }),
      status: 'failed',
      message: 'stream disconnected before completion',
    }, ['pushplus']);

    expect(setup.insertEvent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ notification_state: 'provisional' }),
    }), ['pushplus'], 600_000);
  });

  it('does not create deliveries for tool-level diagnostics', () => {
    const setup = serviceFor(vi.fn(() => [7, true, 0]));
    const service = new EventIngestionService(setup.database, setup.config, setup.extensions, { markMonitorVerified: setup.markMonitorVerified } as never);

    service.ingest({ ...event(), status: 'tool_failed', metadata: { session_id: 'session' } }, ['pushplus']);

    expect(setup.insertEvent).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ notification_state: 'diagnostic' }),
    }), [], 0);
  });

  it('does not verify dashboard events and rejects non-canonical clients', () => {
    const setup = serviceFor();
    const service = new EventIngestionService(setup.database, setup.config, setup.extensions, { markMonitorVerified: setup.markMonitorVerified } as never);

    service.ingest({ ...event(), source: 'dashboard', client: 'codex-cli' }, []);
    expect(() => service.ingest({ ...event(), source: 'producer', client: 'unregistered-client' }, [])).toThrow('canonical extension key');

    expect(setup.markMonitorVerified).not.toHaveBeenCalled();
  });

  it('verifies a canonical Qoder Quest event independently', () => {
    const setup = serviceFor();
    const service = new EventIngestionService(setup.database, setup.config, setup.extensions, { markMonitorVerified: setup.markMonitorVerified } as never);

    service.ingest({ ...event(), source: 'qoder', client: 'qoder-quest' }, []);

    expect(setup.markMonitorVerified).toHaveBeenCalledWith('qoder-quest', 'qoder');
  });

  it('keeps hidden-platform events but does not create notification deliveries', () => {
    const setup = serviceFor(vi.fn(() => [7, true, 0]));
    const settings = {
      markMonitorVerified: setup.markMonitorVerified,
      snapshot: vi.fn(() => ({
        version: 1,
        notification: { taskLimit: 100, resultLimit: 2_000 },
        visibleExtensions: ['codex-cli'],
        visibleExtensionsConfigured: true,
        monitorVerification: {},
        hasVisiblePreference: true,
      })),
    };
    const scanner = {
      snapshot: vi.fn(() => ({
        scanScope: 'host',
        scanStatus: 'reliable',
        scannedAt: '2026-08-15T00:00:00.000Z',
        device: { os: 'windows', label: 'Windows', container: false },
        platforms: {
          'codex-cli': { detected: true, cliAvailable: true, running: false, monitorConfigured: true, detectionSignals: ['cli'] },
          'claude-cli': { detected: true, cliAvailable: true, running: false, monitorConfigured: true, detectionSignals: ['cli'] },
        },
      })),
    };
    const service = new EventIngestionService(setup.database, setup.config, setup.extensions, settings as never, scanner as never);

    service.ingest({ ...event(), source: 'claude', client: 'claude-cli' }, ['qq', 'pushplus']);

    expect(setup.insertEvent).toHaveBeenCalledWith(expect.objectContaining({ client: 'claude-cli' }), [], 1_500);
  });
});
