import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../src/config/app-config.service';
import type { EventRow } from '../src/database/database.types';
import { PhoenixTraceLinkService } from '../src/events/phoenix-trace-link.service';

const event = (metadata: Record<string, unknown> = {}): EventRow => ({
  id: 42,
  source_event_id: 'thread:turn:completed',
  source: 'codex',
  client: 'codex',
  kind: 'task_complete',
  status: 'completed',
  title: 'Codex completed',
  message: 'done',
  error_code: null,
  metadata,
  created_at: '2026-08-13T12:00:00+00:00',
});

const response = (payload: unknown): Response => ({
  ok: true,
  status: 200,
  json: vi.fn(async () => payload),
}) as unknown as Response;

describe('PhoenixTraceLinkService', () => {
  const record = vi.fn(() => '');
  const flush = vi.fn(async () => true);
  const setEventTraceId = vi.fn();
  const service = new PhoenixTraceLinkService(
    { phoenixUrl: 'http://127.0.0.1:6006/' } as AppConfigService,
    { record, flush } as never,
    { setEventTraceId } as never,
  );

  afterEach(() => {
    vi.unstubAllGlobals();
    record.mockReset();
    record.mockReturnValue('');
    flush.mockReset();
    flush.mockResolvedValue(true);
    setEventTraceId.mockReset();
  });

  it('uses direct trace metadata without querying Phoenix', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(service.resolve(event({
      project_id: 'UHJvamVjdDo0',
      trace_id: 'trace-1',
      span_node_id: 'U3Bhbjox',
    }))).resolves.toBe('http://127.0.0.1:6006/projects/UHJvamVjdDo0/traces/trace-1?selectedSpanNodeId=U3Bhbjox');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('resolves trace-only metadata to a canonical Phoenix trace and span URL', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ data: { getTraceByOtelId: {
      traceId: 'trace-1',
      project: { id: 'UHJvamVjdDo0', name: 'ai-coding-agents' },
      spans: { edges: [{ node: { id: 'U3Bhbjox' } }] },
    } } }));
    vi.stubGlobal('fetch', fetch);

    await expect(service.resolve(event({ trace_id: 'trace-1' })))
      .resolves.toBe('http://127.0.0.1:6006/projects/UHJvamVjdDo0/traces/trace-1?selectedSpanNodeId=U3Bhbjox');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('falls back to projects when stored trace validation cannot reach Phoenix', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));

    await expect(service.resolve(event({ trace_id: 'trace-1' })))
      .resolves.toBe('http://127.0.0.1:6006/projects');
  });

  it('resolves the exact Codex turn through Phoenix GraphQL', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response({ data: { projects: { edges: [{ node: { name: 'ai-coding-agents' } }] } } }))
      .mockResolvedValueOnce(response({ data: { getProjectByName: { spans: { edges: [{ node: {
        id: 'U3Bhbjo5', spanId: 'span-otel', startTime: '2026-08-13T11:59:59+00:00',
        trace: { traceId: 'trace-otel', project: { id: 'UHJvamVjdDo0', name: 'ai-coding-agents' } },
      } }] } } } }));
    vi.stubGlobal('fetch', fetch);

    await expect(service.resolve(event({ thread_id: 'thread-1', turn_id: 'turn-1' })))
      .resolves.toBe('http://127.0.0.1:6006/projects/UHJvamVjdDo0/traces/trace-otel?selectedSpanNodeId=U3Bhbjo5');
    const body = JSON.parse(fetch.mock.calls[1]![1]!.body as string);
    expect(body.variables.filter).toContain('attributes["codex"]["turn_id"] == "turn-1"');
  });

  it('falls back to the closest session trace when the exact turn is unavailable', async () => {
    const empty = { data: { getProjectByName: { spans: { edges: [] } } } };
    const projects = { data: { projects: { edges: [{ node: { name: 'claude-code' } }] } } };
    const match = { data: { getProjectByName: { spans: { edges: [{ node: {
      id: 'U3Bhbjo3', spanId: 'span-3', startTime: '2026-08-13T11:59:50+00:00',
      trace: { traceId: 'trace-3', project: { id: 'UHJvamVjdDoz', name: 'claude-code' } },
    } }] } } } };
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(projects))
      .mockResolvedValueOnce(response(empty))
      .mockResolvedValueOnce(response(match));
    vi.stubGlobal('fetch', fetch);

    const claude = { ...event({ session_id: 'session-1', turn_id: 'turn-9' }), client: 'claude' };
    await expect(service.resolve(claude))
      .resolves.toContain('/projects/UHJvamVjdDoz/traces/trace-3?selectedSpanNodeId=U3Bhbjo3');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not link an unrelated old trace from the same session', async () => {
    const projects = { data: { projects: { edges: [{ node: { name: 'ai-coding-agents' } }] } } };
    const oldMatch = { data: { getProjectByName: { spans: { edges: [{ node: {
      id: 'U3Bhbjox', spanId: 'old-span', startTime: '2026-08-13T10:00:00+00:00',
      trace: { traceId: 'old-trace', project: { id: 'UHJvamVjdDo0', name: 'ai-coding-agents' } },
    } }] } } } };
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(projects))
      .mockResolvedValueOnce(response(oldMatch));
    vi.stubGlobal('fetch', fetch);

    await expect(service.resolve(event({ thread_id: 'thread-1' })))
      .resolves.toBe('http://127.0.0.1:6006/projects');
  });

  it('falls back to the Phoenix project list when lookup is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await expect(service.resolve(event({ thread_id: 'thread-1' }))).resolves.toBe('http://127.0.0.1:6006/projects');
  });

  it('creates and persists a lifecycle trace when Phoenix has no matching telemetry', async () => {
    const projects = { data: { projects: { edges: [{ node: { name: 'ai-coding-agents' } }] } } };
    const empty = { data: { getProjectByName: { spans: { edges: [] } } } };
    const generated = { data: { getTraceByOtelId: {
      traceId: '0123456789abcdef0123456789abcdef',
      project: { id: 'UHJvamVjdDo0', name: 'ai-coding-agents' },
      spans: { edges: [{ node: { id: 'U3Bhbjo5' } }] },
    } } };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(projects))
      .mockResolvedValueOnce(response(empty))
      .mockResolvedValueOnce(response(empty))
      .mockResolvedValueOnce(response(empty))
      .mockResolvedValueOnce(response(generated)));
    record.mockReturnValue('0123456789abcdef0123456789abcdef');
    const missing = event({ thread_id: 'thread-1', turn_id: 'turn-1' });

    await expect(service.resolve(missing)).resolves.toBe(
      'http://127.0.0.1:6006/projects/UHJvamVjdDo0/traces/0123456789abcdef0123456789abcdef?selectedSpanNodeId=U3Bhbjo5',
    );
    expect(setEventTraceId).toHaveBeenCalledWith(
      missing.source_event_id,
      '0123456789abcdef0123456789abcdef',
    );
    expect(flush).toHaveBeenCalledOnce();
  });

  it('deduplicates concurrent lifecycle trace generation for the same event', async () => {
    const projects = { data: { projects: { edges: [] } } };
    const generated = { data: { getTraceByOtelId: {
      traceId: '0123456789abcdef0123456789abcdef',
      project: { id: 'UHJvamVjdDo0', name: 'ai-coding-agents' },
      spans: { edges: [] },
    } } };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(projects))
      .mockResolvedValueOnce(response(generated)));
    record.mockReturnValue('0123456789abcdef0123456789abcdef');
    let releaseFlush!: () => void;
    flush.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      releaseFlush = () => resolve(true);
    }));
    const missing = event({ thread_id: 'thread-1', turn_id: 'turn-1' });

    const first = service.resolve(missing);
    const second = service.resolve({ ...missing, metadata: { ...missing.metadata } });
    await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
    releaseFlush();

    await expect(Promise.all([first, second])).resolves.toEqual([
      'http://127.0.0.1:6006/projects/UHJvamVjdDo0/traces/0123456789abcdef0123456789abcdef',
      'http://127.0.0.1:6006/projects/UHJvamVjdDo0/traces/0123456789abcdef0123456789abcdef',
    ]);
    expect(record).toHaveBeenCalledOnce();
    expect(setEventTraceId).toHaveBeenCalledOnce();
  });

  it('falls back to projects when generated trace polling fails', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response({ data: { projects: { edges: [] } } }))
      .mockRejectedValueOnce(new Error('GraphQL offline')));
    record.mockReturnValue('0123456789abcdef0123456789abcdef');

    await expect(service.resolve(event({ thread_id: 'thread-1', turn_id: 'turn-1' })))
      .resolves.toBe('http://127.0.0.1:6006/projects');
  });
});
