import { SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-node';
import { describe, expect, it } from 'vitest';
import type { AppConfigService } from '../src/config/app-config.service';
import type { NormalizedEvent } from '../src/database/database.types';
import { PhoenixTaskTraceService } from '../src/events/phoenix-task-trace.service';

const event = (status = 'completed'): NormalizedEvent => ({
  source_event_id: `session:turn:${status}`,
  source: 'codex-session',
  client: 'codex',
  kind: 'task_complete',
  status,
  title: 'Codex task completed',
  message: 'done',
  error_code: status === 'completed' ? null : 'server_overloaded',
  metadata: {
    thread_id: 'session-1',
    turn_id: 'turn-1',
    ...(status === 'completed' ? {} : { failure_message: 'safe failure' }),
  },
});

const serviceFor = () => {
  const exporter = new InMemorySpanExporter();
  const service = new PhoenixTaskTraceService({
    phoenixUrl: 'http://127.0.0.1:6006',
    phoenixProject: 'ai-coding-agents',
  } as AppConfigService, exporter);
  return { exporter, service };
};

describe('PhoenixTaskTraceService', () => {
  it('exports a completed Codex lifecycle span and returns its trace id', async () => {
    const { exporter, service } = serviceFor();
    const traceId = service.record(event(), 1_786_635_348_000, 1_786_635_370_000);
    await service.flush();
    expect(exporter.getFinishedSpans()).toHaveLength(1);

    const span = exporter.getFinishedSpans()[0]!;
    expect(traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(span.spanContext().traceId).toBe(traceId);
    expect(span.attributes).toMatchObject({
      'session.id': 'session-1',
      'codex.turn.id': 'turn-1',
      'codex.turn.status': 'completed',
    });
    expect(span.status.code).toBe(SpanStatusCode.OK);
    await service.onModuleDestroy();
  });

  it('marks failed lifecycle spans without exposing unredacted input', async () => {
    const { exporter, service } = serviceFor();
    service.record(event('failed'), null, null);
    await service.flush();
    expect(exporter.getFinishedSpans()).toHaveLength(1);

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.status).toMatchObject({ code: SpanStatusCode.ERROR, message: 'safe failure' });
    expect(span.attributes).toMatchObject({
      'error.type': 'server_overloaded',
      'error.message': 'safe failure',
    });
    await service.onModuleDestroy();
  });
});
