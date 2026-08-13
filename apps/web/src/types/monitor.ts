export type EventStatus = 'completed' | 'failed' | 'interrupted' | 'tool_failed' | 'unknown' | string
export type DeliveryState = 'pending' | 'retrying' | 'sent' | 'dead' | 'not_configured' | string

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
  delivery_state?: DeliveryState
  delivery_time?: string | null
}

export interface ChannelStatus {
  id: string
  label: string
  bound: boolean
  error: boolean
  bindingMode: 'qr' | 'external' | 'none'
  message?: string
}

export type BindingStartResult =
  | { mode: 'qr'; qrUrl: string; message: string }
  | { mode: 'external'; message: string }

export interface BindingWaitResult {
  connected: boolean
  bound: boolean
  message: string
  qrUrl?: string
}

export interface PlatformIntegration {
  adapterId: string
  mode: 'notify-and-app-server' | 'hooks' | 'generic-webhook'
  state: 'ready' | 'manual'
  capabilities: {
    completed: boolean
    failed: boolean
    interrupted: boolean
    toolFailed: boolean
    tracing: boolean
  }
  description: string
}

export interface PlatformCard {
  key: string
  label: string
  aliases: string[]
  custom: boolean
  integration: PlatformIntegration
  channel: string | null
  detail_url: string
  channel_status: ChannelStatus
  messages: MonitorEvent[]
}

export interface PlatformPayload {
  channels: ChannelStatus[]
  clients: PlatformCard[]
}

export interface MonitorStats {
  events: number
  completed: number
  failed: number
  interrupted: number
  tool_failed: number
  unknown: number
  pending: number
  retrying: number
  sent: number
  dead: number
  [key: string]: number
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
