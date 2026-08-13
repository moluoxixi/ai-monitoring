import { Module } from '@nestjs/common';
import { PlatformsModule } from '../platforms/platforms.module';
import { AppriseProvider } from './apprise.provider';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';
import { OpenClawProvider } from './openclaw.provider';
import { ProcessRunnerService } from './process-runner.service';

@Module({
  imports: [PlatformsModule],
  controllers: [ChannelsController],
  providers: [ProcessRunnerService, AppriseProvider, OpenClawProvider, ChannelsService],
  exports: [ChannelsService],
})
export class ChannelsModule {}
