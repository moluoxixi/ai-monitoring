import type { DeliveryState, EventStatus } from '../types/monitor'

export const statusLabel = (status: EventStatus): string => ({
  completed: '已完成', failed: '任务失败', interrupted: '已中断', tool_failed: '调用失败', unknown: '未知',
}[status] || status)

export const deliveryLabel = (state?: DeliveryState): string => ({
  pending: '待发送', retrying: '重试中', sent: '已发送', dead: '发送失败', not_configured: '未配置通知',
}[state || 'not_configured'] || state || '未配置通知')

export const statusTone = (status: EventStatus): 'success' | 'danger' | 'warning' | 'info' => {
  if (status === 'completed') return 'success'
  if (status === 'failed' || status === 'tool_failed') return 'danger'
  if (status === 'interrupted') return 'warning'
  return 'info'
}

export const formatTime = (value?: string | null): string => {
  if (!value) return '刚刚'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

export const platformInitial = (label: string): string => label.trim().slice(0, 1).toUpperCase()
