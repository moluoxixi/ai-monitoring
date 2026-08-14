import { describe, expect, it } from 'vitest';
import { parseClaudeDesktopAuditLine } from '../src/events/claude-desktop-audit-watcher.service';

describe('ClaudeDesktopAuditWatcher', () => {
  it('keeps user and assistant text while ignoring tool blocks', () => {
    const user = parseClaudeDesktopAuditLine(JSON.stringify({
      type: 'user',
      session_id: 'session',
      message: { content: 'fix the login flow' },
    }));
    const assistant = parseClaudeDesktopAuditLine(JSON.stringify({
      type: 'assistant',
      session_id: 'session',
      message: { content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'final answer' }] },
    }), user.sessionId, user.taskSummary, user.answerSource);

    expect(assistant.taskSummary).toBe('fix the login flow');
    expect(assistant.answerSource).toBe('final answer');
    expect(JSON.stringify(assistant)).not.toContain('private');
  });

  it('maps a successful result to a completed event', () => {
    const parsed = parseClaudeDesktopAuditLine(JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: 'session',
      uuid: 'result-1',
      result: 'done',
    }), 'session', 'question', '');

    expect(parsed.event).toMatchObject({
      source: 'claude-desktop',
      client: 'claude-desktop',
      status: 'completed',
      metadata: { task_summary: 'question', answer_source: 'done' },
    });
  });

  it('maps an API error result to a failed event without the response body', () => {
    const parsed = parseClaudeDesktopAuditLine(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 502,
      session_id: 'session',
      uuid: 'result-2',
      result: 'Authorization: Bearer secret-token upstream failed',
    }), 'session', 'question', 'previous answer');

    expect(parsed.event).toMatchObject({
      status: 'failed',
      error_code: '502',
      metadata: { failure_message: 'Authorization: Bearer <redacted> upstream failed' },
    });
    expect(parsed.event?.metadata).not.toHaveProperty('answer_source');
  });

  it('does not replace the real prompt with a tool result user record', () => {
    const prompt = parseClaudeDesktopAuditLine(JSON.stringify({
      type: 'user', session_id: 'session', message: { role: 'user', content: 'real question' },
    }));
    const toolResult = parseClaudeDesktopAuditLine(JSON.stringify({
      type: 'user', session_id: 'session', parent_tool_use_id: 'tool-1',
      tool_use_result: { content: 'private tool output' },
      message: { role: 'user', content: 'private tool output' },
    }), prompt.sessionId, prompt.taskSummary, prompt.answerSource);

    expect(toolResult.taskSummary).toBe('real question');
    expect(JSON.stringify(toolResult)).not.toContain('private tool output');
  });
});
