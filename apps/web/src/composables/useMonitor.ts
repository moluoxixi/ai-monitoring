import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { monitorApi } from '../api/monitor'
import type { MonitorEvent, MonitorStats, PlatformCard, PlatformPayload } from '../types/monitor'

const emptyStats = (): MonitorStats => ({
  events: 0, completed: 0, failed: 0, interrupted: 0, tool_failed: 0,
  unknown: 0, pending: 0, retrying: 0, sent: 0, dead: 0,
})

export const useMonitor = () => {
  const stats = ref<MonitorStats>(emptyStats())
  const events = ref<MonitorEvent[]>([])
  const platformPayload = ref<PlatformPayload>({ channels: [], clients: [] })
  const loading = ref(true)
  const refreshing = ref(false)
  const error = ref('')
  const updatedAt = ref<Date | null>(null)
  let timer: number | undefined

  const platforms = computed(() => platformPayload.value.clients)
  const channels = computed(() => platformPayload.value.channels)

  const refresh = async (quiet = false) => {
    if (!quiet) refreshing.value = true
    try {
      const [nextStats, nextEvents, nextDeliveries, nextPlatforms] = await Promise.all([
        monitorApi.stats(), monitorApi.events(100), monitorApi.deliveries(200), monitorApi.platforms(),
      ])
      stats.value = nextStats
      const deliveryByEvent = new Map(nextDeliveries.map(item => [item.event_id, item]))
      events.value = nextEvents.map(event => {
        const delivery = deliveryByEvent.get(event.id)
        return {
          ...event,
          delivery_state: delivery?.state || 'not_configured',
          delivery_time: delivery ? delivery.sent_at || delivery.next_attempt_at : null,
        }
      })
      platformPayload.value = nextPlatforms
      updatedAt.value = new Date()
      error.value = ''
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : '数据加载失败'
    } finally {
      loading.value = false
      refreshing.value = false
    }
  }

  const replacePlatform = (platform: PlatformCard) => {
    const index = platformPayload.value.clients.findIndex((item) => item.key === platform.key)
    if (index === -1) platformPayload.value.clients.push(platform)
    else platformPayload.value.clients[index] = platform
  }

  onMounted(() => {
    void refresh()
    timer = window.setInterval(() => void refresh(true), 15_000)
  })
  onBeforeUnmount(() => window.clearInterval(timer))

  return { stats, events, platforms, channels, loading, refreshing, error, updatedAt, refresh, replacePlatform }
}
