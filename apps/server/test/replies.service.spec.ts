import { BadRequestException, ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../src/config/app-config.service';
import type { DatabaseService } from '../src/database/database.service';
import type { OpenClawProvider } from '../src/channels/openclaw.provider';
import type { PlatformReplyDispatcherService } from '../src/replies/platform-reply-dispatcher.service';
import { PlatformReplyDispatcherService as ReplyDispatcher } from '../src/replies/platform-reply-dispatcher.service';
import { RepliesController } from '../src/replies/replies.controller';
import { extractReplyTaskId, extractReplyToken, RepliesService } from '../src/replies/replies.service';

const token = 'A'.repeat(43);
const input = {
  channel: 'openclaw-qq' as const,
  account_id: 'default', sender_id: 'user-1', message_id: 'message-1', text: 'continue',
  reply_to_body: `[AI-MONITOR-REPLY:${token}]`, reply_to_is_quote: true as const, is_group: false as const,
};

const serviceFor = (overrides: { bound?: boolean; duplicateState?: 'processing' | 'accepted' | 'failed' } = {}) => {
  const route = {
    delivery_id: 10, event_id: 5, channel: 'openclaw-qq', delivery_state: 'sent',
    reply_token: token, reply_expires_at: new Date(Date.now() + 60_000).toISOString(),
    client: 'codex-cli', metadata: { thread_id: 'thread-1' },
  };
  const database = {
    resolveReplyRoute: vi.fn(() => route),
    resolveReplyRouteForEvent: vi.fn(() => route),
    claimInboundReply: vi.fn(() => overrides.duplicateState
      ? { inserted: false, reply: {
        id: 7, state: overrides.duplicateState, delivery_id: 10, sender_id: 'user-1', account_id: 'default',
      } }
      : { inserted: true, reply: { id: 7, state: 'processing' } }),
    markInboundReply: vi.fn(),
  } as unknown as DatabaseService;
  const openClaw = {
    matchesQqBinding: vi.fn(() => overrides.bound ?? true),
  } as unknown as OpenClawProvider;
  const dispatcher = {
    dispatch: vi.fn(async () => ({ threadId: 'thread-1', turnId: 'turn-2' })),
  } as unknown as PlatformReplyDispatcherService;
  return { service: new RepliesService(database, openClaw, dispatcher), database, dispatcher };
};

describe('RepliesService', () => {
  it('extracts exactly one opaque route token', () => {
    expect(extractReplyToken(input.reply_to_body)).toBe(token);
    expect(extractReplyToken(`${input.reply_to_body}${input.reply_to_body}`)).toBeNull();
  });

  it('extracts exactly one positive task ID', () => {
    expect(extractReplyTaskId('[任务ID:5]')).toBe(5);
    expect(extractReplyTaskId('[任务ID:5]\n[任务ID:5]')).toBeNull();
    expect(extractReplyTaskId('[任务ID:0]')).toBeNull();
  });

  it('validates the binding and dispatches one reply to the original route', async () => {
    const { service, database, dispatcher } = serviceFor();

    await expect(service.accept(input)).resolves.toMatchObject({
      ok: true, accepted: true, duplicate: false, threadId: 'thread-1', turnId: 'turn-2',
    });
    expect(dispatcher.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      delivery_id: 10, metadata: { thread_id: 'thread-1' },
    }), 'continue');
    expect(database.markInboundReply).toHaveBeenCalledWith(7, 'accepted');
  });

  it('resolves a reply by task ID when QQ omits the route token', async () => {
    const { service, database, dispatcher } = serviceFor();

    await expect(service.accept({ ...input, reply_to_body: '[任务ID:5]' })).resolves.toMatchObject({
      ok: true, accepted: true, duplicate: false,
    });
    expect(database.resolveReplyRoute).not.toHaveBeenCalled();
    expect(database.resolveReplyRouteForEvent).toHaveBeenCalledWith(5);
    expect(dispatcher.dispatch).toHaveBeenCalledOnce();
  });

  it('rejects task IDs that are not reply-enabled without dispatching', async () => {
    const { service, database, dispatcher } = serviceFor();
    vi.mocked(database.resolveReplyRouteForEvent).mockReturnValue(null);

    await expect(service.accept({ ...input, reply_to_body: '[任务ID:548]' }))
      .rejects.toThrow('任务 548 当前不支持引用续接');
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('rejects a task ID that conflicts with the opaque route token', async () => {
    const { service, dispatcher } = serviceFor();
    await expect(service.accept({ ...input, reply_to_body: `[任务ID:6]\n${input.reply_to_body}` }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('rejects a sender that does not match the QQ delivery binding', async () => {
    const { service, dispatcher } = serviceFor({ bound: false });
    await expect(service.accept(input)).rejects.toBeInstanceOf(ForbiddenException);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('does not replay an external message id that previously failed', async () => {
    const { service, dispatcher } = serviceFor({ duplicateState: 'failed' });
    await expect(service.accept(input)).rejects.toBeInstanceOf(ConflictException);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it('rejects quoted bodies without one valid route candidate', async () => {
    const { service } = serviceFor();
    await expect(service.accept({ ...input, reply_to_body: 'ordinary notification' }))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('RepliesController authentication', () => {
  it('fails closed when no reply or ingest token is configured', () => {
    const replies = { accept: vi.fn() };
    const controller = new RepliesController({ replyToken: '' } as AppConfigService, replies as never);
    expect(() => controller.inbound(undefined, input)).toThrow(UnauthorizedException);
    expect(replies.accept).not.toHaveBeenCalled();
  });

  it('accepts only the configured bearer token', async () => {
    const replies = { accept: vi.fn(async () => ({ ok: true })) };
    const controller = new RepliesController({ replyToken: 'reply-secret' } as AppConfigService, replies as never);
    expect(() => controller.inbound('Bearer wrong', input)).toThrow(UnauthorizedException);
    await expect(controller.inbound('Bearer reply-secret', input)).resolves.toEqual({ ok: true });
  });
});

describe('PlatformReplyDispatcherService', () => {
  it('rejects unsupported clients instead of guessing a resume protocol', () => {
    const codex = { dispatch: vi.fn() };
    const dispatcher = new ReplyDispatcher(codex as never);
    expect(() => dispatcher.dispatch({
      delivery_id: 1, event_id: 1, channel: 'openclaw-qq', delivery_state: 'sent',
      reply_token: token, reply_expires_at: new Date(Date.now() + 60_000).toISOString(),
      client: 'claude-cli', metadata: { session_id: 'session-1' },
    }, 'continue')).toThrow(BadRequestException);
    expect(codex.dispatch).not.toHaveBeenCalled();
  });
});
