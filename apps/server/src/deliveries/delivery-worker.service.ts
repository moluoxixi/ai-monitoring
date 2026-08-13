import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { AppConfigService } from '../config/app-config.service';
import { ChannelsService } from '../channels/channels.service';
import { DatabaseService, utcNow } from '../database/database.service';
import type { DeliveryRow } from '../database/database.types';

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
      for (const delivery of this.database.dueDeliveries(utcNow(), 20)) {
        await this.deliver(delivery);
      }
    } catch (error) {
      this.logger.error('Delivery loop failed', error instanceof Error ? error.stack : undefined);
    } finally {
      this.processing = false;
    }
  }

  private async deliver(row: DeliveryRow): Promise<void> {
    const attempts = row.attempts + 1;
    try {
      const body = this.formatBody(row);
      await this.channels.send(row.channel, row.title, body);
      const now = utcNow();
      this.database.markDelivery(row.id, {
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
      this.database.markDelivery(row.id, {
        state: attempts >= 10 ? 'dead' : 'retrying',
        attempts,
        nextAttemptAt,
        lastError: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
      });
    }
  }

  private formatBody(row: DeliveryRow): string {
    let body = `[${row.client}] ${row.status}\n${row.message}`;
    if (row.error_code) body += `\nerror_code: ${row.error_code}`;
    return body.slice(0, 12_000);
  }
}
