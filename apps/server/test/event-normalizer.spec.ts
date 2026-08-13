import { describe, expect, it } from 'vitest';
import { normalizeEvent, statusForKind } from '../src/events/event-normalizer';

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
});
