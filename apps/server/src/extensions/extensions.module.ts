import { Module } from '@nestjs/common';
import { ExtensionsService } from './extensions.service';

@Module({
  providers: [ExtensionsService],
  exports: [ExtensionsService],
})
export class ExtensionsModule {}
