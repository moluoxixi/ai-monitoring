import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { ChannelsModule } from './channels/channels.module';
import { ConfigModule } from './config/config.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DatabaseModule } from './database/database.module';
import { DeliveriesModule } from './deliveries/deliveries.module';
import { EventsModule } from './events/events.module';
import { PlatformsController } from './platforms/platforms.controller';
import { PlatformsModule } from './platforms/platforms.module';

@Module({
  imports: [
    ConfigModule,
    AuthModule,
    ScheduleModule.forRoot(),
    PlatformsModule,
    DatabaseModule,
    ChannelsModule,
    EventsModule,
    DeliveriesModule,
    DashboardModule,
  ],
  controllers: [PlatformsController],
})
export class AppModule {}
