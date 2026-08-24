import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelsService } from '../src/channels/channels.service';
import type { AppConfigService } from '../src/config/app-config.service';
import {
  claudeDesktopTerminalEventId,
  ClaudeDesktopTranscriptWatcherService,
  parseClaudeDesktopTranscriptLine,
} from '../src/events/claude-desktop-audit-watcher.service';
import { normalizeEvent } from '../src/events/event-normalizer';
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
      cwd: 'D:\\project-new\\desktop-project',
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
    }), prompt.sessionId, prompt.taskSummary, prompt.answerSource, prompt.desktopTranscript, prompt.cwd);
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
    }), thinking.sessionId, thinking.taskSummary, thinking.answerSource, thinking.desktopTranscript, thinking.cwd);

    expect(thinking.event).toBeUndefined();
    expect(JSON.stringify(thinking)).not.toContain('private reasoning');
    const producerEventId = claudeDesktopTerminalEventId('assistant', 'message-1', 'completed');
    expect(answer.event).toMatchObject({
      source_event_id: 'v1:claude-desktop:claude-desktop:claude-desktop:assistant:message-1:completed',
      source: 'claude-desktop',
      client: 'claude-desktop',
      status: 'completed',
      metadata: {
        task_summary: 'desktop question',
        answer_source: 'visible answer',
        cwd: 'D:\\project-new\\desktop-project',
      },
    });
    expect(answer.terminalIdentity).toBe(producerEventId);
    expect(answer.event?.source_event_id).toBe(normalizeEvent({
      source: 'claude-desktop',
      client: 'claude-desktop',
      event_id: producerEventId,
      kind: 'Stop',
      status: 'completed',
    }).source_event_id);
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

  it('does not let a sidechain Desktop marker classify the main chain', () => {
    const sidechain = parseClaudeDesktopTranscriptLine(JSON.stringify({
      type: 'assistant',
      entrypoint: 'claude-desktop-3p',
      isSidechain: true,
      sessionId: 'sidechain-session',
      message: { id: 'sidechain-message', role: 'assistant', stop_reason: 'end_turn', content: 'sidechain answer' },
    }));
    const main = parseClaudeDesktopTranscriptLine(JSON.stringify({
      type: 'assistant',
      entrypoint: 'claude-code',
      sessionId: 'cli-session',
      message: { id: 'main-message', role: 'assistant', stop_reason: 'end_turn', content: 'CLI answer' },
    }), sidechain.sessionId, sidechain.taskSummary, sidechain.answerSource, sidechain.desktopTranscript);

    expect(sidechain.desktopTranscript).toBe(false);
    expect(sidechain.event).toBeUndefined();
    expect(main.desktopTranscript).toBe(false);
    expect(main.event).toBeUndefined();
  });

  it('uses the assistant record UUID when the message id is missing', () => {
    const parsed = parseClaudeDesktopTranscriptLine(JSON.stringify({
      type: 'assistant',
      entrypoint: 'claude-desktop-3p',
      sessionId: 'uuid-session',
      uuid: 'record-uuid',
      message: { role: 'assistant', stop_reason: 'end_turn', content: 'UUID answer' },
    }));

    expect(parsed.terminalIdentity).toBe('claude-desktop:assistant:record-uuid:completed');
    expect(parsed.event).toMatchObject({
      source_event_id: 'v1:claude-desktop:claude-desktop:claude-desktop:assistant:record-uuid:completed',
      metadata: { turn_id: 'record-uuid', answer_source: 'UUID answer' },
    });
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
      source_event_id: 'v1:claude-desktop:claude-desktop:claude-desktop:system:error-1:failed',
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
    }), prompt.sessionId, prompt.taskSummary, prompt.answerSource, prompt.desktopTranscript, prompt.cwd);
    const synthetic = parseClaudeDesktopTranscriptLine(JSON.stringify({
      type: 'user',
      entrypoint: 'claude-desktop-3p',
      sessionId: 'session',
      is_synthetic: true,
      message: { role: 'user', content: 'private synthetic prompt' },
    }), toolResult.sessionId, toolResult.taskSummary, toolResult.answerSource, toolResult.desktopTranscript);

    expect(toolResult.taskSummary).toBe('real desktop question');
    expect(JSON.stringify(toolResult)).not.toContain('private tool output');
    expect(synthetic.taskSummary).toBe('real desktop question');
    expect(JSON.stringify(synthetic)).not.toContain('private synthetic prompt');
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
        source_event_id: 'v1:claude-desktop:claude-desktop:claude-desktop:assistant:message-1:completed',
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

      writeFileSync(join(directory, 'copied-session.jsonl'), jsonLines(
        {
          type: 'user', entrypoint: 'claude-desktop-3p', sessionId: 'copied-session',
          message: { role: 'user', content: 'copied historical question' },
        },
        {
          type: 'assistant', entrypoint: 'claude-desktop-3p', sessionId: 'copied-session',
          message: { id: 'historical-message', role: 'assistant', stop_reason: 'end_turn', content: 'historical answer' },
        },
      ));
      await new Promise((resolve) => setTimeout(resolve, 350));
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
        source_event_id: 'v1:claude-desktop:claude-desktop:claude-desktop:assistant:appended-message:completed',
        metadata: expect.objectContaining({
          task_summary: 'appended question',
          answer_source: 'appended answer',
        }),
      }), [], 'appended answer');
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('treats content appended after startup enumeration as live', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'claude-desktop-startup-race-'));
    temporaryDirectories.push(directory);
    const transcript = join(directory, 'session.jsonl');
    const startupHistory = jsonLines(
      {
        type: 'user', entrypoint: 'claude-desktop-3p', sessionId: 'session',
        message: { role: 'user', content: 'startup question' },
      },
      {
        type: 'assistant', entrypoint: 'claude-desktop-3p', sessionId: 'session',
        message: { id: 'startup-message', role: 'assistant', stop_reason: 'end_turn', content: 'startup answer' },
      },
    );
    writeFileSync(transcript, startupHistory);
    const { service, ingest } = serviceFor(directory);

    service.onModuleInit();
    try {
      const internals = service as unknown as {
        startupTranscriptFiles: Map<string, number>;
        transcriptFiles: Map<string, unknown>;
      };
      expect(internals.startupTranscriptFiles.get(transcript)).toBe(Buffer.byteLength(startupHistory));
      expect(internals.transcriptFiles.has(transcript)).toBe(false);

      appendFileSync(transcript, jsonLines(
        {
          type: 'user', sessionId: 'session',
          message: { role: 'user', content: 'live race question' },
        },
        {
          type: 'assistant', sessionId: 'session',
          message: { id: 'live-race-message', role: 'assistant', stop_reason: 'end_turn', content: 'live race answer' },
        },
      ));

      await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1), { timeout: 3_000 });
      expect(ingest).toHaveBeenCalledWith(expect.objectContaining({
        source_event_id: 'v1:claude-desktop:claude-desktop:claude-desktop:assistant:live-race-message:completed',
        metadata: expect.objectContaining({
          task_summary: 'live race question',
          answer_source: 'live race answer',
        }),
      }), [], 'live race answer');
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('preserves a live terminal split across the startup snapshot boundary', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'claude-desktop-startup-partial-'));
    temporaryDirectories.push(directory);
    const transcript = join(directory, 'session.jsonl');
    const terminal = JSON.stringify({
      type: 'assistant', sessionId: 'session',
      message: { id: 'split-message', role: 'assistant', stop_reason: 'end_turn', content: 'split answer' },
    });
    const splitAt = Math.floor(terminal.length / 2);
    writeFileSync(transcript, `${jsonLines({
      type: 'user', entrypoint: 'claude-desktop-3p', sessionId: 'session',
      message: { role: 'user', content: 'split question' },
    })}${terminal.slice(0, splitAt)}`);
    const { service, ingest } = serviceFor(directory);

    service.onModuleInit();
    try {
      const internals = service as unknown as {
        startupTranscriptFiles: Map<string, number>;
        transcriptFiles: Map<string, unknown>;
      };
      expect(internals.startupTranscriptFiles.has(transcript)).toBe(true);
      expect(internals.transcriptFiles.has(transcript)).toBe(false);

      appendFileSync(transcript, `${terminal.slice(splitAt)}\n`);

      await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1), { timeout: 3_000 });
      expect(ingest).toHaveBeenCalledWith(expect.objectContaining({
        source_event_id: 'v1:claude-desktop:claude-desktop:claude-desktop:assistant:split-message:completed',
        metadata: expect.objectContaining({ task_summary: 'split question', answer_source: 'split answer' }),
      }), [], 'split answer');
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('filters copied history by timestamp without swallowing a new terminal in the same file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'claude-desktop-history-'));
    temporaryDirectories.push(directory);
    const { service, ingest } = serviceFor(directory);

    service.onModuleInit();
    try {
      const liveTimestamp = new Date(Date.now() + 1_000).toISOString();
      writeFileSync(join(directory, 'mixed-session.jsonl'), jsonLines(
        {
          type: 'user', entrypoint: 'claude-desktop-3p', sessionId: 'mixed-session',
          timestamp: '2020-01-01T00:00:00.000Z',
          message: { role: 'user', content: 'copied question' },
        },
        {
          type: 'assistant', entrypoint: 'claude-desktop-3p', sessionId: 'mixed-session',
          timestamp: '2020-01-01T00:00:01.000Z',
          message: { id: 'orphan-history', role: 'assistant', stop_reason: 'end_turn', content: 'copied answer' },
        },
        {
          type: 'user', entrypoint: 'claude-desktop-3p', sessionId: 'mixed-session',
          timestamp: '2020-01-01T00:00:02.000Z',
          message: { role: 'user', content: 'second copied question' },
        },
        {
          type: 'assistant', entrypoint: 'claude-desktop-3p', sessionId: 'mixed-session',
          timestamp: '2020-01-01T00:00:03.000Z',
          message: { id: 'second-orphan-history', role: 'assistant', stop_reason: 'end_turn', content: 'second copied answer' },
        },
        {
          type: 'user', entrypoint: 'claude-desktop-3p', sessionId: 'mixed-session',
          timestamp: liveTimestamp,
          message: { role: 'user', content: 'live question' },
        },
        {
          type: 'assistant', entrypoint: 'claude-desktop-3p', sessionId: 'mixed-session',
          timestamp: liveTimestamp,
          message: { id: 'live-message', role: 'assistant', stop_reason: 'end_turn', content: 'live answer' },
        },
      ));

      await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1), { timeout: 3_000 });
      expect(ingest).toHaveBeenCalledWith(expect.objectContaining({
        source_event_id: 'v1:claude-desktop:claude-desktop:claude-desktop:assistant:live-message:completed',
        metadata: expect.objectContaining({ task_summary: 'live question', answer_source: 'live answer' }),
      }), [], 'live answer');
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('deduplicates copied terminals while accepting a new terminal after a growth rewrite', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'claude-desktop-rewrite-'));
    temporaryDirectories.push(directory);
    const { service, ingest } = serviceFor(directory);
    const first = join(directory, 'first.jsonl');
    const records = (sessionId: string, answer: string) => jsonLines(
      {
        type: 'user', entrypoint: 'claude-desktop-3p', sessionId,
        message: { role: 'user', content: 'question' },
      },
      {
        type: 'assistant', entrypoint: 'claude-desktop-3p', sessionId,
        message: { id: 'shared-message', role: 'assistant', stop_reason: 'end_turn', content: answer },
      },
    );

    service.onModuleInit();
    try {
      writeFileSync(first, records('first-session', 'first answer'));
      await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(1), { timeout: 3_000 });

      writeFileSync(first, `${records('first-session', 'rewritten answer')}${jsonLines(
        {
          type: 'user', entrypoint: 'claude-desktop-3p', sessionId: 'first-session',
          message: { role: 'user', content: 'rewrite question' },
        },
        {
          type: 'assistant', entrypoint: 'claude-desktop-3p', sessionId: 'first-session',
          message: { id: 'rewrite-message', role: 'assistant', stop_reason: 'end_turn', content: 'rewrite answer' },
        },
      )}`);
      await vi.waitFor(() => expect(ingest).toHaveBeenCalledTimes(2), { timeout: 3_000 });
      writeFileSync(join(directory, 'second.jsonl'), records('second-session', 'copied answer'));
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(ingest).toHaveBeenCalledTimes(2);
      expect(ingest).toHaveBeenNthCalledWith(1, expect.objectContaining({
        metadata: expect.objectContaining({ session_id: 'first-session', answer_source: 'first answer' }),
      }), [], 'first answer');
      expect(ingest).toHaveBeenNthCalledWith(2, expect.objectContaining({
        metadata: expect.objectContaining({
          session_id: 'first-session', task_summary: 'rewrite question', answer_source: 'rewrite answer',
        }),
      }), [], 'rewrite answer');
    } finally {
      await service.onModuleDestroy();
    }
  });
});
