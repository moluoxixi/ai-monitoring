import { recordValue } from './event-record';

export interface EventTiming {
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
}

const MAX_EXPLICIT_DURATION_MS = 365 * 24 * 60 * 60_000;

const BEIJING_TIME = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export const normalizeEventTimestamp = (value: unknown): string => {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
};

export const eventTiming = (startedAt: unknown, completedAt: unknown): EventTiming | null => {
  const started = normalizeEventTimestamp(startedAt);
  const completed = normalizeEventTimestamp(completedAt);
  if (!started && !completed) return null;
  const startedMs = started ? Date.parse(started) : Number.NaN;
  const completedMs = completed ? Date.parse(completed) : Number.NaN;
  const duration = Number.isFinite(startedMs) && Number.isFinite(completedMs) && completedMs >= startedMs
    ? completedMs - startedMs
    : null;
  return {
    ...(started ? { started_at: started } : {}),
    ...(completed ? { completed_at: completed } : {}),
    ...(duration !== null ? { duration_ms: duration } : {}),
  };
};

const formatTimestamp = (value: string): string => {
  const parts = Object.fromEntries(BEIJING_TIME.formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}（北京时间）`;
};

const formatDuration = (durationMs: number): string => {
  if (durationMs < 1_000) return '不足1秒';
  let seconds = Math.floor(durationMs / 1_000);
  const days = Math.floor(seconds / 86_400);
  seconds %= 86_400;
  const hours = Math.floor(seconds / 3_600);
  seconds %= 3_600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  return [
    days ? `${days}天` : '',
    hours ? `${hours}小时` : '',
    minutes ? `${minutes}分` : '',
    seconds || (!days && !hours && !minutes) ? `${seconds}秒` : '',
  ].filter(Boolean).join('');
};

export const formatEventTiming = (
  metadata: Record<string, unknown> | undefined,
  fallbackCompletedAt?: unknown,
): string => {
  const timing = recordValue(metadata?.timing);
  const started = normalizeEventTimestamp(timing.started_at);
  const completed = normalizeEventTimestamp(timing.completed_at)
    || normalizeEventTimestamp(fallbackCompletedAt);
  const explicitDuration = typeof timing.duration_ms === 'number'
    && Number.isSafeInteger(timing.duration_ms)
    && timing.duration_ms >= 0
    && timing.duration_ms <= MAX_EXPLICIT_DURATION_MS
    ? timing.duration_ms
    : null;
  const hasCompleteTimestamps = Boolean(started && completed);
  const derivedDuration = hasCompleteTimestamps && Date.parse(completed) >= Date.parse(started)
    ? Date.parse(completed) - Date.parse(started)
    : null;
  const duration = hasCompleteTimestamps ? derivedDuration : explicitDuration;
  if (!started && !completed && duration === null) return '';
  return [
    `开始时间：${started ? formatTimestamp(started) : '未采集'}`,
    `完成时间：${completed ? formatTimestamp(completed) : '未采集'}`,
    `总耗时：${duration === null ? '未采集' : formatDuration(duration)}`,
  ].join('\n');
};
