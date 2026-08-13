import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChannelsModule } from '../channels/channels.module';
import { DatabaseModule } from '../database/database.module';
import { DashboardController } from './dashboard.controller';

@Module({
  imports: [AuthModule, DatabaseModule, ChannelsModule],
  controllers: [DashboardController],
})
export class DashboardModule {}
