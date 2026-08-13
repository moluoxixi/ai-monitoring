import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { DatabaseModule } from '../database/database.module';
import { PlatformsModule } from '../platforms/platforms.module';
import { EventsController } from './events.controller';

@Module({
  imports: [DatabaseModule, ChannelsModule, PlatformsModule],
  controllers: [EventsController],
})
export class EventsModule {}
