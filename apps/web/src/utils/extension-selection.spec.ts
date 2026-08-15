import { describe, expect, it } from 'vitest'
import type { ExtensionCard } from '../types/monitor'
import { filterEventsByVisibleKeys, filterExtensionsByKeys, getDisplayedExtensions, reconcileVisibleKeys } from './extension-selection'

const extension = (key: string, detected: boolean): ExtensionCard => ({
  key,
  product: key,
  runtime: key.endsWith('cli') ? 'cli' : 'desktop',
  label: key,
  adapter: {
    id: key,
    active: true,
    capabilities: { completed: true, failed: true, interrupted: false, toolFailed: false, tracing: false },
  },
  event_count: 0,
  detected,
  cliAvailable: key.endsWith('cli'),
  running: false,
  monitorConfigured: false,
  monitorVerified: false,
  lastVerifiedAt: null,
  verificationSource: null,
  detectionSignals: detected ? ['installed'] : [],
})

const extensions = [extension('codex-cli', true), extension('cursor-desktop', false)]

describe('extension selection', () => {
  it('uses the server-provided configurable set instead of the full directory', () => {
    expect(filterExtensionsByKeys(extensions, ['codex-cli'])).toEqual([extensions[0]])
    expect(reconcileVisibleKeys(['codex-cli', 'cursor-desktop'], ['codex-cli'])).toEqual(['codex-cli'])
  })

  it('shows only detected visible platforms in detected mode', () => {
    expect(getDisplayedExtensions(extensions, ['codex-cli', 'cursor-desktop'], 'detected', 'reliable'))
      .toEqual([extensions[0]])
  })

  it('does not hide the all-platform fallback when scanning is unavailable', () => {
    expect(getDisplayedExtensions(extensions, ['codex-cli', 'cursor-desktop'], 'detected', 'unavailable'))
      .toEqual(extensions)
  })

  it('filters the message overview with the same visible platform keys', () => {
    const events = [
      { id: 1, client: 'codex-cli' },
      { id: 2, client: 'cursor-desktop' },
    ] as never

    expect(filterEventsByVisibleKeys(events, ['codex-cli'])).toEqual([events[0]])
    expect(filterEventsByVisibleKeys(events, [])).toEqual([])
  })
})
