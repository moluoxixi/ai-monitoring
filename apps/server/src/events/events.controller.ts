import { Body, Controller, Get, NotFoundException, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { ChannelsService } from '../channels/channels.service';
import { DatabaseService } from '../database/database.service';
import { PlatformsService } from '../platforms/platforms.service';
import { CreateEventDto } from './dto/create-event.dto';
import { normalizeEvent } from './event-normalizer';

@Controller('api')
export class EventsController {
  constructor(
    private readonly database: DatabaseService,
    private readonly channels: ChannelsService,
    private readonly platforms: PlatformsService,
  ) {}

  @Get('stats')
  stats() {
    return this.database.stats();
  }

  @Get('events')
  events(@Query('limit') limit?: string, @Query('client') client?: string) {
    return this.database.listEvents(Number(limit || 100), client);
  }

  @Get('deliveries')
  deliveries(@Query('limit') limit?: string, @Query('client') client?: string) {
    return this.database.listDeliveries(Number(limit || 100), client);
  }

  @Post('events')
  ingest(@Body() body: CreateEventDto) {
    const event = normalizeEvent(body);
    const resolved = this.platforms.resolve(event.client);
    if (resolved !== 'other') event.client = resolved;
    const [eventId, inserted] = this.database.insertEvent(event, this.channels.channelsForClient(event.client));
    return { ok: true, event_id: eventId, inserted };
  }

  @Post('test-notification')
  testNotification(@Body() body: { client?: string }) {
    const client = body.client && this.platforms.resolve(body.client) !== 'other' ? this.platforms.resolve(body.client) : 'codex';
    const event = normalizeEvent({
      source: 'dashboard',
      client,
      event_id: `dashboard:test:${Date.now()}`,
      kind: 'test_notification',
      status: 'completed',
      title: 'AI Monitor 测试通知',
      message: `${this.platforms.get(client).definition.label} 的本地通知链路工作正常。`,
      metadata: { manual: true },
    });
    const selected = this.channels.channelsForClient(client);
    const [eventId, inserted] = this.database.insertEvent(event, selected);
    return { ok: true, event_id: eventId, inserted, channels: selected };
  }

  @Post('deliveries/:id/retry')
  retry(@Param('id', ParseIntPipe) id: number) {
    if (!this.database.retryDelivery(id)) throw new NotFoundException('delivery not found');
    return { ok: true, delivery_id: id };
  }
}
