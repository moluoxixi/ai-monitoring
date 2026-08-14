import { Module } from '@nestjs/common';
import { AnswerSummaryModule } from '../answer-summary/answer-summary.module';
import { ChannelsModule } from '../channels/channels.module';
import { DatabaseModule } from '../database/database.module';
import { ExtensionsModule } from '../extensions/extensions.module';
import { EventsController } from './events.controller';
import { CodexSessionWatcherService } from './codex-session-watcher.service';
import { EventIngestionService } from './event-ingestion.service';
import { PhoenixTraceLinkService } from './phoenix-trace-link.service';
import { PhoenixTaskTraceService } from './phoenix-task-trace.service';

@Module({
  imports: [AnswerSummaryModule, DatabaseModule, ChannelsModule, ExtensionsModule],
  controllers: [EventsController],
  providers: [CodexSessionWatcherService, EventIngestionService, PhoenixTaskTraceService, PhoenixTraceLinkService],
})
export class EventsModule {}
