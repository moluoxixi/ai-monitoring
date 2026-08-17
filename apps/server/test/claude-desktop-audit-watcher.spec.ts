import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelsService } from '../src/channels/channels.service';
import type { AppConfigService } from '../src/config/app-config.service';
import {
  ClaudeDesktopTranscriptWatcherService,
  parseClaudeDesktopTranscriptLine,
} from '../src/events/claude-desktop-audit-watcher.service';
import type { EventIngestionService } from '../src/events/event-ingestion.service';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const jsonLines = (...records: unknown[]): string => `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;

const serviceFor = (transcriptRoot: string) => {
  const ingest = vi.fn();
  const suppressProvisionalFailures = vi.fn();
  const config = {
    claudeDesktopTranscriptsPath: transcriptRoot,
  } as unknown as AppConfigService;
  const channels = { deliveryChannels: vi.fn(() => []) } as unknown as ChannelsService;
  const ingestion = { ingest, suppressProvisionalFailures } as unknown as EventIngestionService;
  return {
    service: new ClaudeDesktopTranscriptWatcherService(config, channels, ingestion),
    ingest,
    suppressProvisionalFailures,
  };
};

describe('ClaudeDesktopTranscriptWatcher', () => {
  it('emits one completed Desktop transcript event with the visible answer', () => {
    const prompt = parseClaudeDesktopTranscriptLine(JSON.stringify({
      type: 'user',
      entrypoint: 'claude-desktop-3p',
      sessionId: 'session',
      message: { role: 'user', content: 'desktop question' },
    }));
    const thinking = parseClaudeDesktopTranscriptLine(JSON.stringify({
      type: 'assistant',
      entrypoint: 'claude-desktop-3p',
      sessionId: 'session',
      message: {
        id: 'message-1',
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'thinking', thinking: 'private reasoning' }],
      },
    }), prompt.sessionId, prompt.taskSummary, prompt.answerSource, prompt.desktopTranscript);
    const answer = parseClaudeDesktopTranscriptLine(JSON.stringify({
      type: 'assistant',
      entrypoint: 'claude-desktop-3p',
      sessionId: 'session',
      message: {
        id: 'message-1',
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'visible answer' }],
      },
    }), thinking.sessionId, thinking.taskSummary, thinking.answerSource, thinking.desktopTranscript);

    expect(thinking.event).toBeUndefined();
    expect(JSON.stringify(thinking)).not.toContain('private reasoning');
    expect(answer.event).toMatchObject({
      source_event_id: 'session:transcript:message-1:completed',
      source: 'claude-desktop',
      client: 'claude-desktop',
      status: 'completed',
      metadata: { task_summary: 'desktop question', answer_source: 'visible answer' },
    });
  });

  it('ignores ordinary Claude CLI transcripts', () => {
    const prompt = parseClaudeDesktopTranscriptLine(JSON.stringify({
      type: 'user',
      entrypoint: 'claude-code',
      sessionId: 'cli-session',
      message: { role: 'user', content: 'mentions claude-desktop-3p in plain text' },
    }));
    const answer = parseClaudeDesktopTranscriptLine(JSON.stringify({
      type: 'assistant',
      entrypoint: 'claude-code',
      sessionId: 'cli-session',
      message: { id: 'cli-message', role: 'assistant', stop_reason: 'end_turn', content: 'CLI answer' },
    }), prompt.sessionId, prompt.taskSummary, prompt.answerSource, prompt.desktopTranscript);

    expect(prompt.desktopTranscript).toBe(false);
    expect(prompt.taskSummary).toBe('');
    expect(answer.event).toBeUndefined();
  });

  it('extracts and normalizes text from nested transcript containers', () => {
    const prompt = parseClaudeDesktopTranscriptLine(JSON.stringify({
      type: 'user',
      entrypoint: 'claude-desktop-3p',
      sessionId: 'nested-session',
      message: {
        role: 'user',
        content: { content: [{ type: 'text', text: '  nested\nquestion  ' }] },
      },
    }));

    expect(prompt.taskSummary).toBe('nested question');
  });

  it('maps Desktop transcript API errors to sanitized failures', () => {
    const parsed = parseClaudeDesktopTranscriptLine(JSON.stringify({
      type: 'system',
      subtype: 'api_error',
      entrypoint: 'claude-desktop-3p',
      sessionId: 'session',
      uuid: 'error-1',
      error: { message: 'Authorization: Bearer secret-token upstream failed' },
    }), 'session', 'desktop question');

    expect(parsed.event).toMatchObject({
      source_event_id: 'session:transcript:error-1:failed',
      status: 'failed',
      error_code: 'claude_desktop_api_error',
      message: 'Authorization: Bearer <redacted> upstream failed',
      metadata: { task_summary: 'desktop question' },
    });
    expect(JSON.stringify(parsed.event)).not.toContain('secret-token');
  });

  it('does not replace a Desktop prompt with a tool-result user record', () => {
    const prompt = parseClaudeDesktopTranscriptLine(JSON.stringify({
      type: 'user',
      entrypoint: 'claude-desktop-3p',
      sessionId: 'session',
      message: { role: 'user', content: 'real desktop question' },
    }));
    const toolResult = parseClaudeDesktopTranscriptLine(JSON.stringify({
      type: 'user',
      entrypoint: 'claude-desktop-3p',
      sessionId: 'session',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'private tool output' }],
      },
    }), prompt.sessionId, prompt.taskSummary, prompt.answerSource, prompt.desktopTranscript);

    expect(toolResult.taskSummary).toBe('real desktop question');
    expect(JSON.stringify(toolResult)).not.toContain('private tool output');
  });

  it('watches a newly created nested Desktop transcript', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'claude-desktop-watcher-'));
    temporaryDirectories.push(directory);
    const { service, ingest, suppressProvisionalFailures } = serviceFor(directory);

    service.onModuleInit();
    try {
      const nested = join(directory, 'project');
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, 'session.jsonl'), jsonLines(
        {
          type: 'user', entrypoint: 'claude-desktop-3p', sessionId: 'session',
          message: { role: 'user', content: 'new nested question' },
        },
        {
          type: 'assistant', entrypoint: 'claude-desktop-3p', sessionId: 'session',
          message: {
            id: 'message-1', role: 'assistant', stop_reason: 'end_turn',
            content: [{ type: 'thinking', thinking: 'private reasoning' }],
          },
        },
        {
          type: 'assistant', entrypoint: 'claude-desktop-3p', sessionId: 'session',
          message: {
            id: 'message-1', role: 'assistant', stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'nested answer' }],
          },
        },
      ));

      await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1), { timeout: 3_000 });
      expect(ingest).toHaveBeenCalledWith(expect.objectContaining({
        source_event_id: 'session:transcript:message-1:completed',
        metadata: expect.objectContaining({ answer_source: 'nested answer' }),
      }), [], 'nested answer');
      expect(suppressProvisionalFailures).toHaveBeenCalledWith('claude-desktop', 'session');
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('does not consume a legacy audit.jsonl even inside the transcript root', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'claude-desktop-legacy-'));
    temporaryDirectories.push(directory);
    const { service, ingest } = serviceFor(directory);

    service.onModuleInit();
    try {
      writeFileSync(join(directory, 'audit.jsonl'), jsonLines(
        {
          type: 'user', entrypoint: 'claude-desktop-3p', sessionId: 'legacy-session',
          message: { role: 'user', content: 'legacy prompt' },
        },
        {
          type: 'assistant', entrypoint: 'claude-desktop-3p', sessionId: 'legacy-session',
          message: { id: 'legacy-message', role: 'assistant', stop_reason: 'end_turn', content: 'legacy answer' },
        },
      ));
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(ingest).not.toHaveBeenCalled();
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('skips startup transcript history and detects an appended Desktop turn', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'claude-desktop-startup-'));
    temporaryDirectories.push(directory);
    const transcript = join(directory, 'session.jsonl');
    writeFileSync(transcript, jsonLines(
      {
        type: 'user', entrypoint: 'claude-desktop-3p', sessionId: 'session',
        message: { role: 'user', content: 'historical question' },
      },
      {
        type: 'assistant', entrypoint: 'claude-desktop-3p', sessionId: 'session',
        message: { id: 'historical-message', role: 'assistant', stop_reason: 'end_turn', content: 'historical answer' },
      },
    ));
    const { service, ingest } = serviceFor(directory);

    service.onModuleInit();
    try {
      const internals = service as unknown as { transcriptFiles: Map<string, unknown> };
      await vi.waitFor(() => expect(internals.transcriptFiles.has(transcript)).toBe(true), { timeout: 3_000 });
      expect(ingest).not.toHaveBeenCalled();

      appendFileSync(transcript, jsonLines(
        {
          type: 'user', sessionId: 'session',
          message: { role: 'user', content: 'appended question' },
        },
        {
          type: 'assistant', sessionId: 'session',
          message: { id: 'appended-message', role: 'assistant', stop_reason: 'end_turn', content: 'appended answer' },
        },
      ));

      await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1), { timeout: 3_000 });
      expect(ingest).toHaveBeenCalledWith(expect.objectContaining({
        source_event_id: 'session:transcript:appended-message:completed',
        metadata: expect.objectContaining({
          task_summary: 'appended question',
          answer_source: 'appended answer',
        }),
      }), [], 'appended answer');
    } finally {
      await service.onModuleDestroy();
    }
  });
});
