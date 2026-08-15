import { describe, expect, it } from 'vitest'
import { isTauriRuntime, isTerminalMonitorEvent } from './useDesktopIntegrations'
import type { MonitorEvent } from '../types/monitor'

const event = (status: string): MonitorEvent => ({
  id: 1,
  source_event_id: 'source-1',
  source: 'test',
  client: 'codex-cli',
  kind: 'task',
  status,
  title: '测试任务',
  message: '测试消息',
  error_code: null,
  metadata: {},
  created_at: new Date(0).toISOString(),
})

describe('desktop integrations', () => {
  it('only treats terminal statuses as native notification candidates', () => {
    expect(isTerminalMonitorEvent(event('completed'))).toBe(true)
    expect(isTerminalMonitorEvent(event('failed'))).toBe(true)
    expect(isTerminalMonitorEvent(event('interrupted'))).toBe(true)
    expect(isTerminalMonitorEvent(event('tool_failed'))).toBe(true)
    expect(isTerminalMonitorEvent(event('pending'))).toBe(false)
  })

  it('does not detect a Tauri runtime in browser test environments', () => {
    expect(isTauriRuntime()).toBe(false)
  })
})
