import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { OpenClawProvider } from '../channels/openclaw.provider';
import { DatabaseService } from '../database/database.service';
import type { CreateInboundReplyDto } from './dto/create-inbound-reply.dto';
import { PlatformReplyDispatcherService } from './platform-reply-dispatcher.service';

const ROUTE_PATTERN = /\[AI-MONITOR-REPLY:([A-Za-z0-9_-]{43})\]/g;

export const extractReplyToken = (body: string): string | null => {
  const matches = [...body.matchAll(ROUTE_PATTERN)];
  return matches.length === 1 ? matches[0]?.[1] || null : null;
};

@Injectable()
export class RepliesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly openClaw: OpenClawProvider,
    private readonly dispatcher: PlatformReplyDispatcherService,
  ) {}

  async accept(input: CreateInboundReplyDto): Promise<Record<string, unknown>> {
    const text = input.text.trim();
    if (!text) throw new BadRequestException('reply text must not be empty');
    const token = extractReplyToken(input.reply_to_body);
    if (!token) throw new BadRequestException('quoted message does not contain one valid AI Monitor reply token');
    const route = this.database.resolveReplyRoute(token);
    if (!route) throw new NotFoundException('reply route was not found');
    if (!Number.isFinite(Date.parse(route.reply_expires_at)) || Date.parse(route.reply_expires_at) <= Date.now()) {
      throw new GoneException('reply route has expired');
    }
    if (route.delivery_state !== 'sent') throw new ConflictException('the original notification has not completed delivery');
    if (!this.openClaw.matchesQqBinding(input.sender_id, input.account_id)) {
      throw new ForbiddenException('QQ sender or account does not match the notification binding');
    }

    const claimed = this.database.claimInboundReply({
      channel: input.channel,
      externalMessageId: input.message_id,
      deliveryId: route.delivery_id,
      senderId: input.sender_id,
      accountId: input.account_id,
      text,
    });
    if (!claimed.inserted) {
      if (
        claimed.reply.delivery_id !== route.delivery_id
        || claimed.reply.sender_id !== input.sender_id
        || claimed.reply.account_id !== input.account_id
      ) {
        throw new ConflictException('QQ message id is already associated with another reply route');
      }
      if (claimed.reply.state === 'failed') throw new ConflictException('this QQ reply previously failed and will not be replayed automatically');
      return { ok: true, accepted: claimed.reply.state === 'accepted', duplicate: true };
    }

    try {
      const result = await this.dispatcher.dispatch(route, text);
      this.database.markInboundReply(claimed.reply.id, 'accepted');
      return { ok: true, accepted: true, duplicate: false, ...result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.database.markInboundReply(claimed.reply.id, 'failed', message);
      if (error instanceof BadRequestException) throw error;
      throw new ServiceUnavailableException(`unable to resume the Codex conversation: ${message}`);
    }
  }
}
