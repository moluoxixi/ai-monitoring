import { Module } from '@nestjs/common';
import { ExtensionsModule } from '../extensions/extensions.module';
import { DatabaseService } from './database.service';

@Module({
  imports: [ExtensionsModule],
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
