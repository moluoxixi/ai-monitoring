export type EventStatus = 'completed' | 'failed' | 'interrupted' | 'tool_failed' | 'unknown' | string
export type DeliveryState = 'pending' | 'claimed' | 'retrying' | 'sent' | 'dead' | 'not_configured' | string

export interface MonitorEvent {
  id: number
  source_event_id: string
  source: string
  client: string
  kind: string
  status: EventStatus
  title: string
  message: string
  error_code: string | null
  metadata: Record<string, unknown>
  created_at: string
  answer_text?: string
  deliveries?: Delivery[]
  delivery_state?: DeliveryState
  delivery_time?: string | null
}

export interface ChannelStatus {
  id: string
  label: string
  bound: boolean
  error: boolean
  bindingMode: 'qr' | 'credential' | 'external' | 'none'
  message?: string
}

export interface ChannelFormField {
  key: string
  label: string
  type: 'text' | 'password' | 'url' | 'number' | 'select'
  required: boolean
  placeholder?: string
  defaultValue?: string
  options?: Array<{ label: string; value: string }>
}

export interface ChannelFormSchema {
  fields: ChannelFormField[]
}

export type BindingStartResult =
  | { mode: 'qr'; qrUrl: string; message: string }
  | { mode: 'credential'; message: string; helpUrl?: string; form?: ChannelFormSchema }
  | { mode: 'external'; message: string }

export interface BindingWaitResult {
  connected: boolean
  bound: boolean
  message: string
  qrUrl?: string
}

export interface ExtensionAdapter {
  id: string
  active: boolean
  capabilities: {
    completed: boolean
    failed: boolean
    interrupted: boolean
    toolFailed: boolean
    tracing: boolean
  }
}

export interface ExtensionCard {
  key: string
  label: string
  aliases: string[]
  adapter: ExtensionAdapter
  event_count: number
}

export interface ExtensionPayload {
  channels: ChannelStatus[]
  extensions: ExtensionCard[]
}

export interface MonitorStats {
  events: number
  completed: number
  failed: number
  interrupted: number
  tool_failed: number
  unknown: number
  pending: number
  claimed: number
  retrying: number
  sent: number
  dead: number
  [key: string]: number
}

export type AnswerSummaryProviderId = 'groq' | 'openrouter' | 'gemini' | 'custom'

export interface AnswerSummaryProviderStatus {
  id: AnswerSummaryProviderId
  label: string
  configured: boolean
  enabled: boolean
  model: string
  baseUrl: string
  apiKeyUrl?: string
  custom: boolean
  cooldownUntil?: string
  lastError?: string
}

export interface AnswerSummaryStatus {
  order: AnswerSummaryProviderId[]
  providers: AnswerSummaryProviderStatus[]
  configurationError?: string
}

export interface AnswerSummaryProviderUpdate {
  apiKey?: string
  model: string
  baseUrl?: string
  enabled: boolean
}

export interface Delivery {
  id: number
  event_id: number
  channel: string
  state: DeliveryState
  attempts: number
  next_attempt_at: string
  last_error: string | null
  sent_at: string | null
}
