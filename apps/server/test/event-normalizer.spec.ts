import { describe, expect, it } from 'vitest';
import { normalizeEvent, scopedSourceEventId, statusForKind } from '../src/events/event-normalizer';

describe('event normalizer', () => {
  it('detects tool and API failures', () => {
    expect(statusForKind('PostToolUseFailure')).toBe('tool_failed');
    expect(statusForKind('api_error')).toBe('failed');
  });

  it('generates a stable id for equivalent payloads', () => {
    const event = { source: 'codex', kind: 'completed', metadata: { result: 'done' } };
    expect(normalizeEvent(event).source_event_id).toBe(normalizeEvent(event).source_event_id);
    expect(normalizeEvent(event).status).toBe('completed');
    expect(normalizeEvent(event).message).toBe('done');
  });

  it('scopes producer event ids by source and runtime', () => {
    const event = { event_id: 'session:Stop:turn', kind: 'completed' };
    const claude = normalizeEvent({ ...event, source: 'claude', client: 'claude-cli' });
    const qoderCli = normalizeEvent({ ...event, source: 'qoder', client: 'qoder-cli' });
    const qoderDesktop = normalizeEvent({ ...event, source: 'qoder', client: 'qoder-desktop' });

    expect(claude.source_event_id).toBe('v1:claude:claude-cli:session:Stop:turn');
    expect(new Set([
      claude.source_event_id,
      qoderCli.source_event_id,
      qoderDesktop.source_event_id,
    ])).toHaveLength(3);
    expect(scopedSourceEventId('claude-desktop', 'claude-desktop', 'claude-desktop:assistant:message-1:completed'))
      .toBe('v1:claude-desktop:claude-desktop:claude-desktop:assistant:message-1:completed');
  });
});
