import { describe, expect, it } from 'vitest';
import { eventTiming, formatEventTiming, normalizeEventTimestamp } from '../src/utils/event-timing';

describe('event timing', () => {
  it('normalizes source timestamps and derives a non-negative duration', () => {
    expect(normalizeEventTimestamp('2026-08-17T12:00:00+00:00')).toBe('2026-08-17T12:00:00.000Z');
    expect(eventTiming('2026-08-17T12:00:00Z', '2026-08-17T12:04:12.500Z')).toEqual({
      started_at: '2026-08-17T12:00:00.000Z',
      completed_at: '2026-08-17T12:04:12.500Z',
      duration_ms: 252_500,
    });
    expect(eventTiming('invalid', 'invalid')).toBeNull();
    expect(normalizeEventTimestamp(Number.MAX_VALUE)).toBe('');
  });

  it('formats Beijing time and a readable duration', () => {
    expect(formatEventTiming({
      timing: {
        started_at: '2026-08-17T12:00:00Z',
        completed_at: '2026-08-17T13:02:03Z',
        duration_ms: 3_723_000,
      },
    })).toBe([
      '开始时间：2026-08-17 20:00:00（北京时间）',
      '完成时间：2026-08-17 21:02:03（北京时间）',
      '总耗时：1小时2分3秒',
    ].join('\n'));
  });

  it('uses event ingestion time when the source has no completion timestamp', () => {
    expect(formatEventTiming({}, '2026-08-17T12:00:00Z')).toBe([
      '开始时间：未采集',
      '完成时间：2026-08-17 20:00:00（北京时间）',
      '总耗时：未采集',
    ].join('\n'));
  });

  it('derives duration from timestamps instead of trusting conflicting metadata', () => {
    expect(formatEventTiming({
      timing: {
        started_at: '2026-08-17T12:00:00Z',
        completed_at: '2026-08-17T12:01:00Z',
        duration_ms: 1,
      },
    })).toContain('总耗时：1分');
  });

  it('rejects unsafe duration metadata and reversed timestamp ranges', () => {
    expect(formatEventTiming({ timing: { duration_ms: Number.MAX_SAFE_INTEGER } })).toBe('');
    expect(formatEventTiming({ timing: { duration_ms: 1_000.5 } })).toBe('');
    expect(formatEventTiming({
      timing: {
        started_at: '2026-08-17T12:01:00Z',
        completed_at: '2026-08-17T12:00:00Z',
        duration_ms: 60_000,
      },
    })).toContain('总耗时：未采集');
  });
});
