import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { ChannelsService } from '../channels/channels.service';
import { DatabaseService } from '../database/database.service';
import { CreatePlatformDto } from './dto/create-platform.dto';
import { UpdatePlatformDto } from './dto/update-platform.dto';
import type { PlatformDefinition } from './platform.types';
import { PlatformsService } from './platforms.service';
import { AppConfigService } from '../config/app-config.service';

@Controller('api/clients')
export class PlatformsController {
  constructor(
    private readonly platforms: PlatformsService,
    private readonly channels: ChannelsService,
    private readonly database: DatabaseService,
    private readonly config: AppConfigService,
  ) {}

  @Get()
  async list() {
    const channelData = await this.channels.status();
    const statuses = new Map(channelData.map((item) => [item.id, item]));
    return {
      channels: channelData,
      clients: this.platforms.definitions().map((definition) => {
        const card = this.card(definition);
        const deliveries = this.database.listDeliveries(20, definition.key);
        const deliveryByEvent = new Map(deliveries.map((item) => [item.event_id, item]));
        const messages = this.database.listEvents(5, definition.key).map((event) => {
          const delivery = deliveryByEvent.get(event.id);
          return {
            ...event,
            delivery_state: delivery?.state || 'not_configured',
            delivery_time: delivery ? delivery.sent_at || delivery.next_attempt_at : null,
          };
        });
        return {
          ...card,
          channel_status: statuses.get(card.channel || '') || {
            id: card.channel, label: '未配置', bound: false, error: false, bindingMode: 'none',
          },
          messages,
        };
      }),
    };
  }

  @Post()
  async create(@Body() body: CreatePlatformDto) {
    const record = this.platforms.create(body.key, body.label, body.aliases);
    return { ok: true, ...this.card(record.definition) };
  }

  @Put(':key')
  update(@Param('key') key: string, @Body() body: UpdatePlatformDto) {
    if (body.channel && !this.channels.availableChannels().includes(body.channel)) {
      throw new BadRequestException('unknown notification channel');
    }
    const current = this.platforms.get(key);
    const binding = this.platforms.update(key, typeof body.channel === 'string' && body.channel ? body.channel : null);
    return { ok: true, key: current.definition.key, channel: binding.channel, detail_url: this.config.phoenixUrl };
  }

  @Delete(':key')
  @HttpCode(200)
  delete(@Param('key') key: string) {
    this.platforms.delete(key);
    return { ok: true, key };
  }

  private card(definition: PlatformDefinition) {
    const binding = this.platforms.get(definition.key).binding;
    return {
      key: definition.key,
      label: definition.label,
      aliases: definition.aliases,
      custom: definition.custom,
      integration: definition.integration,
      channel: binding.channel,
      detail_url: this.config.phoenixUrl,
    };
  }
}
