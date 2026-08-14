export interface NormalizedEvent {
  source_event_id: string;
  source: string;
  client: string;
  kind: string;
  status: string;
  title: string;
  message: string;
  error_code: string | null;
  metadata: Record<string, unknown>;
}

export interface EventRow {
  id: number;
  source_event_id: string;
  source: string;
  client: string;
  kind: string;
  status: string;
  title: string;
  message: string;
  error_code: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  /** Only returned by the single-event detail projection. */
  answer_text?: string;
}

export interface DeliveryRow {
  id: number;
  event_id: number;
  channel: string;
  state: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  sent_at: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  source: string;
  client: string;
  kind: string;
  status: string;
  title: string;
  message: string;
  error_code?: string | null;
  metadata?: Record<string, unknown>;
}
