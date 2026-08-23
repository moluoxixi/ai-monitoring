import { BadRequestException, ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../src/config/app-config.service';
import type { DatabaseService } from '../src/database/database.service';
import type { ReplyRoute } from '../src/database/database.types';
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

const serviceFor = (overrides: {
  bound?: boolean;
  client?: 'codex-cli' | 'codex-desktop';
  duplicateState?: 'processing' | 'accepted' | 'failed';
  replyThreadId?: string | null;
} = {}) => {
  const route: ReplyRoute = {
    delivery_id: 10, event_id: 5, channel: 'openclaw-qq', delivery_state: 'sent',
    reply_token: token, reply_expires_at: new Date(Date.now() + 60_000).toISOString(),
    reply_thread_id: overrides.replyThreadId ?? null,
    client: overrides.client ?? 'codex-cli', metadata: { thread_id: 'thread-1' },
  };
  const database = {
    resolveReplyRoute: vi.fn(() => ({ ...route, metadata: { ...route.metadata } })),
    resolveReplyRouteForEvent: vi.fn(() => ({ ...route, metadata: { ...route.metadata } })),
    claimInboundReply: vi.fn(() => overrides.duplicateState
      ? { inserted: false, reply: {
        id: 7, state: overrides.duplicateState, delivery_id: 10, sender_id: 'user-1', account_id: 'default',
      } }
      : { inserted: true, reply: { id: 7, state: 'processing' } }),
    setReplyThreadId: vi.fn((_deliveryId: number, threadId: string) => {
      if (!route.reply_thread_id) route.reply_thread_id = threadId;
      return route.reply_thread_id;
    }),
    markInboundReply: vi.fn(),
  } as unknown as DatabaseService;
  const openClaw = {
    matchesQqBinding: vi.fn(() => overrides.bound ?? true),
  } as unknown as OpenClawProvider;
  const dispatcher = {
    dispatch: vi.fn(async () => ({
      threadId: route.reply_thread_id || (route.client === 'codex-desktop' ? 'fork-thread-1' : 'thread-1'),
      turnId: 'turn-2',
      writerReleased: Promise.resolve(),
    })),
  } as unknown as PlatformReplyDispatcherService;
  return { service: new RepliesService(database, openClaw, dispatcher), database, dispatcher, route };
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
    expect(database.setReplyThreadId).not.toHaveBeenCalled();
  });

  it('persists the first Desktop fork and reuses it for the next quoted reply', async () => {
    const { service, database, dispatcher } = serviceFor({ client: 'codex-desktop' });

    await expect(service.accept(input)).resolves.toMatchObject({
      accepted: true, threadId: 'fork-thread-1', turnId: 'turn-2',
    });
    await expect(service.accept({ ...input, message_id: 'message-2' })).resolves.toMatchObject({ accepted: true });

    expect(database.setReplyThreadId).toHaveBeenCalledOnce();
    expect(database.setReplyThreadId).toHaveBeenCalledWith(10, 'fork-thread-1');
    expect(dispatcher.dispatch).toHaveBeenNthCalledWith(1, expect.objectContaining({
      client: 'codex-desktop', reply_thread_id: null,
    }), 'continue');
    expect(dispatcher.dispatch).toHaveBeenNthCalledWith(2, expect.objectContaining({
      client: 'codex-desktop', reply_thread_id: 'fork-thread-1',
    }), 'continue');
  });

  it('serializes concurrent first Desktop replies and refreshes the persisted route', async () => {
    const { service, dispatcher } = serviceFor({ client: 'codex-desktop' });
    let releaseWriter = (): void => undefined;
    const firstWriterReleased = new Promise<void>((resolve) => { releaseWriter = resolve; });
    let calls = 0;
    vi.mocked(dispatcher.dispatch).mockImplementation(async (route) => {
      calls += 1;
      return {
        threadId: route.reply_thread_id || 'fork-thread-1',
        turnId: `turn-${calls}`,
        writerReleased: calls === 1 ? firstWriterReleased : Promise.resolve(),
      };
    });

    const first = service.accept(input);
    await vi.waitFor(() => expect(dispatcher.dispatch).toHaveBeenCalledOnce());
    const second = service.accept({ ...input, message_id: 'message-2' });
    await expect(first).resolves.toMatchObject({ accepted: true, threadId: 'fork-thread-1' });
    await Promise.resolve();
    expect(dispatcher.dispatch).toHaveBeenCalledOnce();

    releaseWriter();
    await expect(second).resolves.toMatchObject({ accepted: true, threadId: 'fork-thread-1' });
    expect(dispatcher.dispatch).toHaveBeenNthCalledWith(2, expect.objectContaining({
      reply_thread_id: 'fork-thread-1',
    }), 'continue');
  });

  it('fails clearly when another server process wins Desktop fork persistence', async () => {
    const { service, database } = serviceFor({ client: 'codex-desktop' });
    vi.mocked(database.setReplyThreadId).mockReturnValue('fork-thread-winner');

    await expect(service.accept(input)).rejects.toThrow(
      'another server process persisted a different Codex reply fork',
    );
    expect(database.markInboundReply).toHaveBeenCalledWith(
      7,
      'failed',
      'another server process persisted a different Codex reply fork',
    );
  });

  it('records App Server dispatch failures and returns a clear service error', async () => {
    const { service, database, dispatcher } = serviceFor({ client: 'codex-desktop' });
    vi.mocked(dispatcher.dispatch).mockRejectedValue(new Error('thread/fork rejected'));

    await expect(service.accept(input)).rejects.toThrow(
      'unable to continue the Codex conversation: thread/fork rejected',
    );
    expect(database.markInboundReply).toHaveBeenCalledWith(7, 'failed', 'thread/fork rejected');
  });

  it('resolves a reply by task ID when QQ omits the route token', async () => {
    const { service, database, dispatcher } = serviceFor();

    await expect(service.accept({ ...input, reply_to_body: '[任务ID:5]' })).resolves.toMatchObject({
      ok: true, accepted: true, duplicate: false,
    });
    expect(database.resolveReplyRoute).toHaveBeenCalledWith(token);
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
      reply_thread_id: null,
      client: 'claude-cli', metadata: { session_id: 'session-1' },
    }, 'continue')).toThrow(BadRequestException);
    expect(codex.dispatch).not.toHaveBeenCalled();
  });

  it('selects resume for CLI and fork-then-resume for Desktop routes', () => {
    const codex = {
      dispatch: vi.fn(async () => ({
        threadId: 'target', turnId: 'turn-1', writerReleased: Promise.resolve(),
      })),
    };
    const dispatcher = new ReplyDispatcher(codex as never);
    const base = {
      delivery_id: 1, event_id: 1, channel: 'openclaw-qq', delivery_state: 'sent',
      reply_token: token, reply_expires_at: new Date(Date.now() + 60_000).toISOString(),
      metadata: { thread_id: 'original-thread' },
    };

    dispatcher.dispatch({ ...base, client: 'codex-cli', reply_thread_id: null }, 'cli reply');
    dispatcher.dispatch({ ...base, client: 'codex-desktop', reply_thread_id: null }, 'first desktop reply');
    dispatcher.dispatch({
      ...base, client: 'codex-desktop', reply_thread_id: 'fork-thread-1',
    }, 'second desktop reply');

    expect(codex.dispatch).toHaveBeenNthCalledWith(1, {
      mode: 'resume', threadId: 'original-thread', text: 'cli reply',
    });
    expect(codex.dispatch).toHaveBeenNthCalledWith(2, {
      mode: 'fork', threadId: 'original-thread', text: 'first desktop reply',
    });
    expect(codex.dispatch).toHaveBeenNthCalledWith(3, {
      mode: 'resume', threadId: 'fork-thread-1', text: 'second desktop reply',
    });
  });
});
