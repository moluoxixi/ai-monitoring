import type { ExtensionCard, MonitorEvent } from '../types/monitor'

export type ExtensionDisplayMode = 'detected' | 'all'

export const filterExtensionsByKeys = (extensions: ExtensionCard[], keys: string[]): ExtensionCard[] => {
  const allowed = new Set(keys)
  return extensions.filter(extension => allowed.has(extension.key))
}

export const getDisplayedExtensions = (
  extensions: ExtensionCard[],
  visibleKeys: string[],
  mode: ExtensionDisplayMode,
  scanStatus: string,
): ExtensionCard[] => {
  const visible = filterExtensionsByKeys(extensions, visibleKeys)
  // When the host cannot be scanned, every card is a fallback candidate and
  // filtering by `detected` would incorrectly produce an empty page.
  return mode === 'detected' && scanStatus !== 'unavailable'
    ? visible.filter(extension => extension.detected)
    : visible
}

export const reconcileVisibleKeys = (visibleKeys: string[], configurableKeys: string[]): string[] => {
  const configurable = new Set(configurableKeys)
  return [...new Set(visibleKeys)].filter(key => configurable.has(key))
}

export const filterEventsByVisibleKeys = (events: MonitorEvent[], visibleKeys: string[]): MonitorEvent[] => {
  const visible = new Set(visibleKeys)
  return events.filter(event => visible.has(event.client))
}
