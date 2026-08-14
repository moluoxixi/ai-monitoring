import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { DatabaseModule } from '../database/database.module';
import { DeliveryWorkerService } from './delivery-worker.service';
import { SettingsModule } from '../settings/settings.module';

@Module({
  imports: [DatabaseModule, ChannelsModule, SettingsModule],
  providers: [DeliveryWorkerService],
})
export class DeliveriesModule {}
