import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { SpanStatusCode } from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeTracerProvider, SimpleSpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace-node';
import { AppConfigService } from '../config/app-config.service';
import type { NormalizedEvent } from '../database/database.types';

export const PHOENIX_TASK_SPAN_EXPORTER = Symbol('PHOENIX_TASK_SPAN_EXPORTER');

@Injectable()
export class PhoenixTaskTraceService implements OnModuleDestroy {
  private readonly logger = new Logger(PhoenixTaskTraceService.name);
  private readonly provider: NodeTracerProvider;
  private readonly tracer;
  private flushQueue = Promise.resolve(true);

  constructor(
    config: AppConfigService,
    @Optional() @Inject(PHOENIX_TASK_SPAN_EXPORTER) exporter?: SpanExporter,
  ) {
    const spanExporter = exporter || new OTLPTraceExporter({
      url: `${config.phoenixUrl.replace(/\/+$/, '')}/v1/traces`,
      headers: { 'x-phoenix-project-name': config.phoenixProject },
      timeoutMillis: 3_000,
    });
    this.provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        'service.name': 'ai-monitor-codex-session-watcher',
        'openinference.project.name': config.phoenixProject,
      }),
      spanProcessors: [new SimpleSpanProcessor(spanExporter)],
      forceFlushTimeoutMillis: 3_000,
    });
    this.tracer = this.provider.getTracer('ai-monitoring.codex-session');
  }

  record(event: NormalizedEvent, startedAtMs: number | null, completedAtMs: number | null): string {
    const threadId = this.text(event.metadata.thread_id);
    const turnId = this.text(event.metadata.turn_id);
    if (!threadId || !turnId) return '';
    const end = completedAtMs || Date.now();
    const start = Math.min(startedAtMs || end, end);
    const span = this.tracer.startSpan('codex.turn', {
      startTime: new Date(start),
      attributes: {
        'openinference.span.kind': 'AGENT',
        'session.id': threadId,
        'codex.thread.id': threadId,
        'codex.turn.id': turnId,
        'codex.turn.status': event.status,
        'ai.monitor.source': event.source,
      },
    });
    if (event.status === 'completed') {
      span.setStatus({ code: SpanStatusCode.OK });
    } else {
      const failure = this.text(event.metadata.failure_message) || event.status;
      span.setAttribute('error.type', event.error_code || `codex.turn.${event.status}`);
      span.setAttribute('error.message', failure);
      span.setStatus({ code: SpanStatusCode.ERROR, message: failure });
    }
    const traceId = span.spanContext().traceId;
    span.end(new Date(end));
    this.flushQueue = this.flushQueue
      .then(() => this.provider.forceFlush())
      .then(() => true)
      .catch((error: unknown): false => {
        this.logger.warn(`Unable to export Codex task trace: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      });
    return traceId;
  }

  async onModuleDestroy(): Promise<void> {
    await this.flush();
    await this.provider.shutdown().catch((error: unknown) => {
      this.logger.warn(`Unable to shut down task trace exporter: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  async flush(): Promise<boolean> {
    return this.flushQueue;
  }

  private text(value: unknown): string {
    return typeof value === 'string' && value.length <= 2_000 ? value : '';
  }
}
