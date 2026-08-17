import { describe, expect, it } from 'vitest';
import { parseHeartbeatResult, sanitizeFailureMessage, summarizeTask } from '../src/utils/event-text';

describe('event text normalization', () => {
  it('summarizes only the user request and normalizes whitespace', () => {
    expect(summarizeTask(`
      <in-app-browser-context>private host context</in-app-browser-context>
      ## My request:   repair\nnotification delivery
    `)).toBe('repair notification delivery');
  });

  it('rejects non-text and host-generated history prompts', () => {
    expect(summarizeTask(null)).toBe('');
    expect(summarizeTask('The following is the Codex agent history whose request action you are assessing.')).toBe('');
  });

  it('limits task summaries by Unicode code point', () => {
    expect(summarizeTask(`  ${'a'.repeat(2_010)}  `)).toHaveLength(2_000);
  });

  it('redacts credentials, query values, and Windows user names', () => {
    const source = 'Authorization: Bearer auth-token; api_key=key; https://example.test?access_token=query C:\\Users\\alice\\project';

    expect(sanitizeFailureMessage(source)).toBe(
      'Authorization: <redacted>; api_key=<redacted>; https://example.test?access_token=<redacted> C:\\Users\\<user>\\project',
    );
    expect(sanitizeFailureMessage(source, true)).toContain('Authorization: Bearer <redacted>');
  });

  it('rejects non-text and limits stored failure details', () => {
    expect(sanitizeFailureMessage({ message: 'private' })).toBe('');
    expect(sanitizeFailureMessage('x'.repeat(25_000))).toHaveLength(24_000);
  });

  it('parses complete Codex heartbeat results', () => {
    expect(parseHeartbeatResult(`
      <heartbeat>
        <automation_id>vite-cli</automation_id>
        <decision>NOTIFY</decision>
        <message>Publish succeeded &amp; release is available.</message>
      </heartbeat>
    `)).toEqual({
      automationId: 'vite-cli',
      decision: 'NOTIFY',
      message: 'Publish succeeded & release is available.',
    });
    expect(parseHeartbeatResult('<heartbeat><automation_id>vite-cli</automation_id><decision>DONT_NOTIFY</decision><message>Still running.</message></heartbeat>'))
      .toEqual({ automationId: 'vite-cli', decision: 'DONT_NOTIFY', message: 'Still running.' });
  });

  it('does not mistake heartbeat prompts or partial markup for results', () => {
    expect(parseHeartbeatResult('<heartbeat><automation_id>vite-cli</automation_id><current_time_iso>now</current_time_iso></heartbeat>')).toBeNull();
    expect(parseHeartbeatResult('Result: <heartbeat><automation_id>vite-cli</automation_id><decision>NOTIFY</decision><message>Done.</message></heartbeat>')).toBeNull();
    expect(parseHeartbeatResult('<heartbeat><automation_id>vite-cli</automation_id><decision>UNKNOWN</decision><message>Done.</message></heartbeat>')).toBeNull();
  });
});
