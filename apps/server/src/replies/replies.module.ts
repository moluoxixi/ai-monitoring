import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { DatabaseModule } from '../database/database.module';
import {
  CODEX_PROCESS_FACTORY,
  CodexAppServerReplyService,
  defaultCodexProcessFactory,
} from './codex-app-server-reply.service';
import { PlatformReplyDispatcherService } from './platform-reply-dispatcher.service';
import { RepliesController } from './replies.controller';
import { RepliesService } from './replies.service';

@Module({
  imports: [DatabaseModule, ChannelsModule],
  controllers: [RepliesController],
  providers: [
    { provide: CODEX_PROCESS_FACTORY, useValue: defaultCodexProcessFactory },
    CodexAppServerReplyService,
    PlatformReplyDispatcherService,
    RepliesService,
  ],
})
export class RepliesModule {}
