<script setup lang="ts">
import { CircleCheck, CircleClose, Clock, Document, Warning } from '@element-plus/icons-vue'
import type { ChannelStatus, ExtensionCard, MonitorEvent } from '../../types/monitor'
import { deliveryLabel, formatTime, statusLabel, statusTone } from '../../utils/presentation'

const props = defineProps<{ events: MonitorEvent[]; extensions: ExtensionCard[]; channels: ChannelStatus[] }>()
const emit = defineEmits<{ select: [event: MonitorEvent] }>()

const extensionFor = (client: string) => props.extensions.find((item) => item.key === client)
const clientLabel = (event: MonitorEvent) => extensionFor(event.client)?.label || event.client
const taskSummary = (event: MonitorEvent) => typeof event.metadata.task_summary === 'string'
  ? event.metadata.task_summary
  : event.message.replace(/^提问[：:]\s*/, '')
const deliverySummary = (event: MonitorEvent) => {
  if (!event.deliveries?.length) return deliveryLabel(event.delivery_state)
  return event.deliveries.map((delivery) => {
    const channel = props.channels.find(item => item.id === delivery.channel)
    return `${channel?.label || delivery.channel}：${deliveryLabel(delivery.state)}`
  }).join(' / ')
}
const iconFor = (status: string) => status === 'completed' ? CircleCheck : status === 'interrupted' ? Clock : status === 'unknown' ? Warning : CircleClose
</script>

<template>
  <div v-if="events.length" class="message-feed">
    <button
      v-for="event in events"
      :key="event.id"
      class="message-row"
      type="button"
      @click="emit('select', event)"
    >
      <span class="event-icon" :class="statusTone(event.status)"><el-icon><component :is="iconFor(event.status)" /></el-icon></span>
      <span class="message-main">
        <span class="message-title"><strong>{{ taskSummary(event) }}</strong></span>
        <span class="message-meta">
          <span class="client-name">{{ clientLabel(event) }}</span>
          <b :class="statusTone(event.status)">{{ statusLabel(event.status) }}</b>
          <span>{{ deliverySummary(event) }}</span>
          <span>{{ formatTime(event.created_at) }}</span>
          <span v-if="event.error_code">{{ event.error_code }}</span>
        </span>
      </span>
      <el-icon class="row-link"><Document /></el-icon>
    </button>
  </div>
  <el-empty v-else description="还没有收到 AI 任务消息" :image-size="72" />
</template>
