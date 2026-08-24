import { BadRequestException, Injectable } from '@nestjs/common';
import type { ReplyRoute } from '../database/database.types';
import {
  CodexAppServerReplyService,
} from './codex-app-server-reply.service';
import { ClaudeCliReplyService } from './claude-cli-reply.service';
import { QoderCliReplyService } from './qoder-cli-reply.service';
import type { ReplyDispatchResult } from './reply-dispatch.types';

@Injectable()
export class PlatformReplyDispatcherService {
  constructor(
    private readonly codex: CodexAppServerReplyService,
    private readonly claude: ClaudeCliReplyService,
    private readonly qoder: QoderCliReplyService,
  ) {}

  dispatch(route: ReplyRoute, text: string): Promise<ReplyDispatchResult> {
    if (['codex-cli', 'codex-desktop'].includes(route.client)) {
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
    if (['claude-cli', 'claude-desktop'].includes(route.client)) {
      const originalSessionId = route.metadata.session_id;
      if (
        typeof originalSessionId !== 'string'
        || !originalSessionId.trim()
        || originalSessionId.trim() === 'unknown-session'
      ) {
        throw new BadRequestException('the original Claude event does not contain a usable session id');
      }
      const cwd = typeof route.metadata.cwd === 'string' ? route.metadata.cwd.trim() : '';
      return this.claude.dispatch({
        sessionId: route.reply_thread_id?.trim() || originalSessionId.trim(),
        text,
        ...(cwd ? { cwd } : {}),
      });
    }
    if (route.client === 'qoder-cli') {
      const originalSessionId = route.metadata.session_id;
      if (
        typeof originalSessionId !== 'string'
        || !originalSessionId.trim()
        || originalSessionId.trim() === 'unknown-session'
      ) {
        throw new BadRequestException('the original Qoder event does not contain a usable session id');
      }
      const cwd = typeof route.metadata.cwd === 'string' ? route.metadata.cwd.trim() : '';
      return this.qoder.dispatch({
        sessionId: route.reply_thread_id?.trim() || originalSessionId.trim(),
        text,
        ...(cwd ? { cwd } : {}),
      });
    }
    throw new BadRequestException(`reply routing is not supported for ${route.client}`);
  }
}
