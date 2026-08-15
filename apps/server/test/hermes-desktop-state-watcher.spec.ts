import { describe, expect, it } from 'vitest';
import {
  hermesDesktopCompletedEvent,
  parseHermesDesktopRequestDump,
  parseHermesDesktopLogLine,
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

  it('maps documented failure and interruption finish reasons without retaining partial answers', () => {
    expect(hermesDesktopCompletedEvent({
      id: 43,
      session_id: 'session',
      content: 'partial failure response',
      task_summary: '失败任务',
      finish_reason: 'error',
    })).toMatchObject({
      status: 'failed',
      kind: 'assistant_failed',
      error_code: 'hermes_desktop_error',
      metadata: { task_summary: '失败任务' },
    });

    expect(hermesDesktopCompletedEvent({
      id: 44,
      session_id: 'session',
      content: 'partial interrupted response',
      task_summary: '中断任务',
      finish_reason: 'cancelled',
    })).toMatchObject({
      status: 'interrupted',
      kind: 'assistant_interrupted',
      metadata: { task_summary: '中断任务' },
    });
  });

  it('maps a desktop interruption log line without retaining log text', () => {
    const event = parseHermesDesktopLogLine(
      '[hermes] ⚡ Interrupted during API call.',
      'hermes-desktop:log-interrupted:128',
      'session',
      '检查监控',
    );

    expect(event).toMatchObject({
      source_event_id: 'hermes-desktop:log-interrupted:128',
      status: 'interrupted',
      kind: 'assistant_interrupted',
      metadata: {
        session_id: 'session',
        task_summary: '检查监控',
        detection_source: 'desktop_log',
      },
    });
    expect(parseHermesDesktopLogLine('[hermes] normal line', 'event')).toBeNull();
    expect(parseHermesDesktopLogLine('[hermes] message mentions interrupted during API call.', 'event')).toBeNull();
    expect(parseHermesDesktopLogLine('[hermes] [subagent-0] ⚡ Interrupted during API call.', 'event')).toBeNull();
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
      status: 'tool_failed',
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
