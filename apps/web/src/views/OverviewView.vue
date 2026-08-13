<script setup lang="ts">
import { computed, ref } from 'vue'
import { Search } from '@element-plus/icons-vue'
import type { MonitorEvent, PlatformCard } from '../types/monitor'
import MessageFeed from '../components/overview/MessageFeed.vue'

const props = defineProps<{ events: MonitorEvent[]; platforms: PlatformCard[] }>()
const query = ref('')
const platform = ref('all')
const status = ref('all')
const statusOptions = [
  { value: 'all', label: '全部状态' },
  { value: 'completed', label: '已完成' },
  { value: 'failed', label: '失败' },
  { value: 'tool_failed', label: '调用错误' },
  { value: 'interrupted', label: '已中断' },
]

const platformCount = (key: string) => props.events.filter(event => key === 'all' || event.client === key).length
const visibleEvents = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return props.events.filter((event) => {
    if (platform.value !== 'all' && event.client !== platform.value) return false
    if (status.value !== 'all' && event.status !== status.value) return false
    if (!needle) return true
    return [event.title, event.message, event.client, event.kind, event.error_code || '']
      .some(value => value.toLowerCase().includes(needle))
  })
})
</script>

<template>
  <section class="message-surface">
    <div class="message-toolbar">
      <el-input v-model="query" :prefix-icon="Search" clearable placeholder="搜索标题、内容或错误码" />
      <el-select v-model="status" class="status-select" aria-label="消息状态">
        <el-option v-for="option in statusOptions" :key="option.value" :label="option.label" :value="option.value" />
      </el-select>
    </div>
    <div class="platform-filter" role="tablist" aria-label="AI 软件分类">
      <button :class="{ active: platform === 'all' }" type="button" @click="platform = 'all'">
        全部 <span>{{ platformCount('all') }}</span>
      </button>
      <button
        v-for="item in platforms"
        :key="item.key"
        :class="{ active: platform === item.key }"
        type="button"
        @click="platform = item.key"
      >
        {{ item.label }} <span>{{ platformCount(item.key) }}</span>
      </button>
    </div>
    <MessageFeed :events="visibleEvents" :platforms="platforms" />
  </section>
</template>
