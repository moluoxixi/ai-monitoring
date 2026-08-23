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
  /** Internal delivery projection only; never returned by delivery APIs. */
  reply_token?: string | null;
  reply_expires_at?: string | null;
  source: string;
  client: string;
  kind: string;
  status: string;
  title: string;
  message: string;
  error_code?: string | null;
  metadata?: Record<string, unknown>;
  /** Event ingestion time, included only while the worker formats a notification. */
  event_created_at?: string;
  /** Internal delivery projection only; never returned by delivery APIs. */
  answer_text?: string;
}

export interface ReplyRoute {
  delivery_id: number;
  event_id: number;
  channel: string;
  delivery_state: string;
  reply_token: string;
  reply_expires_at: string;
  reply_thread_id: string | null;
  client: string;
  metadata: Record<string, unknown>;
}

export type InboundReplyState = 'processing' | 'accepted' | 'failed';

export interface InboundReplyRow {
  id: number;
  channel: string;
  external_message_id: string;
  delivery_id: number;
  sender_id: string;
  account_id: string;
  text: string;
  state: InboundReplyState;
  last_error: string | null;
  created_at: string;
  accepted_at: string | null;
}
