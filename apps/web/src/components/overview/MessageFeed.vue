<script setup lang="ts">
import { CircleCheck, CircleClose, Clock, Link, Warning } from '@element-plus/icons-vue'
import type { MonitorEvent, PlatformCard } from '../../types/monitor'
import { deliveryLabel, formatTime, statusLabel, statusTone } from '../../utils/presentation'

const props = defineProps<{ events: MonitorEvent[]; platforms: PlatformCard[] }>()

const platformFor = (client: string) => props.platforms.find((item) => item.key === client || item.aliases.includes(client.toLowerCase()))
const phoenixUrl = (event: MonitorEvent) => platformFor(event.client)?.detail_url || '#'
const clientLabel = (event: MonitorEvent) => platformFor(event.client)?.label || event.client
const iconFor = (status: string) => status === 'completed' ? CircleCheck : status === 'interrupted' ? Clock : status === 'unknown' ? Warning : CircleClose
</script>

<template>
  <div v-if="events.length" class="message-feed">
    <a
      v-for="event in events"
      :key="event.id"
      class="message-row"
      :href="phoenixUrl(event)"
      target="_blank"
      rel="noopener noreferrer"
    >
      <span class="event-icon" :class="statusTone(event.status)"><el-icon><component :is="iconFor(event.status)" /></el-icon></span>
      <span class="message-main">
        <span class="message-title"><strong>{{ event.title }}</strong><el-tag size="small" effect="plain">{{ clientLabel(event) }}</el-tag></span>
        <span class="message-copy">{{ event.message }}</span>
        <span class="message-meta">
          <b :class="statusTone(event.status)">{{ statusLabel(event.status) }}</b>
          <span>{{ deliveryLabel(event.delivery_state) }}</span>
          <span>{{ formatTime(event.created_at) }}</span>
          <span v-if="event.error_code">{{ event.error_code }}</span>
        </span>
      </span>
      <el-icon class="row-link"><Link /></el-icon>
    </a>
  </div>
  <el-empty v-else description="还没有收到 AI 任务消息" :image-size="72" />
</template>
