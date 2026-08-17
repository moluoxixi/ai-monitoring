import { onMounted, ref } from 'vue'
import type { MonitorEvent } from '../types/monitor'

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'interrupted', 'tool_failed'])
const MAX_NOTIFICATION_BODY_LENGTH = 240

export const isTauriRuntime = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export const isTerminalMonitorEvent = (event: MonitorEvent) => TERMINAL_STATUSES.has(event.status)
  && event.metadata.notification_state !== 'diagnostic'
  && event.metadata.terminal !== false

const notificationBody = (event: MonitorEvent) => {
  const text = event.answer_text || event.message || event.title
  return text.length > MAX_NOTIFICATION_BODY_LENGTH
    ? `${text.slice(0, MAX_NOTIFICATION_BODY_LENGTH - 1)}…`
    : text
}

export interface DesktopIntegrations {
  available: boolean
  autostartEnabled: ReturnType<typeof ref<boolean>>
  autostartLoading: ReturnType<typeof ref<boolean>>
  refreshAutostart: () => Promise<void>
  setAutostart: (enabled: boolean) => Promise<void>
  notifyTerminalEvent: (event: MonitorEvent) => Promise<void>
}

export const useDesktopIntegrations = (): DesktopIntegrations => {
  const available = isTauriRuntime()
  const autostartEnabled = ref(false)
  const autostartLoading = ref(false)
  let autostartApi: typeof import('@tauri-apps/plugin-autostart') | undefined
  let notificationApi: typeof import('@tauri-apps/plugin-notification') | undefined
  let notificationPermission: boolean | undefined

  const loadAutostart = async () => {
    autostartApi ||= await import('@tauri-apps/plugin-autostart')
    return autostartApi
  }

  const loadNotifications = async () => {
    notificationApi ||= await import('@tauri-apps/plugin-notification')
    return notificationApi
  }

  const refreshAutostart = async () => {
    if (!available) return
    autostartEnabled.value = await (await loadAutostart()).isEnabled()
  }

  const setAutostart = async (enabled: boolean) => {
    if (!available) return
    const previous = autostartEnabled.value
    autostartLoading.value = true
    try {
      const api = await loadAutostart()
      if (enabled) await api.enable()
      else await api.disable()
      autostartEnabled.value = await api.isEnabled()
    } catch (reason) {
      autostartEnabled.value = previous
      throw reason
    } finally {
      autostartLoading.value = false
    }
  }

  const notifyTerminalEvent = async (event: MonitorEvent) => {
    if (!available || !isTerminalMonitorEvent(event)) return
    try {
      const api = await loadNotifications()
      notificationPermission ??= await api.isPermissionGranted()
      if (!notificationPermission) {
        notificationPermission = (await api.requestPermission()) === 'granted'
      }
      if (!notificationPermission) return
      api.sendNotification({
        title: event.title || 'AI Monitor',
        body: notificationBody(event),
        extra: { eventId: event.id },
      })
    } catch {
      // Native notification failures must not interrupt monitor polling.
    }
  }

  onMounted(() => {
    void refreshAutostart().catch(() => undefined)
  })

  return {
    available,
    autostartEnabled,
    autostartLoading,
    refreshAutostart,
    setAutostart,
    notifyTerminalEvent,
  }
}
