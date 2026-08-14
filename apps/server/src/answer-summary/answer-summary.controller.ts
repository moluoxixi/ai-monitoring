import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { AnswerSummaryService } from './answer-summary.service';
import { UpdateAnswerSummaryOrderDto } from './dto/update-answer-summary-order.dto';
import { UpdateAnswerSummaryProviderDto } from './dto/update-answer-summary-provider.dto';

@Controller('api/answer-summary')
export class AnswerSummaryController {
  constructor(private readonly answerSummary: AnswerSummaryService) {}

  @Get()
  status() {
    return this.answerSummary.status();
  }

  @Put('providers/:provider')
  updateProvider(@Param('provider') provider: string, @Body() body: UpdateAnswerSummaryProviderDto) {
    return this.answerSummary.updateProvider(provider, body);
  }

  @Delete('providers/:provider')
  removeProvider(@Param('provider') provider: string) {
    return this.answerSummary.removeProvider(provider);
  }

  @Put('order')
  updateOrder(@Body() body: UpdateAnswerSummaryOrderDto) {
    return this.answerSummary.updateOrder(body.order);
  }
}
