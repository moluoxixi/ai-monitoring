import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { DatabaseModule } from '../database/database.module';
import { DeliveryWorkerService } from './delivery-worker.service';

@Module({
  imports: [DatabaseModule, ChannelsModule],
  providers: [DeliveryWorkerService],
})
export class DeliveriesModule {}
