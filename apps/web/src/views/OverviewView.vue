<script setup lang="ts">
import { computed, ref } from 'vue'
import { Search } from '@element-plus/icons-vue'
import { monitorApi } from '../api/monitor'
import type { ChannelStatus, ExtensionCard, MonitorEvent } from '../types/monitor'
import MessageFeed from '../components/overview/MessageFeed.vue'
import TaskDetailDialog from '../components/overview/TaskDetailDialog.vue'
import { filterEventsByVisibleKeys } from '../utils/extension-selection'

const props = defineProps<{
  events: MonitorEvent[]
  extensions: ExtensionCard[]
  channels: ChannelStatus[]
  eventCount: number
  visibleExtensions: string[]
}>()
const query = ref('')
const extension = ref('all')
const status = ref('all')
const selectedEvent = ref<MonitorEvent | null>(null)
const displayedExtensions = computed(() => {
  const visible = new Set(props.visibleExtensions)
  return props.extensions.filter(item => visible.has(item.key))
})
const selectEvent = async (event: MonitorEvent) => {
  selectedEvent.value = event
  try {
    selectedEvent.value = await monitorApi.event(event.id)
  } catch {
    // The list item remains usable when the detail refresh races a server restart.
  }
}
const statusOptions = [
  { value: 'all', label: '全部状态' },
  { value: 'completed', label: '已完成' },
  { value: 'failed', label: '失败' },
  { value: 'tool_failed', label: '调用错误' },
  { value: 'interrupted', label: '已中断' },
]

const extensionCount = (key: string) => key === 'all'
  ? props.eventCount
  : displayedExtensions.value.find(item => item.key === key)?.event_count || 0
const visibleEvents = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return filterEventsByVisibleKeys(props.events, props.visibleExtensions).filter((event) => {
    if (extension.value !== 'all' && event.client !== extension.value) return false
    if (status.value !== 'all' && event.status !== status.value) return false
    if (!needle) return true
    return [event.title, event.message, String(event.metadata.task_summary || ''), event.client, event.kind, event.error_code || '']
      .some(value => value.toLowerCase().includes(needle))
  })
})
</script>

<template>
  <section class="message-surface">
    <div class="message-toolbar">
      <el-input v-model="query" :prefix-icon="Search" clearable placeholder="搜索任务或错误码" />
      <el-select v-model="status" class="status-select" aria-label="消息状态">
        <el-option v-for="option in statusOptions" :key="option.value" :label="option.label" :value="option.value" />
      </el-select>
    </div>
    <div class="extension-filter" role="tablist" aria-label="AI 扩展分类">
      <button :class="{ active: extension === 'all' }" type="button" @click="extension = 'all'">
        全部 <span>{{ extensionCount('all') }}</span>
      </button>
      <button
        v-for="item in displayedExtensions"
        :key="item.key"
        :class="{ active: extension === item.key }"
        type="button"
        @click="extension = item.key"
      >
        {{ item.label }} <span>{{ extensionCount(item.key) }}</span>
      </button>
    </div>
    <MessageFeed :events="visibleEvents" :extensions="displayedExtensions" :channels="channels" @select="selectEvent" />
  </section>
  <TaskDetailDialog
    v-model="selectedEvent"
    :extensions="extensions"
    :channels="channels"
  />
</template>
