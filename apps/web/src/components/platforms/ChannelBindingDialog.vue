<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import QRCode from 'qrcode'
import { CircleCheck, Loading } from '@element-plus/icons-vue'
import { monitorApi } from '../../api/monitor'

const props = defineProps<{
  modelValue: boolean
  channel: string
  label: string
  qrUrl: string
  message: string
}>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; bound: []; failed: [message: string] }>()
const qrImage = ref('')
const state = ref<'preparing' | 'waiting' | 'success' | 'error'>('preparing')
const stateMessage = ref('')
let generation = 0
let completed = false

const title = computed(() => `绑定${props.label}`)

const renderQr = async (value: string) => value.startsWith('data:image/')
  ? value
  : QRCode.toDataURL(value, { width: 248, margin: 1, errorCorrectionLevel: 'M' })

const poll = async (current: number) => {
  while (props.modelValue && current === generation) {
    try {
      const result = await monitorApi.waitBinding(props.channel)
      if (!props.modelValue || current !== generation) return
      if (result.qrUrl && result.qrUrl !== props.qrUrl) qrImage.value = await renderQr(result.qrUrl)
      stateMessage.value = result.message
      if (result.bound) {
        state.value = 'success'
        completed = true
        emit('bound')
        return
      }
      if (result.connected && !result.bound) {
        state.value = 'error'
        emit('failed', result.message)
        return
      }
      state.value = 'waiting'
    } catch (error) {
      if (!props.modelValue || current !== generation) return
      state.value = 'error'
      stateMessage.value = error instanceof Error ? error.message : '绑定状态查询失败'
      emit('failed', stateMessage.value)
      return
    }
  }
}

watch(() => props.modelValue, async (open) => {
  generation += 1
  if (!open) return
  completed = false
  const current = generation
  state.value = 'preparing'
  stateMessage.value = props.message
  qrImage.value = await renderQr(props.qrUrl)
  if (!open || current !== generation) return
  state.value = 'waiting'
  void poll(current)
})

const close = (value: boolean) => {
  emit('update:modelValue', value)
  if (!value && !completed && props.channel) void monitorApi.cancelBinding(props.channel).catch(() => undefined)
}
</script>

<template>
  <el-dialog :model-value="modelValue" :title="title" width="min(430px, calc(100vw - 28px))" @update:model-value="close">
    <div class="qr-binding">
      <div v-if="state === 'success'" class="binding-result success"><el-icon><CircleCheck /></el-icon><strong>绑定完成</strong></div>
      <template v-else>
        <div class="qr-frame"><img v-if="qrImage" :src="qrImage" alt="QQ 机器人绑定二维码" /><el-icon v-else class="is-loading"><Loading /></el-icon></div>
        <p>{{ stateMessage || '请使用手机 QQ 扫描二维码' }}</p>
        <el-tag :type="state === 'error' ? 'danger' : 'info'" effect="plain">{{ state === 'error' ? '绑定失败' : '等待扫码' }}</el-tag>
      </template>
    </div>
    <template #footer><el-button @click="close(false)">{{ state === 'success' ? '完成' : '取消' }}</el-button></template>
  </el-dialog>
</template>
