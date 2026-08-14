import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AnswerSummaryModule } from './answer-summary/answer-summary.module';
import { AuthModule } from './auth/auth.module';
import { ChannelsModule } from './channels/channels.module';
import { ConfigModule } from './config/config.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { DatabaseModule } from './database/database.module';
import { DeliveriesModule } from './deliveries/deliveries.module';
import { EventsModule } from './events/events.module';
import { ExtensionsController } from './extensions/extensions.controller';
import { ExtensionsModule } from './extensions/extensions.module';

@Module({
  imports: [
    ConfigModule,
    AuthModule,
    AnswerSummaryModule,
    ScheduleModule.forRoot(),
    ExtensionsModule,
    DatabaseModule,
    ChannelsModule,
    EventsModule,
    DeliveriesModule,
    DashboardModule,
  ],
  controllers: [ExtensionsController],
})
export class AppModule {}
