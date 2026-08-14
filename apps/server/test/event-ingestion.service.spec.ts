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
});
