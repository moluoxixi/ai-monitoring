import { BadRequestException, Injectable } from '@nestjs/common';
import type { ReplyRoute } from '../database/database.types';
import {
  CodexAppServerReplyService,
  type CodexReplyDispatchResult,
} from './codex-app-server-reply.service';

@Injectable()
export class PlatformReplyDispatcherService {
  constructor(private readonly codex: CodexAppServerReplyService) {}

  dispatch(route: ReplyRoute, text: string): Promise<CodexReplyDispatchResult> {
    if (!['codex-cli', 'codex-desktop'].includes(route.client)) {
      throw new BadRequestException(`reply routing is not supported for ${route.client}`);
    }
    const originalThreadId = route.metadata.thread_id;
    if (typeof originalThreadId !== 'string' || !originalThreadId.trim()) {
      throw new BadRequestException('the original Codex event does not contain a thread id');
    }
    const replyThreadId = route.reply_thread_id?.trim();
    return this.codex.dispatch({
      mode: 'fork',
      threadId: replyThreadId || originalThreadId.trim(),
      text,
    });
  }
}
