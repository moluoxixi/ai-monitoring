import { Controller, Get } from '@nestjs/common';
import { ChannelsService } from '../channels/channels.service';
import { AppConfigService } from '../config/app-config.service';
import { DatabaseService } from '../database/database.service';
import type { ExtensionDefinition } from './extension.types';
import { ExtensionsService } from './extensions.service';

@Controller('api/extensions')
export class ExtensionsController {
  constructor(
    private readonly extensions: ExtensionsService,
    private readonly channels: ChannelsService,
    private readonly database: DatabaseService,
    private readonly config: AppConfigService,
  ) {}

  @Get()
  async list() {
    const channelData = await this.channels.status();
    return {
      channels: channelData,
      extensions: this.extensions.definitions().map((definition) => ({
        ...this.card(definition),
        event_count: this.database.countEvents(definition.key),
      })),
    };
  }

  private card(definition: ExtensionDefinition) {
    return {
      key: definition.key,
      label: definition.label,
      aliases: definition.aliases,
      adapter: definition.adapter,
      detail_url: this.config.phoenixUrl,
    };
  }

}
