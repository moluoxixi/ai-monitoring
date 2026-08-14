import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn } from 'class-validator';
import { ANSWER_SUMMARY_PROVIDER_IDS, type AnswerSummaryProviderId } from '../answer-summary.providers';

export class UpdateAnswerSummaryOrderDto {
  @IsArray()
  @ArrayMinSize(ANSWER_SUMMARY_PROVIDER_IDS.length)
  @ArrayMaxSize(ANSWER_SUMMARY_PROVIDER_IDS.length)
  @ArrayUnique()
  @IsIn(ANSWER_SUMMARY_PROVIDER_IDS, { each: true })
  order!: AnswerSummaryProviderId[];
}
