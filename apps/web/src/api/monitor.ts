import { http } from './http'
import type {
  AnswerSummaryProviderId,
  AnswerSummaryProviderUpdate,
  AnswerSummaryStatus,
  BindingStartResult,
  BindingWaitResult,
  Delivery,
  ExtensionPayload,
  MonitorEvent,
  MonitorStats,
} from '../types/monitor'

export const monitorApi = {
  stats: () => http.get<MonitorStats>('/api/stats'),
  events: (limit = 100) => http.get<MonitorEvent[]>(`/api/events?limit=${limit}`),
  event: (id: number) => http.get<MonitorEvent>(`/api/events/${id}`),
  deliveries: (limit = 200) => http.get<Delivery[]>(`/api/deliveries?limit=${limit}`),
  extensions: () => http.get<ExtensionPayload>('/api/extensions'),
  startBinding: (channel: string) => http.post<BindingStartResult>(`/api/channels/${encodeURIComponent(channel)}/binding/start`),
  waitBinding: (channel: string) => http.post<BindingWaitResult>(`/api/channels/${encodeURIComponent(channel)}/binding/wait`),
  bindCredential: (channel: string, credential: string | Record<string, string>) => http.put<BindingWaitResult>(
    `/api/channels/${encodeURIComponent(channel)}/binding`,
    typeof credential === 'string' ? { credential } : { values: credential },
  ),
  cancelBinding: (channel: string) => http.delete(`/api/channels/${encodeURIComponent(channel)}/binding/session`),
  unbind: (channel: string) => http.delete(`/api/channels/${encodeURIComponent(channel)}/binding`),
  testNotification: (client: string) => http.post<{ channels: string[] }>('/api/test-notification', { client }),
  answerSummary: () => http.get<AnswerSummaryStatus>('/api/answer-summary'),
  updateAnswerSummaryProvider: (provider: AnswerSummaryProviderId, update: AnswerSummaryProviderUpdate) =>
    http.put<AnswerSummaryStatus>(`/api/answer-summary/providers/${provider}`, update),
  removeAnswerSummaryProvider: (provider: AnswerSummaryProviderId) =>
    http.delete<AnswerSummaryStatus>(`/api/answer-summary/providers/${provider}`),
  updateAnswerSummaryOrder: (order: AnswerSummaryProviderId[]) =>
    http.put<AnswerSummaryStatus>('/api/answer-summary/order', { order }),
}
