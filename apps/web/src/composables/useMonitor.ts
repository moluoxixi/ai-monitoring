import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { monitorApi } from '../api/monitor'
import { useDesktopIntegrations } from './useDesktopIntegrations'
import type { Delivery, ExtensionPayload, MonitorEvent, MonitorStats, NotificationSettings } from '../types/monitor'

const emptyStats = (): MonitorStats => ({
  events: 0, completed: 0, failed: 0, interrupted: 0, tool_failed: 0,
  unknown: 0, pending: 0, claimed: 0, retrying: 0, sent: 0, dead: 0,
})

export const useMonitor = () => {
  const desktop = useDesktopIntegrations()
  const stats = ref<MonitorStats>(emptyStats())
  const events = ref<MonitorEvent[]>([])
  const extensionPayload = ref<ExtensionPayload>({
    channels: [], extensions: [], configurableExtensions: [], visibleExtensions: [],
    visibleEventCount: 0, scanScope: 'unsupported', scanStatus: 'unavailable', scannedAt: null,
    device: { os: 'other', label: '未知设备', container: false },
  })
  const notificationSettings = ref<NotificationSettings>({ taskLimit: 100, resultLimit: 2000 })
  const loading = ref(true)
  const refreshing = ref(false)
  const error = ref('')
  let timer: number | undefined
  let eventHistoryInitialized = false
  const seenEventIds = new Set<number>()

  const extensions = computed(() => extensionPayload.value.extensions)
  const channels = computed(() => extensionPayload.value.channels)

  const refresh = async (quiet = false) => {
    if (!quiet) refreshing.value = true
    try {
      const [nextStats, nextEvents, nextDeliveries, nextExtensions, nextNotificationSettings] = await Promise.all([
        monitorApi.stats(), monitorApi.events(100), monitorApi.deliveries(200), monitorApi.extensions(),
        monitorApi.notificationSettings().catch(() => notificationSettings.value),
      ])
      stats.value = nextStats
      const deliveryByEvent = new Map<number, Delivery[]>()
      for (const delivery of nextDeliveries) {
        deliveryByEvent.set(delivery.event_id, [...(deliveryByEvent.get(delivery.event_id) || []), delivery])
      }
      const enrichedEvents = nextEvents.map(event => {
        const deliveries = deliveryByEvent.get(event.id) || []
        const deliveryState = deliveries.some(item => item.state === 'dead') ? 'dead'
          : deliveries.some(item => item.state === 'retrying') ? 'retrying'
            : deliveries.some(item => item.state === 'claimed') ? 'claimed'
            : deliveries.some(item => item.state === 'pending') ? 'pending'
              : deliveries.length && deliveries.every(item => item.state === 'sent') ? 'sent' : 'not_configured'
        const deliveryTime = deliveries
          .map(item => item.sent_at || item.next_attempt_at)
          .filter((value): value is string => Boolean(value))
          .sort().at(-1) || null
        return {
          ...event,
          deliveries,
          delivery_state: deliveryState,
          delivery_time: deliveryTime,
        }
      })
      if (eventHistoryInitialized) {
        const freshEvents = enrichedEvents.filter(event => !seenEventIds.has(event.id))
        void Promise.all(freshEvents.map(event => desktop.notifyTerminalEvent(event)))
      }
      enrichedEvents.forEach(event => seenEventIds.add(event.id))
      if (seenEventIds.size > 1000) {
        seenEventIds.clear()
        enrichedEvents.forEach(event => seenEventIds.add(event.id))
      }
      eventHistoryInitialized = true
      events.value = enrichedEvents
      extensionPayload.value = nextExtensions
      notificationSettings.value = nextNotificationSettings
      error.value = ''
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : '数据加载失败'
    } finally {
      loading.value = false
      refreshing.value = false
    }
  }

  onMounted(() => {
    void refresh()
    timer = window.setInterval(() => void refresh(true), 15_000)
  })
  onBeforeUnmount(() => window.clearInterval(timer))

  return { stats, events, extensions, channels, extensionPayload, notificationSettings, loading, refreshing, error, refresh, desktop }
}
