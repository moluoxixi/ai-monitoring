import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { AppConfigService } from '../config/app-config.service';
import { ChannelsService } from '../channels/channels.service';
import { DatabaseService, utcNow } from '../database/database.service';
import type { DeliveryRow } from '../database/database.types';

const MESSAGE_LIMIT = 100;
const LEASE_MS = 5 * 60_000;
const LEASE_RENEWAL_MS = 60_000;

const cleanText = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const cleaned = value
    .replace(/<in-app-browser-context\b[^>]*>[\s\S]*?<\/in-app-browser-context>/gi, ' ')
    .replace(/##\s*My request:\s*/gi, ' ')
    .replace(/^\s*(?:提问|摘要)[：:]\s*/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^The following is the Codex agent history whose request action you are assessing\./i.test(cleaned)) return '';
  if (/^(?:Stop|StopFailure|PostToolUseFailure|Codex (?:turn|task) (?:completed|failed|was interrupted))$/i.test(cleaned)) return '';
  return cleaned;
};

const shorten = (value: string): string => {
  const characters = Array.from(value);
  return characters.length > MESSAGE_LIMIT ? `${characters.slice(0, MESSAGE_LIMIT - 3).join('').trimEnd()}...` : value;
};

const clientLabel = (client: string): string => ({ codex: 'Codex', claude: 'Claude', qoder: 'Qoder' })[client] || client;
const statusLabel = (status: string): string => ({
  completed: '任务已完成', failed: '任务失败', interrupted: '任务已中断', tool_failed: '调用失败', unknown: '任务状态未知',
})[status] || status;

export const notificationContent = (row: DeliveryRow): { title: string; body: string } => {
  const taskSummary = cleanText(row.metadata?.task_summary);
  const answerSummary = cleanText(row.metadata?.answer_summary);
  const message = cleanText(row.message);
  const summary = taskSummary || message || cleanText(row.title);
  const failureMessage = cleanText(row.metadata?.failure_message)
    || cleanText(row.metadata?.error)
    || (message !== taskSummary ? message : '')
    || cleanText(row.error_code)
    || '未提供失败信息';
  const failed = ['failed', 'tool_failed'].includes(row.status);
  return {
    title: `${clientLabel(row.client)} ${statusLabel(row.status)}`,
    body: failed
      ? `失败消息：${shorten(failureMessage)}`
      : `任务摘要：${shorten(summary || '未提供')}${answerSummary ? `\n回答摘要：${shorten(answerSummary)}` : ''}`,
  };
};

@Injectable()
export class DeliveryWorkerService {
  private readonly logger = new Logger(DeliveryWorkerService.name);
  private processing = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly channels: ChannelsService,
    private readonly config: AppConfigService,
  ) {}

  @Interval(1500)
  async processOnce(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      const byEvent = new Map<number, DeliveryRow[]>();
      for (const delivery of this.database.claimDueDeliveries(utcNow(), 20, LEASE_MS)) {
        const group = byEvent.get(delivery.event_id) || [];
        group.push(delivery);
        byEvent.set(delivery.event_id, group);
      }
      for (const deliveries of byEvent.values()) {
        await Promise.all(deliveries.map((delivery) => this.deliver(delivery)));
      }
    } catch (error) {
      this.logger.error('Delivery loop failed', error instanceof Error ? error.stack : undefined);
    } finally {
      this.processing = false;
    }
  }

  private async deliver(row: DeliveryRow): Promise<void> {
    if (!row.lease_token) return;
    if (!this.database.renewClaimedDelivery(row.id, row.lease_token, utcNow(), LEASE_MS)) return;
    const attempts = row.attempts + 1;
    const renewal = setInterval(() => {
      try {
        this.database.renewClaimedDelivery(row.id, row.lease_token!, utcNow(), LEASE_MS);
      } catch {
        // The original lease still protects the in-flight send until its expiry.
      }
    }, LEASE_RENEWAL_MS);
    renewal.unref();
    try {
      const notification = notificationContent(row);
      await this.channels.send(row.channel, notification.title, notification.body);
      const now = utcNow();
      this.database.markClaimedDelivery(row.id, row.lease_token, {
        state: 'sent',
        attempts,
        nextAttemptAt: now,
        sentAt: now,
      });
    } catch (error) {
      const delay = Math.min(
        this.config.retryMaxSeconds,
        this.config.retryBaseSeconds * 2 ** Math.min(attempts - 1, 10),
      );
      const jittered = Math.max(1, Math.floor(delay * (0.8 + Math.random() * 0.4)));
      const nextAttemptAt = new Date(Date.now() + jittered * 1000).toISOString().replace(/\.\d{3}Z$/, '+00:00');
      this.database.markClaimedDelivery(row.id, row.lease_token, {
        state: attempts >= 10 ? 'dead' : 'retrying',
        attempts,
        nextAttemptAt,
        lastError: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
      });
    } finally {
      clearInterval(renewal);
    }
  }

}
