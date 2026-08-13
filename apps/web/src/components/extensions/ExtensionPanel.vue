<script setup lang="ts">
import { computed } from 'vue'
import { Bell, Check, CircleCheck, Link, Message } from '@element-plus/icons-vue'
import type { ChannelStatus, ExtensionCard } from '../../types/monitor'

const props = defineProps<{ extension: ExtensionCard; channels: ChannelStatus[]; saving: boolean }>()
const emit = defineEmits<{
  test: []
  bind: [channel: string]
  unbind: [channel: string]
}>()

const bindableChannels = computed(() => props.channels.filter(item => item.bindingMode !== 'none'))
const boundCount = computed(() => props.channels.filter(item => item.bound).length)
const capabilities = computed(() => [
  ['任务完成', props.extension.adapter.capabilities.completed],
  ['任务失败', props.extension.adapter.capabilities.failed],
  ['任务中断', props.extension.adapter.capabilities.interrupted],
  ['工具错误', props.extension.adapter.capabilities.toolFailed],
  ['Trace', props.extension.adapter.capabilities.tracing],
].filter((item): item is [string, true] => item[1] === true))
</script>

<template>
  <section class="extension-panel">
    <header class="extension-header">
      <div class="extension-identity">
        <span class="extension-glyph">{{ extension.label.slice(0, 1) }}</span>
        <div>
          <h2>{{ extension.label }}</h2>
          <span class="extension-state" :class="{ active: extension.adapter.active }">
            <i />{{ extension.adapter.active ? '已启用' : '未启用' }}
          </span>
        </div>
      </div>
      <div class="extension-actions">
        <el-button :icon="Link" tag="a" :href="extension.detail_url" target="_blank">监控详情</el-button>
        <el-button
          type="primary"
          :icon="Bell"
          :disabled="!boundCount"
          :loading="saving"
          @click="emit('test')"
        >
          测试通知
        </el-button>
      </div>
    </header>

    <div class="extension-section capability-section">
      <div class="section-heading">
        <span class="section-icon"><el-icon><CircleCheck /></el-icon></span>
        <strong>事件能力</strong>
      </div>
      <div class="capability-list">
        <span v-for="item in capabilities" :key="item[0]"><el-icon><Check /></el-icon>{{ item[0] }}</span>
      </div>
    </div>

    <div class="extension-section channel-section">
      <div class="section-heading">
        <span class="section-icon"><el-icon><Message /></el-icon></span>
        <strong>通知通道</strong>
        <small>{{ boundCount }}/{{ bindableChannels.length }}</small>
      </div>
      <div class="channel-bindings">
        <div v-for="channel in bindableChannels" :key="channel.id" class="binding-row" :class="{ bound: channel.bound, error: channel.error }">
          <span class="channel-mark">{{ channel.label.slice(0, 1) }}</span>
          <span class="channel-copy">
            <strong>{{ channel.label }}</strong>
            <small>{{ channel.error ? '连接异常' : channel.bound ? '已绑定' : '未绑定' }}</small>
          </span>
          <el-button v-if="channel.bound" text size="small" @click="emit('unbind', channel.id)">解绑</el-button>
          <el-button v-else size="small" type="primary" @click="emit('bind', channel.id)">绑定</el-button>
        </div>
      </div>
    </div>
  </section>
</template>
