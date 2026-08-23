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
import type { ReplyRoute } from '../database/database.types';
import type { CreateInboundReplyDto } from './dto/create-inbound-reply.dto';
import { PlatformReplyDispatcherService } from './platform-reply-dispatcher.service';

const ROUTE_PATTERN = /\[AI-MONITOR-REPLY:([A-Za-z0-9_-]{43})\]/g;
const TASK_ID_PATTERN = /\[任务ID:([1-9][0-9]*)\]/g;

export const extractReplyToken = (body: string): string | null => {
  const matches = [...body.matchAll(ROUTE_PATTERN)];
  return matches.length === 1 ? matches[0]?.[1] || null : null;
};

export const extractReplyTaskId = (body: string): number | null => {
  const matches = [...body.matchAll(TASK_ID_PATTERN)];
  if (matches.length !== 1) return null;
  const value = Number(matches[0]?.[1]);
  return Number.isSafeInteger(value) ? value : null;
};

@Injectable()
export class RepliesService {
  private readonly deliveryDispatchTails = new Map<number, Promise<void>>();

  constructor(
    private readonly database: DatabaseService,
    private readonly openClaw: OpenClawProvider,
    private readonly dispatcher: PlatformReplyDispatcherService,
  ) {}

  async accept(input: CreateInboundReplyDto): Promise<Record<string, unknown>> {
    const text = input.text.trim();
    if (!text) throw new BadRequestException('reply text must not be empty');
    const token = extractReplyToken(input.reply_to_body);
    const taskId = extractReplyTaskId(input.reply_to_body);
    if (!token && taskId === null) {
      throw new BadRequestException('quoted message does not contain one valid AI Monitor reply route');
    }
    const route = token
      ? this.database.resolveReplyRoute(token)
      : taskId === null ? null : this.database.resolveReplyRouteForEvent(taskId);
    if (!route) {
      if (taskId !== null) {
        throw new BadRequestException(`任务 ${taskId} 当前不支持引用续接（仅支持 Codex CLI/Desktop 完成通知）`);
      }
      throw new NotFoundException('reply route was not found');
    }
    if (taskId !== null && route.event_id !== taskId) {
      throw new BadRequestException('quoted task ID does not match the reply route');
    }
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
      const result = await this.dispatchSerialized(route, text);
      this.database.markInboundReply(claimed.reply.id, 'accepted');
      return { ok: true, accepted: true, duplicate: false, ...result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.database.markInboundReply(claimed.reply.id, 'failed', message);
      if (error instanceof BadRequestException) throw error;
      throw new ServiceUnavailableException(`unable to continue the Codex conversation: ${message}`);
    }
  }

  private async dispatchSerialized(route: ReplyRoute, text: string): Promise<{ threadId: string; turnId: string }> {
    const previous = this.deliveryDispatchTails.get(route.delivery_id) ?? Promise.resolve();
    let releaseAfter = Promise.resolve();
    const dispatch = previous.then(async () => {
      const currentRoute = this.database.resolveReplyRoute(route.reply_token);
      if (!currentRoute) throw new Error('reply route disappeared before dispatch');
      const { writerReleased, ...result } = await this.dispatcher.dispatch(currentRoute, text);
      releaseAfter = writerReleased;
      if (currentRoute.client === 'codex-desktop' && !currentRoute.reply_thread_id) {
        const storedThreadId = this.database.setReplyThreadId(currentRoute.delivery_id, result.threadId);
        if (!storedThreadId) throw new Error('Codex reply fork id could not be persisted');
        if (storedThreadId !== result.threadId) {
          throw new Error('another server process persisted a different Codex reply fork');
        }
      }
      return result;
    });
    const tail = dispatch.then(
      () => releaseAfter,
      () => releaseAfter,
    ).then(() => undefined, () => undefined);
    this.deliveryDispatchTails.set(route.delivery_id, tail);
    void tail.finally(() => {
      if (this.deliveryDispatchTails.get(route.delivery_id) === tail) {
        this.deliveryDispatchTails.delete(route.delivery_id);
      }
    });
    return dispatch;
  }
}
