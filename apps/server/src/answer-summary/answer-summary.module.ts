import { Module } from '@nestjs/common';
import { AnswerSummaryController } from './answer-summary.controller';
import { AnswerSummaryService } from './answer-summary.service';

@Module({
  controllers: [AnswerSummaryController],
  providers: [AnswerSummaryService],
  exports: [AnswerSummaryService],
})
export class AnswerSummaryModule {}
