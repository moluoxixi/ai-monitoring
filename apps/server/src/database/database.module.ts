import { Module } from '@nestjs/common';
import { PlatformsModule } from '../platforms/platforms.module';
import { DatabaseService } from './database.service';

@Module({
  imports: [PlatformsModule],
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
