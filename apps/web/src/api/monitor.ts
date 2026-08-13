import { http } from './http'
import type { BindingStartResult, BindingWaitResult, Delivery, ExtensionPayload, MonitorEvent, MonitorStats } from '../types/monitor'

export const monitorApi = {
  stats: () => http.get<MonitorStats>('/api/stats'),
  events: (limit = 100) => http.get<MonitorEvent[]>(`/api/events?limit=${limit}`),
  deliveries: (limit = 200) => http.get<Delivery[]>(`/api/deliveries?limit=${limit}`),
  extensions: () => http.get<ExtensionPayload>('/api/extensions'),
  startBinding: (channel: string) => http.post<BindingStartResult>(`/api/channels/${encodeURIComponent(channel)}/binding/start`),
  waitBinding: (channel: string) => http.post<BindingWaitResult>(`/api/channels/${encodeURIComponent(channel)}/binding/wait`),
  cancelBinding: (channel: string) => http.delete(`/api/channels/${encodeURIComponent(channel)}/binding/session`),
  unbind: (channel: string) => http.delete(`/api/channels/${encodeURIComponent(channel)}/binding`),
  testNotification: (client: string) => http.post<{ channels: string[] }>('/api/test-notification', { client }),
}
