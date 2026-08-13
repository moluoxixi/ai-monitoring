import { http } from './http'
import type { BindingStartResult, BindingWaitResult, Delivery, MonitorEvent, MonitorStats, PlatformCard, PlatformPayload } from '../types/monitor'

export const monitorApi = {
  stats: () => http.get<MonitorStats>('/api/stats'),
  events: (limit = 100) => http.get<MonitorEvent[]>(`/api/events?limit=${limit}`),
  deliveries: (limit = 200) => http.get<Delivery[]>(`/api/deliveries?limit=${limit}`),
  platforms: () => http.get<PlatformPayload>('/api/clients'),
  createPlatform: (body: { key: string; label: string; aliases: string[] }) =>
    http.post<{ ok: boolean } & PlatformCard>('/api/clients', body),
  updatePlatform: (key: string, body: { channel: string | null }) =>
    http.put(`/api/clients/${encodeURIComponent(key)}`, body),
  deletePlatform: (key: string) => http.delete(`/api/clients/${encodeURIComponent(key)}`),
  startBinding: (channel: string) => http.post<BindingStartResult>(`/api/channels/${encodeURIComponent(channel)}/binding/start`),
  waitBinding: (channel: string) => http.post<BindingWaitResult>(`/api/channels/${encodeURIComponent(channel)}/binding/wait`),
  cancelBinding: (channel: string) => http.delete(`/api/channels/${encodeURIComponent(channel)}/binding/session`),
  unbind: (channel: string) => http.delete(`/api/channels/${encodeURIComponent(channel)}/binding`),
  testNotification: (client: string) => http.post<{ channels: string[] }>('/api/test-notification', { client }),
}
