import { Module } from '@nestjs/common';
import { ExtensionsService } from './extensions.service';
import { PlatformScannerService } from './platform-scanner.service';

@Module({
  providers: [ExtensionsService, PlatformScannerService],
  exports: [ExtensionsService, PlatformScannerService],
})
export class ExtensionsModule {}
