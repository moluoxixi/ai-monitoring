import { BadRequestException, Injectable } from '@nestjs/common';
import type { ReplyRoute } from '../database/database.types';
import { CodexAppServerReplyService } from './codex-app-server-reply.service';

@Injectable()
export class PlatformReplyDispatcherService {
  constructor(private readonly codex: CodexAppServerReplyService) {}

  dispatch(route: ReplyRoute, text: string): Promise<{ threadId: string; turnId: string }> {
    if (route.client !== 'codex-cli') throw new BadRequestException(`reply routing is not supported for ${route.client}`);
    const threadId = route.metadata.thread_id;
    if (typeof threadId !== 'string' || !threadId.trim()) {
      throw new BadRequestException('the original Codex event does not contain a thread id');
    }
    return this.codex.dispatch(threadId.trim(), text);
  }
}
