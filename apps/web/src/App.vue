<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { monitorApi } from './api/monitor'
import AppHeader from './components/layout/AppHeader.vue'
import ChannelBindingDialog from './components/channels/ChannelBindingDialog.vue'
import { useMonitor } from './composables/useMonitor'
import ExtensionsView from './views/ExtensionsView.vue'
import OverviewView from './views/OverviewView.vue'

const { stats, events, extensions, channels, loading, refreshing, error, refresh } = useMonitor()
const activeView = ref('overview')
const selectedExtension = ref('codex')
const saving = ref(false)
const bindingDialogOpen = ref(false)
const bindingChannel = ref('')
const bindingQrUrl = ref('')
const bindingMessage = ref('')
const bindingLabel = computed(() => channels.value.find(item => item.id === bindingChannel.value)?.label || '消息通道')

const run = async (action: () => Promise<unknown>, success: string) => {
  saving.value = true
  try {
    await action()
    ElMessage.success(success)
    await refresh(true)
  } catch (reason) {
    ElMessage.error(reason instanceof Error ? reason.message : '操作失败')
  } finally {
    saving.value = false
  }
}

const testNotification = async (key: string) => {
  saving.value = true
  try {
    const result = await monitorApi.testNotification(key)
    if (!result.channels.length) ElMessage.warning('测试事件已记录，但尚未绑定通知通道')
    else ElMessage.success('测试消息已进入发送队列')
    await refresh(true)
  } catch (reason) {
    ElMessage.error(reason instanceof Error ? reason.message : '测试失败')
  } finally {
    saving.value = false
  }
}

const bindChannel = async (channel: string) => {
  try {
    const result = await monitorApi.startBinding(channel)
    if (result.mode === 'external') {
      ElMessage.warning(result.message)
      return
    }
    bindingChannel.value = channel
    bindingQrUrl.value = result.qrUrl
    bindingMessage.value = result.message
    bindingDialogOpen.value = true
  } catch (reason) {
    ElMessage.error(reason instanceof Error ? reason.message : '无法启动绑定')
  }
}

const bindingCompleted = async () => {
  ElMessage.success(`${bindingLabel.value}已绑定`)
  await refresh(true)
}

const unbindChannel = (channel: string) => run(() => monitorApi.unbind(channel), '通道已解绑')
</script>

<template>
  <div class="app-shell">
    <AppHeader
      :active-view="activeView"
      :event-count="stats.events"
      :refreshing="refreshing"
      @refresh="refresh()"
      @view="activeView = $event"
    />
    <main class="page-shell">
      <el-alert v-if="error" class="page-error" :title="error" type="error" show-icon :closable="false"><el-button link type="danger" @click="refresh()">重试</el-button></el-alert>

      <div v-loading="loading" class="view-container">
        <OverviewView
          v-if="activeView === 'overview'"
          :events="events"
          :extensions="extensions"
          :channels="channels"
          :event-count="stats.events"
        />
        <ExtensionsView
          v-else
          :extensions="extensions"
          :channels="channels"
          :selected-key="selectedExtension"
          :saving="saving"
          @select="selectedExtension = $event"
          @test="testNotification"
          @bind="bindChannel"
          @unbind="unbindChannel"
        />
      </div>
    </main>
    <ChannelBindingDialog
      v-model="bindingDialogOpen"
      :channel="bindingChannel"
      :label="bindingLabel"
      :qr-url="bindingQrUrl"
      :message="bindingMessage"
      @bound="bindingCompleted"
      @failed="ElMessage.error($event)"
    />
  </div>
</template>
