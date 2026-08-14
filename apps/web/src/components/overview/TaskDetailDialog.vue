<script setup lang="ts">
import { computed } from 'vue'
import { CircleCheck, CircleClose, Clock, Document, Warning } from '@element-plus/icons-vue'
import type { ChannelStatus, ExtensionCard, MonitorEvent } from '../../types/monitor'
import { deliveryLabel, formatTime, statusLabel, statusTone } from '../../utils/presentation'

const props = defineProps<{
  modelValue: MonitorEvent | null
  extensions: ExtensionCard[]
  channels: ChannelStatus[]
}>()
const emit = defineEmits<{ 'update:modelValue': [event: MonitorEvent | null] }>()

const event = computed(() => props.modelValue)
const extensionFor = (client: string) => props.extensions.find((item) => item.key === client)
const clientLabel = (client: string) => extensionFor(client)?.label || client
const taskSummary = (item: MonitorEvent) => typeof item.metadata.task_summary === 'string'
  ? item.metadata.task_summary
  : item.message.replace(/^提问[：:]\s*/, '')
const answerText = (item: MonitorEvent) => typeof item.answer_text === 'string' ? item.answer_text : ''
const failureMessage = (item: MonitorEvent) => typeof item.metadata.failure_message === 'string'
  ? item.metadata.failure_message
  : item.error_code || item.message
const iconFor = (status: string) => status === 'completed' ? CircleCheck : status === 'interrupted' ? Clock : status === 'unknown' ? Warning : CircleClose
const channelLabel = (id: string) => props.channels.find(channel => channel.id === id)?.label || id
</script>

<template>
  <el-dialog
    :model-value="Boolean(event)"
    class="task-detail-dialog"
    width="min(680px, calc(100vw - 28px))"
    destroy-on-close
    @close="emit('update:modelValue', null)"
  >
    <template #header>
      <div v-if="event" class="task-detail-heading">
        <span class="event-icon" :class="statusTone(event.status)"><el-icon><component :is="iconFor(event.status)" /></el-icon></span>
        <div>
          <strong>{{ clientLabel(event.client) }} · {{ statusLabel(event.status) }}</strong>
          <small>{{ formatTime(event.created_at) }}</small>
        </div>
      </div>
    </template>
    <div v-if="event" class="task-detail-content">
      <section class="detail-block">
        <div class="detail-label"><el-icon><Document /></el-icon>本次提问</div>
        <p>{{ taskSummary(event) || '未提供提问内容' }}</p>
      </section>
      <section v-if="event.status === 'completed'" class="detail-block detail-block-answer">
        <div class="detail-label"><el-icon><CircleCheck /></el-icon>任务结果</div>
        <p>{{ answerText(event) || '未采集到最终回答' }}</p>
      </section>
      <section v-if="['failed', 'tool_failed', 'interrupted'].includes(event.status)" class="detail-block detail-block-error">
        <div class="detail-label"><el-icon><CircleClose /></el-icon>失败原因</div>
        <p>{{ failureMessage(event) || '未提供失败信息' }}</p>
      </section>
      <section class="detail-block">
        <div class="detail-label">通知状态</div>
        <div v-if="event.deliveries?.length" class="detail-deliveries">
          <div v-for="delivery in event.deliveries" :key="delivery.id" class="detail-delivery">
            <span>{{ channelLabel(delivery.channel) }}</span>
            <b :class="statusTone(delivery.state === 'sent' ? 'completed' : delivery.state === 'dead' ? 'failed' : 'interrupted')">{{ deliveryLabel(delivery.state) }}</b>
            <small v-if="delivery.last_error">{{ delivery.last_error }}</small>
          </div>
        </div>
        <p v-else>未配置通知通道</p>
      </section>
    </div>
    <template #footer>
      <el-button @click="emit('update:modelValue', null)">关闭</el-button>
    </template>
  </el-dialog>
</template>
