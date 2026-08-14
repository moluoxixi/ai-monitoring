import { describe, expect, it } from 'vitest';
import {
  hermesDesktopCompletedEvent,
  parseHermesDesktopRequestDump,
} from '../src/events/hermes-desktop-state-watcher.service';

describe('HermesDesktopStateWatcher', () => {
  it('maps a terminal TUI assistant row to one completed event', () => {
    const event = hermesDesktopCompletedEvent({
      id: 42,
      session_id: 'session',
      content: '任务已完成',
      task_summary: '检查监控',
    });

    expect(event).toMatchObject({
      source_event_id: 'hermes-desktop:assistant:42',
      source: 'hermes-desktop',
      client: 'hermes-desktop',
      status: 'completed',
      metadata: {
        session_id: 'session',
        task_summary: '检查监控',
        answer_source: '任务已完成',
      },
    });
  });

  it('maps a request dump error without retaining request headers or body', () => {
    const event = parseHermesDesktopRequestDump(JSON.stringify({
      session_id: 'session',
      reason: 'non_retryable_client_error',
      request: {
        headers: { Authorization: 'Bearer private-token' },
        body: { messages: [{ content: 'private conversation' }] },
      },
      error: {
        type: 'AuthenticationError',
        status_code: 401,
        message: 'Authorization: Bearer private-token invalid token',
        response_text: 'private upstream response',
      },
    }), 'hermes-desktop:request-dump:1', '验证桌面端');

    expect(event).toMatchObject({
      source_event_id: 'hermes-desktop:request-dump:1',
      source: 'hermes-desktop',
      client: 'hermes-desktop',
      status: 'failed',
      error_code: 'AuthenticationError',
      metadata: { task_summary: '验证桌面端' },
    });
    expect(JSON.stringify(event)).not.toContain('private-token');
    expect(JSON.stringify(event)).not.toContain('private conversation');
    expect(JSON.stringify(event)).not.toContain('private upstream response');
  });

  it('ignores malformed request dumps and empty assistant rows', () => {
    expect(parseHermesDesktopRequestDump('{', 'event')).toBeNull();
    expect(hermesDesktopCompletedEvent({
      id: 1,
      session_id: 'session',
      content: '',
      task_summary: 'question',
    })).toBeNull();
  });
});
