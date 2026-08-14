import { Module } from '@nestjs/common';
import { AppriseProvider } from './apprise.provider';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';
import { OpenClawProvider } from './openclaw.provider';
import { ProcessRunnerService } from './process-runner.service';
import { PushPlusProvider } from './pushplus.provider';

@Module({
  controllers: [ChannelsController],
  providers: [ProcessRunnerService, AppriseProvider, PushPlusProvider, OpenClawProvider, ChannelsService],
  exports: [ChannelsService],
})
export class ChannelsModule {}
