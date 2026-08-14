import { createHash } from 'node:crypto';
import type { NormalizedEvent } from '../database/database.types';
import type { CreateEventDto } from './dto/create-event.dto';
import { truncateText } from './event-text';

const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
};

export const statusForKind = (kind: string): string => {
  const normalized = kind.toLowerCase();
  if (normalized.includes('tool') && (normalized.includes('fail') || normalized.includes('error'))) return 'tool_failed';
  if (normalized.includes('fail') || normalized.includes('error') || normalized.includes('denied')) return 'failed';
  if (normalized.includes('interrupt') || normalized.includes('cancel')) return 'interrupted';
  if (normalized.includes('complete') || normalized.includes('success')) return 'completed';
  return 'unknown';
};

const messageFromMetadata = (metadata: Record<string, unknown>): string | undefined => {
  for (const key of ['error', 'last_assistant_message', 'message', 'result']) {
    if (metadata[key]) return String(metadata[key]);
  }
  return undefined;
};

export const normalizeEvent = (item: CreateEventDto): NormalizedEvent => {
  const metadata = item.metadata || {};
  const source = String(item.source || metadata.source || 'unknown');
  const client = String(item.client || source);
  const kind = String(item.kind || 'unknown');
  const status = item.status && item.status !== 'unknown' ? String(item.status) : statusForKind(kind);
  const message = truncateText(String(item.message || messageFromMetadata(metadata) || kind), 24_000);
  const digest = createHash('sha256').update(stableStringify(item)).digest('hex').slice(0, 24);
  const eventId = String(item.event_id || metadata.event_id || `${source}:${kind}:${digest}`);
  const labels: Record<string, string> = {
    completed: '任务完成',
    failed: '任务失败',
    interrupted: '任务中断',
    tool_failed: '工具失败',
  };
  return {
    source_event_id: eventId,
    source,
    client,
    kind,
    status,
    title: String(item.title || `${client} · ${labels[statusForKind(kind)] || kind}`),
    message,
    error_code: item.error_code || null,
    metadata,
  };
};
