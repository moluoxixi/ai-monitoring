import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../src/config/app-config.service';
import type { ChannelsService } from '../src/channels/channels.service';
import type { EventIngestionService } from '../src/events/event-ingestion.service';
import {
  parseQoderDesktopCompletionLine,
  parseQoderSessionLine,
  QoderSessionWatcherService,
} from '../src/events/qoder-session-watcher.service';

const temporaryDirectories: string[] = [];

const line = (value: Record<string, unknown>): string => JSON.stringify(value);
const userLine = (sessionId: string, content: unknown, entrypoint?: string): string => line({
  type: 'user', sessionId, entrypoint, timestamp: '2026-08-17T04:00:00Z',
  cwd: 'D:\\project-new\\qoder-project',
  message: { role: 'user', content },
});
const assistantLine = (
  sessionId: string,
  content: unknown,
  options: { entrypoint?: string; id?: string; stopReason?: string; timestamp?: string } = {},
): string => line({
  type: 'assistant', sessionId, entrypoint: options.entrypoint,
  cwd: 'D:\\project-new\\qoder-project',
  timestamp: options.timestamp || '2026-08-17T04:00:01Z',
  message: { role: 'assistant', id: options.id, stop_reason: options.stopReason, content },
});
const completionLine = (sessionId: string, timestamp = '2026-08-17 12:00:00.123'): string => (
  `${timestamp} [info] [ACPProgressStateMachine] State transition: streaming -> completed, `
  + `trigger: chat_finish:success:200, sessionId: ${sessionId}`
);

const serviceFor = (sessionsPath: string, logsPath: string, channels: string[] = []) => {
  const ingest = vi.fn();
  const service = new QoderSessionWatcherService(
    { qoderSessionsPath: sessionsPath, qoderLogsPath: logsPath, answerCaptureGraceMs: 0 } as AppConfigService,
    { deliveryChannels: vi.fn(() => channels) } as unknown as ChannelsService,
    { ingest } as unknown as EventIngestionService,
  );
  return { service, ingest };
};

const temporaryRoot = (): string => {
  const directory = mkdtempSync(join(tmpdir(), 'qoder-watcher-'));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Qoder session parser', () => {
  it('classifies a CLI end_turn from the official entrypoint', () => {
    const prompt = parseQoderSessionLine(userLine('cli-session', '验证 CLI', 'cli'), 'session.jsonl');
    const completed = parseQoderSessionLine(assistantLine('cli-session', [
      { type: 'thinking', thinking: 'private' },
      { type: 'text', text: 'CLI 验证通过' },
    ], { entrypoint: 'cli', id: 'answer-1', stopReason: 'end_turn' }),
    'session.jsonl', prompt.sessionId, prompt.taskSummary, prompt.client);

    expect(completed.event).toMatchObject({
      source_event_id: 'qoder-session:cli-session:answer-1',
      client: 'qoder-cli',
      status: 'completed',
      metadata: { task_summary: '验证 CLI', cwd: 'D:\\project-new\\qoder-project' },
    });
    expect(completed.answerSource).toBe('CLI 验证通过');
  });

  it('classifies Desktop and Quest transcripts without treating their text as terminal', () => {
    const desktopPath = 'C:/Users/test/.qoder/projects/workspace/transcript/desktop-session.jsonl';
    const desktopPrompt = parseQoderSessionLine(userLine('desktop-session', '验证 Desktop'), desktopPath);
    const desktopAnswer = parseQoderSessionLine(assistantLine('desktop-session', [
      { type: 'text', text: 'Desktop 验证通过' },
    ]), desktopPath, desktopPrompt.sessionId, desktopPrompt.taskSummary, desktopPrompt.client);
    const questPath = 'C:/Users/test/.qoder/projects/workspace/transcript/task-1.session.execution.jsonl';
    const quest = parseQoderSessionLine(userLine('task-1.session.execution', '验证 Quest'), questPath);
    const contradictoryQuest = parseQoderSessionLine(assistantLine('task-1.session.execution', [
      { type: 'text', text: 'Quest 必须等待日志终态' },
    ], { entrypoint: 'cli', id: 'quest-answer', stopReason: 'end_turn' }), questPath);

    expect(desktopAnswer).toMatchObject({
      client: 'qoder-desktop',
      taskSummary: '验证 Desktop',
      answerSource: 'Desktop 验证通过',
    });
    expect(desktopAnswer.event).toBeUndefined();
    expect(quest.client).toBe('qoder-quest');
    expect(contradictoryQuest.client).toBe('qoder-quest');
    expect(contradictoryQuest.event).toBeUndefined();
  });

  it('does not treat intermediate text, thinking, tool use, or tool results as terminal', () => {
    const path = 'C:/Users/test/.qoder/projects/workspace/transcript/desktop-session.jsonl';
    const toolResult = parseQoderSessionLine(userLine('desktop-session', [
      { type: 'tool_result', content: 'private result' },
    ]), path, 'desktop-session', 'task', 'qoder-desktop', 'previous answer');
    const intermediate = parseQoderSessionLine(assistantLine('desktop-session', [
      { type: 'text', text: 'I will inspect this' },
    ]), path, 'desktop-session', 'task', 'qoder-desktop');
    const toolUse = parseQoderSessionLine(assistantLine('desktop-session', [
      { type: 'tool_use', name: 'read' },
    ]), path, 'desktop-session', 'task', 'qoder-desktop', intermediate.answerSource);

    expect(toolResult).toMatchObject({ taskSummary: 'task', answerSource: 'previous answer' });
    expect(intermediate.event).toBeUndefined();
    expect(toolUse.event).toBeUndefined();
  });
});

describe('Qoder Desktop completion parser', () => {
  it('uses the official successful ACP terminal line and window type', () => {
    const desktop = parseQoderDesktopCompletionLine(
      completionLine('desktop-session'),
      'C:/Users/test/AppData/Roaming/Qoder/logs/run/window1/agent.log',
    );
    const quest = parseQoderDesktopCompletionLine(
      completionLine('task-1.session.execution'),
      'C:/Users/test/AppData/Roaming/Qoder/logs/run/questWindow/agent.log',
    );

    expect(desktop).toEqual({
      sessionId: 'desktop-session',
      completionId: '20260817120000123',
      client: 'qoder-desktop',
    });
    expect(quest?.client).toBe('qoder-quest');
  });

  it('rejects non-success states and ambiguous log paths', () => {
    const failed = completionLine('desktop-session').replace('success:200', 'error:500');

    expect(parseQoderDesktopCompletionLine(failed, 'C:/logs/run/window1/agent.log')).toBeNull();
    expect(parseQoderDesktopCompletionLine(completionLine('desktop-session'), 'C:/logs/agent.log')).toBeNull();
    expect(parseQoderDesktopCompletionLine(
      completionLine('task-1.session.execution'),
      'C:/logs/run/window1/agent.log',
    )).toBeNull();
  });
});

describe('Qoder session file synchronization', () => {
  it('uses existing CLI content as context without replaying it, then notifies for an appended completion', async () => {
    const root = temporaryRoot();
    const path = join(root, 'cli-session.jsonl');
    writeFileSync(path, `${userLine('cli-session', '新的 CLI 任务', 'cli')}\n`);
    const { service, ingest } = serviceFor(root, join(root, 'logs'), ['openclaw-qq']);

    await service.syncFile(path, false);
    expect(ingest).not.toHaveBeenCalled();
    appendFileSync(path, `${assistantLine('cli-session', [{ type: 'text', text: '完成' }], {
      entrypoint: 'cli', id: 'turn-1', stopReason: 'end_turn',
    })}\n`);
    await service.syncFile(path, true);

    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({
      client: 'qoder-cli',
      message: '提问：新的 CLI 任务',
    }), ['openclaw-qq'], '完成');
  });

  it('waits for an explicit Desktop log terminal and sends only the latest transcript answer once', async () => {
    const root = temporaryRoot();
    const transcriptDirectory = join(root, 'project', 'transcript');
    const logDirectory = join(root, 'logs', 'run', 'window1');
    mkdirSync(transcriptDirectory, { recursive: true });
    mkdirSync(logDirectory, { recursive: true });
    const transcript = join(transcriptDirectory, 'desktop-session.jsonl');
    const log = join(logDirectory, 'agent.log');
    writeFileSync(transcript, [
      userLine('desktop-session', '验证 Desktop'),
      assistantLine('desktop-session', [{ type: 'text', text: '中间说明' }]),
      assistantLine('desktop-session', [{ type: 'text', text: '最终回复' }], { timestamp: '2026-08-17T04:00:02Z' }),
      '',
    ].join('\n'));
    writeFileSync(log, '');
    const { service, ingest } = serviceFor(root, join(root, 'logs'), ['openclaw-qq']);

    await service.syncFile(transcript, true);
    expect(ingest).not.toHaveBeenCalled();
    appendFileSync(log, `${completionLine('desktop-session')}\n`);
    await service.syncFile(log, true);
    appendFileSync(log, `${completionLine('desktop-session', '2026-08-17 12:00:00.456')}\n`);
    await service.syncFile(log, true);

    expect(ingest).toHaveBeenCalledOnce();
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({
      source_event_id: 'qoder-log:desktop-session:20260817120000123',
      client: 'qoder-desktop',
      message: '提问：验证 Desktop',
    }), ['openclaw-qq'], '最终回复');
  });

  it('retains an early Desktop terminal until the transcript answer arrives', async () => {
    const root = temporaryRoot();
    const transcriptDirectory = join(root, 'project', 'transcript');
    const logDirectory = join(root, 'logs', 'run', 'window1');
    mkdirSync(transcriptDirectory, { recursive: true });
    mkdirSync(logDirectory, { recursive: true });
    const transcript = join(transcriptDirectory, 'desktop-session.jsonl');
    const log = join(logDirectory, 'agent.log');
    writeFileSync(transcript, `${userLine('desktop-session', '延迟回复')}\n`);
    writeFileSync(log, `${completionLine('desktop-session')}\n`);
    const { service, ingest } = serviceFor(root, join(root, 'logs'));

    await service.syncFile(transcript, false);
    await service.syncFile(log, true);
    expect(ingest).not.toHaveBeenCalled();
    appendFileSync(transcript, `${assistantLine('desktop-session', [{ type: 'text', text: '稍后落盘' }])}\n`);
    await service.syncFile(transcript, true);

    expect(ingest).toHaveBeenCalledOnce();
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ client: 'qoder-desktop' }), [], '稍后落盘');
  });

  it('does not let a historical terminal suppress the unfinished turn present at startup', async () => {
    const root = temporaryRoot();
    const transcriptDirectory = join(root, 'project', 'transcript');
    const logDirectory = join(root, 'logs', 'run', 'window1');
    mkdirSync(transcriptDirectory, { recursive: true });
    mkdirSync(logDirectory, { recursive: true });
    const transcript = join(transcriptDirectory, 'desktop-session.jsonl');
    const log = join(logDirectory, 'agent.log');
    writeFileSync(transcript, [
      userLine('desktop-session', '历史任务'),
      assistantLine('desktop-session', [{ type: 'text', text: '历史回复' }]),
      userLine('desktop-session', '启动时尚未完成的新任务').replace('04:00:00Z', '04:01:00Z'),
      '',
    ].join('\n'));
    writeFileSync(log, `${completionLine('desktop-session')}\n`);
    const { service, ingest } = serviceFor(root, join(root, 'logs'));

    await service.syncFile(log, false);
    await service.syncFile(transcript, false);
    appendFileSync(transcript, `${assistantLine('desktop-session', [{ type: 'text', text: '新任务完成' }], {
      timestamp: '2026-08-17T04:01:01Z',
    })}\n`);
    await service.syncFile(transcript, true);
    appendFileSync(log, `${completionLine('desktop-session', '2026-08-17 12:00:01.123')}\n`);
    await service.syncFile(log, true);

    expect(ingest).toHaveBeenCalledOnce();
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({
      message: '提问：启动时尚未完成的新任务',
    }), [], '新任务完成');
  });

  it('resets the transcript cursor when a rewrite preserves the prefix and grows beyond the previous size', async () => {
    const root = temporaryRoot();
    const transcriptDirectory = join(root, 'project', 'transcript');
    const logDirectory = join(root, 'logs', 'run', 'window1');
    mkdirSync(transcriptDirectory, { recursive: true });
    mkdirSync(logDirectory, { recursive: true });
    const transcript = join(transcriptDirectory, 'desktop-session.jsonl');
    const log = join(logDirectory, 'agent.log');
    const fixedFirstLine = userLine('desktop-session', '保持不变的首条任务');
    writeFileSync(transcript, [
      fixedFirstLine,
      assistantLine('desktop-session', [{ type: 'text', text: '旧回复' }]),
      '',
    ].join('\n'));
    writeFileSync(log, '');
    const { service, ingest } = serviceFor(root, join(root, 'logs'));
    await service.syncFile(transcript, false);

    writeFileSync(transcript, [
      fixedFirstLine,
      userLine('desktop-session', '重写后的新任务内容').replace('04:00:00Z', '04:01:00Z'),
      assistantLine('desktop-session', [{ type: 'text', text: '重写后的新回复内容' }], {
        timestamp: '2026-08-17T04:01:01Z',
      }),
      '',
    ].join('\n'));
    await service.syncFile(transcript, true);
    appendFileSync(log, `${completionLine('desktop-session')}\n`);
    await service.syncFile(log, true);

    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ message: '提问：重写后的新任务内容' }), [], '重写后的新回复内容');
  });

  it('correlates Quest completion logs with execution transcripts', async () => {
    const root = temporaryRoot();
    const transcriptDirectory = join(root, 'project', 'transcript');
    const logDirectory = join(root, 'logs', 'run', 'questWindow');
    mkdirSync(transcriptDirectory, { recursive: true });
    mkdirSync(logDirectory, { recursive: true });
    const sessionId = 'task-1.session.execution';
    const transcript = join(transcriptDirectory, `${sessionId}.jsonl`);
    const log = join(logDirectory, 'agent.log');
    writeFileSync(transcript, [
      userLine(sessionId, '验证 Quest'),
      assistantLine(sessionId, [{ type: 'text', text: 'Quest 完成' }]),
      '',
    ].join('\n'));
    writeFileSync(log, `${completionLine(sessionId)}\n`);
    const { service, ingest } = serviceFor(root, join(root, 'logs'));

    await service.syncFile(transcript, false);
    await service.syncFile(log, true);

    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({ client: 'qoder-quest' }), [], 'Quest 完成');
  });

  it('waits for a complete trailing JSON line before advancing the offset', async () => {
    const root = temporaryRoot();
    const path = join(root, 'partial.jsonl');
    writeFileSync(path, `${userLine('partial-session', 'partial', 'cli')}\n`);
    const { service, ingest } = serviceFor(root, join(root, 'logs'));
    await service.syncFile(path, false);
    const completion = assistantLine('partial-session', [{ type: 'text', text: 'done' }], {
      entrypoint: 'cli', id: 'partial-turn', stopReason: 'end_turn',
    });
    appendFileSync(path, completion.slice(0, -4));

    await service.syncFile(path);
    expect(ingest).not.toHaveBeenCalled();
    appendFileSync(path, `${completion.slice(-4)}\n`);
    await service.syncFile(path);

    expect(ingest).toHaveBeenCalledOnce();
  });
});
