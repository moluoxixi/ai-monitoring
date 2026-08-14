import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../src/config/app-config.service';
import { AnswerSummaryService } from '../src/answer-summary/answer-summary.service';
import type { NormalizedEvent } from '../src/database/database.types';

const directories: string[] = [];
const originalFetch = globalThis.fetch;

const serviceFor = () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-monitor-summary-'));
  directories.push(directory);
  const path = join(directory, 'answer-summary.json');
  const service = new AnswerSummaryService({
    answerSummaryConfigPath: path,
    answerSummaryTimeoutMs: 1_000,
    host: '127.0.0.1',
    ingestToken: '',
  } as AppConfigService);
  return { service, path };
};

const response = (status: number, content = '') => new Response(
  JSON.stringify(content ? { choices: [{ message: { content } }] } : { error: { message: 'secret upstream error' } }),
  { status, headers: { 'Content-Type': 'application/json' } },
);

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('AnswerSummaryService', () => {
  it('persists configuration atomically without returning API keys', () => {
    const { service, path } = serviceFor();
    const status = service.updateProvider('groq', {
      apiKey: 'private-groq-key', model: 'openai/gpt-oss-20b', enabled: true,
    });

    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain('private-groq-key');
    expect(JSON.stringify(status)).not.toContain('private-groq-key');
    expect(status.providers.find((item) => item.id === 'groq')).toMatchObject({ configured: true, enabled: true });
  });

  it('falls back after 429 and skips the rate-limited provider for the rest of the day', async () => {
    const { service, path } = serviceFor();
    service.updateProvider('groq', { apiKey: 'groq-key', model: 'groq-model', enabled: true });
    service.updateProvider('openrouter', { apiKey: 'router-key', model: 'router-model', enabled: true });
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(response(429))
      .mockResolvedValueOnce(response(200, '已经完成自动回退。'))
      .mockResolvedValueOnce(response(200, '第二次仍走备用渠道。')) as typeof fetch;

    await expect(service.summarize('final answer', 'task')).resolves.toBe('已经完成自动回退。');
    await expect(service.summarize('another answer', 'task')).resolves.toBe('第二次仍走备用渠道。');

    expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    expect(String(vi.mocked(globalThis.fetch).mock.calls[0]?.[0])).toContain('api.groq.com');
    expect(String(vi.mocked(globalThis.fetch).mock.calls[1]?.[0])).toContain('openrouter.ai');
    expect(String(vi.mocked(globalThis.fetch).mock.calls[2]?.[0])).toContain('openrouter.ai');
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { providers: { groq: { cooldownUntil: string } } };
    expect(Date.parse(stored.providers.groq.cooldownUntil)).toBeGreaterThan(Date.now());
    expect(service.status().providers.find((item) => item.id === 'groq')?.lastError).toBe('rate_limited');
  });

  it('returns an empty summary when every configured provider fails', async () => {
    const { service } = serviceFor();
    service.updateProvider('gemini', { apiKey: 'gemini-key', model: 'gemini-model', enabled: true });
    globalThis.fetch = vi.fn(async () => response(503)) as typeof fetch;

    await expect(service.summarize('answer')).resolves.toBe('');
    expect(service.status().providers.find((item) => item.id === 'gemini')?.lastError).toBe('service_unavailable');
  });

  it('runs independent answer summaries concurrently', async () => {
    const { service } = serviceFor();
    service.updateProvider('groq', { apiKey: 'groq-key', model: 'groq-model', enabled: true });
    const first = deferred<Response>();
    const second = deferred<Response>();
    globalThis.fetch = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise) as typeof fetch;

    const firstSummary = service.summarize('first detailed answer', 'first task');
    const secondSummary = service.summarize('second detailed answer', 'second task');
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));

    first.resolve(response(200, '第一项已完成。'));
    second.resolve(response(200, '第二项已完成。'));
    await expect(Promise.all([firstSummary, secondSummary])).resolves.toEqual(['第一项已完成。', '第二项已完成。']);
  });

  it('rejects an echoed summary while retaining the cleaned detail answer', async () => {
    const { service } = serviceFor();
    service.updateProvider('groq', { apiKey: 'groq-key', model: 'groq-model', enabled: true });
    globalThis.fetch = vi.fn(async () => response(200, 'private answer')) as typeof fetch;
    const enriched = await service.enrichEvent({
      source_event_id: 'event', source: 'codex', client: 'codex', kind: 'complete', status: 'completed',
      title: 'done', message: 'task', error_code: null, metadata: { task_summary: 'task' },
    }, 'private answer');

    expect(enriched.metadata.answer_summary).toBeUndefined();
    expect(enriched.metadata.answer_text).toBe('private answer');
  });

  it('redacts secrets from the task summary before sending it upstream', async () => {
    const { service } = serviceFor();
    service.updateProvider('groq', { apiKey: 'groq-key', model: 'groq-model', enabled: true });
    globalThis.fetch = vi.fn(async () => response(200, '已完成安全检查。')) as typeof fetch;

    await service.summarize('the detailed answer', 'token=private-task-token check access');

    const request = vi.mocked(globalThis.fetch).mock.calls[0]?.[1];
    expect(String(request?.body)).not.toContain('private-task-token');
    expect(String(request?.body)).toContain('<redacted>');
  });

  it('rejects a generated summary that echoes the task summary', async () => {
    const { service } = serviceFor();
    service.updateProvider('groq', { apiKey: 'groq-key', model: 'groq-model', enabled: true });
    globalThis.fetch = vi.fn(async () => response(200, 'fix private login')) as typeof fetch;

    await expect(service.summarize('the detailed implementation result', 'fix private login')).resolves.toBe('');
  });

  it('rejects oversized provider responses without buffering them in full', async () => {
    const { service } = serviceFor();
    service.updateProvider('groq', { apiKey: 'groq-key', model: 'groq-model', enabled: true });
    globalThis.fetch = vi.fn(async () => new Response('x'.repeat(128_001), { status: 200 })) as typeof fetch;

    await expect(service.summarize('the detailed answer')).resolves.toBe('');
    expect(service.status().providers.find((item) => item.id === 'groq')?.lastError).toBe('network_error');
  });

  it('reports a malformed persisted configuration without exposing its content', () => {
    const { service, path } = serviceFor();
    writeFileSync(path, '{"version":1,"providers":{"groq":{"apiKey":"private-key"}}');

    const status = service.status();

    expect(status.configurationError).toBe('回答摘要配置文件已损坏');
    expect(JSON.stringify(status)).not.toContain('private-key');
  });

  it('moves temporary answer content into the cleaned detail field', async () => {
    const { service } = serviceFor();
    const event: NormalizedEvent = {
      source_event_id: 'event', source: 'codex', client: 'codex', kind: 'complete', status: 'completed',
      title: 'done', message: 'task', error_code: null,
      metadata: { task_summary: 'task', answer_source: 'private answer' },
    };

    const enriched = await service.enrichEvent(event);

    expect(enriched.metadata.answer_source).toBeUndefined();
    expect(enriched.metadata.answer_text).toBe('private answer');
  });

  it('refuses non-public custom endpoints without sending the answer', async () => {
    const { service } = serviceFor();
    expect(() => service.updateProvider('custom', {
      apiKey: 'custom-key', model: 'custom-model', baseUrl: 'http://127.0.0.1:9000/v1', enabled: true,
    })).toThrow('HTTPS');
    globalThis.fetch = vi.fn() as typeof fetch;

    await expect(service.summarize('private answer')).resolves.toBe('');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects a private HTTPS custom endpoint before opening a connection', async () => {
    const { service } = serviceFor();
    service.updateProvider('custom', {
      apiKey: 'custom-key', model: 'custom-model', baseUrl: 'https://127.0.0.1:9000/v1', enabled: true,
    });
    globalThis.fetch = vi.fn() as typeof fetch;

    await expect(service.summarize('private answer')).resolves.toBe('');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(service.status().providers.find((item) => item.id === 'custom')?.lastError).toBe('network_error');
  });

  it('requires authentication before writing provider config on a non-local bind address', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ai-monitor-summary-'));
    directories.push(directory);
    const service = new AnswerSummaryService({
      answerSummaryConfigPath: join(directory, 'answer-summary.json'),
      answerSummaryTimeoutMs: 1_000,
      host: '0.0.0.0',
      ingestToken: '',
    } as AppConfigService);

    expect(() => service.updateProvider('groq', {
      apiKey: 'private-key', model: 'model', enabled: true,
    })).toThrow('AIMONITOR_INGEST_TOKEN');
  });
});
