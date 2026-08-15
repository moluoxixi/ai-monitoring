import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ChannelsService } from '../channels/channels.service';
import { DatabaseService } from '../database/database.service';
import { ExtensionsService } from '../extensions/extensions.service';
import { CreateEventDto } from './dto/create-event.dto';
import { normalizeEvent } from './event-normalizer';
import { EventIngestionService } from './event-ingestion.service';

@Controller('api')
export class EventsController {
  constructor(
    private readonly database: DatabaseService,
    private readonly channels: ChannelsService,
    private readonly extensions: ExtensionsService,
    private readonly ingestion: EventIngestionService,
  ) {}

  @Get('stats')
  stats() {
    return this.database.stats();
  }

  @Get('events')
  events(@Query('limit') limit?: string, @Query('client') client?: string) {
    return this.database.listEvents(Number(limit || 100), client);
  }

  @Get('events/:id')
  event(@Param('id', ParseIntPipe) id: number) {
    const event = this.database.getEvent(id, true);
    if (!event) throw new NotFoundException('event not found');
    return { ...event, deliveries: this.database.getDeliveriesForEvent(id) };
  }

  @Get('deliveries')
  deliveries(@Query('limit') limit?: string, @Query('client') client?: string) {
    return this.database.listDeliveries(Number(limit || 100), client);
  }

  @Post('events')
  ingest(@Body() body: CreateEventDto) {
    const event = normalizeEvent(body);
    const metadataRuntime = typeof event.metadata.runtime === 'string' ? event.metadata.runtime : undefined;
    const resolved = this.extensions.resolve(event.client, body.runtime || metadataRuntime);
    if (resolved === 'other') {
      const migrated = this.extensions.legacyMigration(event.client);
      if (migrated) {
        throw new BadRequestException(`client key "${event.client}" was migrated to "${migrated}"; send the canonical key`);
      }
    } else {
      event.client = resolved;
    }
    const [eventId, inserted] = this.ingestion.ingest(event, this.channels.deliveryChannels());
    return { ok: true, event_id: eventId, inserted };
  }

  @Post('test-notification')
  testNotification(@Body() body: { client?: string }) {
    const client = body.client && this.extensions.resolve(body.client) !== 'other' ? this.extensions.resolve(body.client) : 'codex-cli';
    const event = normalizeEvent({
      source: 'dashboard',
      client,
      event_id: `dashboard:test:${Date.now()}`,
      kind: 'test_notification',
      status: 'completed',
      title: 'AI Monitor 测试通知',
      message: `${this.extensions.get(client).label} 的本地通知链路工作正常。`,
      metadata: { manual: true },
    });
    const selected = this.ingestion.deliveryChannelsFor(client, this.channels.deliveryChannels());
    const [eventId, inserted] = this.ingestion.ingest(event, selected);
    return { ok: true, event_id: eventId, inserted, channels: selected };
  }

  @Post('deliveries/:id/retry')
  retry(@Param('id', ParseIntPipe) id: number) {
    if (!this.database.retryDelivery(id)) throw new NotFoundException('delivery not found');
    return { ok: true, delivery_id: id };
  }
}
