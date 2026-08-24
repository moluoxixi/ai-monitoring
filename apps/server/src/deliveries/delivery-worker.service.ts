import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { AppConfigService } from '../config/app-config.service';
import { ChannelsService } from '../channels/channels.service';
import { DeliveryOutcomeUnknownError } from '../channels/channel-provider';
import { DatabaseService, utcNow } from '../database/database.service';
import type { DeliveryRow } from '../database/database.types';
import { cleanAnswerText, truncateText } from '../utils/event-text';
import { formatEventTiming } from '../utils/event-timing';
import { UserSettingsService } from '../settings/user-settings.service';
import { DEFAULT_RESULT_LIMIT, DEFAULT_TASK_LIMIT, type NotificationSettings } from '../settings/user-settings.types';
const LEASE_MS = 5 * 60_000;
const LEASE_RENEWAL_MS = 60_000;
const MAX_IN_FLIGHT_DELIVERIES = 4;
const SHUTDOWN_GRACE_MS = 5_000;

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

const clientLabel = (client: string): string => ({
  'codex-cli': 'Codex CLI', 'codex-desktop': 'Codex Desktop',
  'claude-cli': 'Claude CLI', 'claude-desktop': 'Claude Desktop',
  'qoder-cli': 'Qoder CLI', 'qoder-desktop': 'Qoder Desktop', 'qoder-quest': 'Qoder Quest',
  'hermes-cli': 'Hermes CLI', 'hermes-desktop': 'Hermes Desktop',
  'cursor-cli': 'Cursor CLI', 'cursor-desktop': 'Cursor Desktop',
}[client] || client);
const statusLabel = (status: string): string => ({
  completed: '任务已完成', failed: '任务失败', interrupted: '任务已中断', tool_failed: '调用失败', unknown: '任务状态未知',
})[status] || status;

export const notificationContent = (
  row: DeliveryRow,
  limits: NotificationSettings = { taskLimit: DEFAULT_TASK_LIMIT, resultLimit: DEFAULT_RESULT_LIMIT },
): { title: string; body: string } => {
  const taskSummary = cleanText(row.metadata?.task_summary);
  const answer = typeof row.answer_text === 'string'
    ? cleanAnswerText(row.answer_text).replace(/\n{3,}/g, '\n\n')
    : '';
  const message = cleanText(row.message);
  const summary = taskSummary || message || cleanText(row.title);
  const timing = row.channel === 'openclaw-qq'
    ? ''
    : formatEventTiming(row.metadata, row.event_created_at);
  const withTiming = (content: string): string => timing ? `${timing}\n${content}` : content;
  const automationId = cleanText(row.metadata?.automation_id);
  if (row.status === 'completed' && automationId && row.metadata?.automation_decision === 'NOTIFY') {
    return {
      title: `${automationId} 有新进展`,
      body: withTiming(truncateText(answer || message || '未提供进展内容', limits.resultLimit)),
    };
  }
  const failureMessage = cleanText(row.metadata?.failure_message)
    || cleanText(row.metadata?.error)
    || (message !== taskSummary ? message : '')
    || cleanText(row.error_code)
    || '未提供失败信息';
  const failed = ['failed', 'tool_failed'].includes(row.status);
  return {
    title: `(${clientLabel(row.client)}) ${statusLabel(row.status)}`,
    body: withTiming(failed
      ? `提问：${truncateText(summary || '未提供', limits.taskLimit)}\n失败消息：${truncateText(failureMessage, limits.resultLimit)}`
      : `提问：${truncateText(summary || '未提供', limits.taskLimit)}\n任务结果：${truncateText(answer || '未采集到最终回答', limits.resultLimit)}`),
  };
};

export const withReplyRoute = (body: string, taskId: number): string => [
  `[任务ID:${taskId}]`,
  body,
].join('\n\n');

@Injectable()
export class DeliveryWorkerService implements OnModuleDestroy {
  private readonly logger = new Logger(DeliveryWorkerService.name);
  private readonly inFlight = new Set<Promise<void>>();
  private stopping = false;
  private abandoning = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly channels: ChannelsService,
    private readonly config: AppConfigService,
    @Optional() private readonly settings?: UserSettingsService,
  ) {}

  @Interval(1500)
  processOnce(): void {
    if (this.stopping) return;
    const capacity = MAX_IN_FLIGHT_DELIVERIES - this.inFlight.size;
    if (capacity <= 0) return;
    try {
      for (const delivery of this.database.claimDueDeliveries(utcNow(), capacity, LEASE_MS)) {
        this.startDelivery(delivery);
      }
    } catch (error) {
      this.logger.error('Delivery loop failed', error instanceof Error ? error.stack : undefined);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (!this.inFlight.size) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      Promise.allSettled([...this.inFlight]).then(() => false),
      new Promise<true>((resolve) => {
        timer = setTimeout(() => resolve(true), SHUTDOWN_GRACE_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) {
      this.abandoning = true;
      this.logger.warn(`Shutdown continued with ${this.inFlight.size} delivery send(s) still in flight`);
    }
  }

  private startDelivery(row: DeliveryRow): void {
    let task: Promise<void>;
    task = this.deliver(row)
      .catch((error: unknown) => {
        this.logger.error('Delivery execution failed', error instanceof Error ? error.stack : undefined);
      })
      .finally(() => this.inFlight.delete(task));
    this.inFlight.add(task);
  }

  private async deliver(row: DeliveryRow): Promise<void> {
    if (!row.lease_token) return;
    if (!this.database.renewClaimedDelivery(row.id, row.lease_token, utcNow(), LEASE_MS)) return;
    // A follow-up turn may have suppressed this provisional delivery after it
    // was claimed. Do not create an external side effect for a stale claim.
    if (!this.database.isClaimedDeliveryActive(row.id, row.lease_token)) return;
    const attempts = row.attempts + 1;
    const renewal = setInterval(() => {
      if (this.abandoning) return;
      try {
        this.database.renewClaimedDelivery(row.id, row.lease_token!, utcNow(), LEASE_MS);
      } catch {
        // The original lease still protects the in-flight send until its expiry.
      }
    }, LEASE_RENEWAL_MS);
    renewal.unref();
    try {
      const notification = notificationContent(row, this.settings?.notification());
      this.database.ensureDeliveryReplyRoute(row.id, this.config.replyRouteTtlMs);
      const body = withReplyRoute(notification.body, row.event_id);
      await this.channels.send(row.channel, notification.title, body);
      if (this.abandoning) return;
      const now = utcNow();
      this.database.markClaimedDelivery(row.id, row.lease_token, {
        state: 'sent',
        attempts,
        nextAttemptAt: now,
        sentAt: now,
      });
    } catch (error) {
      if (this.abandoning) return;
      if (error instanceof DeliveryOutcomeUnknownError) {
        const now = utcNow();
        this.database.markClaimedDelivery(row.id, row.lease_token, {
          state: 'dead',
          attempts,
          nextAttemptAt: now,
          lastError: error.message.slice(0, 2000),
        });
        return;
      }
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
