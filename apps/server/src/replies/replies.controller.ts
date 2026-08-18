import { Body, Controller, Headers, HttpCode, HttpStatus, Post, UnauthorizedException } from '@nestjs/common';
import { Public } from '../auth/public.decorator';
import { safeEqual } from '../auth/auth.guard';
import { AppConfigService } from '../config/app-config.service';
import { CreateInboundReplyDto } from './dto/create-inbound-reply.dto';
import { RepliesService } from './replies.service';

@Controller('api/replies')
export class RepliesController {
  constructor(
    private readonly config: AppConfigService,
    private readonly replies: RepliesService,
  ) {}

  @Public()
  @Post('inbound')
  @HttpCode(HttpStatus.ACCEPTED)
  inbound(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: CreateInboundReplyDto,
  ): Promise<Record<string, unknown>> {
    if (!this.config.replyToken || !safeEqual(authorization || '', `Bearer ${this.config.replyToken}`)) {
      throw new UnauthorizedException('invalid or missing reply token');
    }
    return this.replies.accept(body);
  }
}
