import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { DatabaseModule } from '../database/database.module';
import { ExtensionsModule } from '../extensions/extensions.module';
import { EventsController } from './events.controller';
import { CodexSessionWatcherService } from './codex-session-watcher.service';
import { EventIngestionService } from './event-ingestion.service';
import { ClaudeDesktopTranscriptWatcherService } from './claude-desktop-audit-watcher.service';
import { HermesDesktopStateWatcherService } from './hermes-desktop-state-watcher.service';
import { QoderSessionWatcherService } from './qoder-session-watcher.service';

@Module({
  imports: [DatabaseModule, ChannelsModule, ExtensionsModule],
  controllers: [EventsController],
  providers: [
    CodexSessionWatcherService,
    ClaudeDesktopTranscriptWatcherService,
    HermesDesktopStateWatcherService,
    QoderSessionWatcherService,
    EventIngestionService,
  ],
})
export class EventsModule {}
