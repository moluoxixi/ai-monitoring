import { describe, expect, it } from 'vitest';
import { recordValue } from '../src/utils/event-record';

describe('event record normalization', () => {
  it('returns object records without copying them', () => {
    const record = { id: 'event-1' };

    expect(recordValue(record)).toBe(record);
  });

  it('degrades null, arrays, and primitive values to empty records', () => {
    for (const value of [null, undefined, [], 'text', 42, true]) {
      expect(recordValue(value)).toEqual({});
    }
  });
});
