import { Global, Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { UserSettingsService } from './user-settings.service';
import { ExtensionsModule } from '../extensions/extensions.module';

@Global()
@Module({
  imports: [ExtensionsModule],
  controllers: [SettingsController],
  providers: [UserSettingsService],
  exports: [UserSettingsService],
})
export class SettingsModule {}
