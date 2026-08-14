import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { AnswerSummaryService } from '../answer-summary/answer-summary.service';
import { AppConfigService } from '../config/app-config.service';
import { DatabaseService } from '../database/database.service';
import type { NormalizedEvent } from '../database/database.types';
import { ANSWER_SUMMARY_PROVIDER_IDS } from '../answer-summary/answer-summary.providers';
import { cleanAnswerSource } from '../answer-summary/answer-summary.service';

interface PendingEvent {
  event: NormalizedEvent;
  answerSource: string;
  channels: Set<string>;
  finalizing: boolean;
  expiry?: NodeJS.Timeout;
}

@Injectable()
export class EventIngestionService implements OnModuleDestroy {
  private readonly pending = new Map<string, PendingEvent>();
  private readonly tasks = new Set<Promise<void>>();

  constructor(
    private readonly database: DatabaseService,
    private readonly answerSummary: AnswerSummaryService,
    private readonly config: AppConfigService,
  ) {}

  ingest(event: NormalizedEvent, channels: string[], answerSource?: unknown): [number, boolean] {
    const metadataSource = event.metadata.answer_source;
    delete event.metadata.answer_source;
    delete event.metadata.answer_text;
    const source = typeof answerSource === 'string'
      ? answerSource
      : typeof metadataSource === 'string' ? metadataSource : '';
    if (event.status === 'completed' && source) event.metadata.answer_text = cleanAnswerSource(source);
    const existing = this.pending.get(event.source_event_id);
    if (existing) {
      if (!existing.answerSource && source) existing.answerSource = source;
      for (const channel of channels) existing.channels.add(channel);
      existing.event = { ...event, metadata: { ...existing.event.metadata, ...event.metadata } };
      const [eventId, inserted, deliveriesAdded] = this.database.insertEvent(
        event,
        channels,
        this.deliverySafetyDelayMs(),
      );
      if (!existing.finalizing && deliveriesAdded > 0) {
        if (existing.expiry) clearTimeout(existing.expiry);
        existing.finalizing = true;
        this.track(this.finalize(existing, eventId, 0));
      }
      return [eventId, inserted];
    }

    const grace = !source && event.client === 'codex' && event.status === 'completed'
      ? this.config.answerSummaryGraceMs
      : 0;
    const [eventId, inserted, deliveriesAdded] = this.database.insertEvent(event, channels, this.deliverySafetyDelayMs());
    const result: [number, boolean] = [eventId, inserted];
    if (!channels.length) {
      if (source) {
        const pending: PendingEvent = {
          event, answerSource: source, channels: new Set(), finalizing: false,
        };
        pending.expiry = setTimeout(() => {
          if (this.pending.get(event.source_event_id) === pending) this.pending.delete(event.source_event_id);
        }, this.deliverySafetyDelayMs());
        pending.expiry.unref();
        this.pending.set(event.source_event_id, pending);
      }
      return result;
    }
    if (!inserted && deliveriesAdded === 0) return result;

    const pending: PendingEvent = {
      event, answerSource: source, channels: new Set(channels), finalizing: true,
    };
    this.pending.set(event.source_event_id, pending);
    this.track(this.finalize(pending, eventId, grace));
    return result;
  }

  async onModuleDestroy(): Promise<void> {
    for (const pending of this.pending.values()) if (pending.expiry) clearTimeout(pending.expiry);
    await Promise.allSettled([...this.tasks]);
  }

  private track(task: Promise<void>): void {
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
  }

  private async finalize(pending: PendingEvent, eventId: number, delayMs: number): Promise<void> {
    if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    try {
      const enriched = await this.withSummaryTimeout(
        this.answerSummary.enrichEvent(pending.event, pending.answerSource),
      );
      this.database.insertEvent(enriched, [], 0);
    } catch {
      // The persisted delayed deliveries remain the no-summary fallback.
    } finally {
      try {
        this.database.releaseDeliveries(eventId);
      } catch {
        // A restart will release delayed deliveries once their due time passes.
      }
      if (this.pending.get(pending.event.source_event_id) === pending) {
        this.pending.delete(pending.event.source_event_id);
      }
    }
  }

  private async withSummaryTimeout(event: Promise<NormalizedEvent>): Promise<NormalizedEvent> {
    const timeoutMs = this.summaryTimeoutMs();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<NormalizedEvent>((_, reject) => {
      timer = setTimeout(() => reject(new Error('answer summary timed out')), timeoutMs);
      timer.unref();
    });
    try {
      return await Promise.race([event, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private deliverySafetyDelayMs(): number {
    return this.config.answerSummaryGraceMs + this.summaryTimeoutMs();
  }

  private summaryTimeoutMs(): number {
    return this.config.answerSummaryTimeoutMs * ANSWER_SUMMARY_PROVIDER_IDS.length + 1_000;
  }
}
