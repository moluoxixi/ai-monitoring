import { Body, Controller, Get, NotFoundException, Param, ParseIntPipe, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ChannelsService } from '../channels/channels.service';
import { DatabaseService } from '../database/database.service';
import { ExtensionsService } from '../extensions/extensions.service';
import { CreateEventDto } from './dto/create-event.dto';
import { normalizeEvent } from './event-normalizer';
import { EventIngestionService } from './event-ingestion.service';
import { PhoenixTraceLinkService } from './phoenix-trace-link.service';

@Controller('api')
export class EventsController {
  constructor(
    private readonly database: DatabaseService,
    private readonly channels: ChannelsService,
    private readonly extensions: ExtensionsService,
    private readonly traceLinks: PhoenixTraceLinkService,
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

  @Get('events/:id/trace')
  async trace(@Param('id', ParseIntPipe) id: number, @Res() response: Response): Promise<void> {
    const event = this.database.getEvent(id);
    if (!event) throw new NotFoundException('event not found');
    response.redirect(302, await this.traceLinks.resolve(event));
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
    const resolved = this.extensions.resolve(event.client);
    if (resolved !== 'other') event.client = resolved;
    const [eventId, inserted] = this.ingestion.ingest(event, this.channels.deliveryChannels());
    return { ok: true, event_id: eventId, inserted };
  }

  @Post('test-notification')
  testNotification(@Body() body: { client?: string }) {
    const client = body.client && this.extensions.resolve(body.client) !== 'other' ? this.extensions.resolve(body.client) : 'codex';
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
    const selected = this.channels.deliveryChannels();
    const [eventId, inserted] = this.database.insertEvent(event, selected);
    return { ok: true, event_id: eventId, inserted, channels: selected };
  }

  @Post('deliveries/:id/retry')
  retry(@Param('id', ParseIntPipe) id: number) {
    if (!this.database.retryDelivery(id)) throw new NotFoundException('delivery not found');
    return { ok: true, delivery_id: id };
  }
}
