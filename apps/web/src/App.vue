<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { monitorApi } from './api/monitor'
import AppHeader from './components/layout/AppHeader.vue'
import ChannelBindingDialog from './components/channels/ChannelBindingDialog.vue'
import CredentialBindingDialog from './components/channels/CredentialBindingDialog.vue'
import { useMonitor } from './composables/useMonitor'
import { useTheme } from './composables/useTheme'
import type { ChannelFormSchema } from './types/monitor'
import ExtensionsView from './views/ExtensionsView.vue'
import OverviewView from './views/OverviewView.vue'

const { events, extensions, channels, extensionPayload, notificationSettings, loading, refreshing, error, refresh } = useMonitor()
const { theme, toggleTheme } = useTheme()
const activeView = ref('overview')
const selectedExtension = ref('codex-cli')
const saving = ref(false)
const bindingDialogOpen = ref(false)
const bindingChannel = ref('')
const bindingQrUrl = ref('')
const bindingMessage = ref('')
const credentialDialogOpen = ref(false)
const credentialChannel = ref('')
const credentialMessage = ref('')
const credentialHelpUrl = ref('')
const credentialForm = ref<ChannelFormSchema | undefined>()
const bindingLabel = computed(() => channels.value.find(item => item.id === bindingChannel.value)?.label || '消息通道')
const credentialLabel = computed(() => channels.value.find(item => item.id === credentialChannel.value)?.label || '消息通道')

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
    if (result.mode === 'credential') {
      credentialChannel.value = channel
      credentialMessage.value = result.message
      credentialHelpUrl.value = result.helpUrl || ''
      credentialForm.value = result.form
      credentialDialogOpen.value = true
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

const credentialCompleted = async () => {
  ElMessage.success(`${credentialLabel.value}已绑定`)
  await refresh(true)
}

const bindingCompleted = async () => {
  ElMessage.success(`${bindingLabel.value}已绑定`)
  await refresh(true)
}

const unbindChannel = (channel: string) => run(() => monitorApi.unbind(channel), '通道已解绑')
const scanExtensions = () => run(() => monitorApi.scanExtensions(), '平台扫描完成')
const saveExtensionPreferences = (keys: string[]) => run(() => monitorApi.saveExtensionPreferences(keys), '显示平台已保存')
const saveNotificationSettings = (settings: { taskLimit: number; resultLimit: number }) => run(
  () => monitorApi.saveNotificationSettings(settings), '通知长度已保存',
)
</script>

<template>
  <div class="app-shell">
    <AppHeader
      :active-view="activeView"
      :event-count="extensionPayload.visibleEventCount"
      :refreshing="refreshing"
      :theme="theme"
      :device="extensionPayload.device"
      @refresh="refresh()"
      @toggle-theme="toggleTheme"
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
          :event-count="extensionPayload.visibleEventCount"
          :visible-extensions="extensionPayload.visibleExtensions"
        />
        <ExtensionsView
          v-else
          :extensions="extensions"
          :channels="channels"
          :selected-key="selectedExtension"
          :saving="saving"
          :scan-scope="extensionPayload.scanScope"
          :scan-status="extensionPayload.scanStatus"
          :scanned-at="extensionPayload.scannedAt"
          :device="extensionPayload.device"
          :configurable-extensions="extensionPayload.configurableExtensions"
          :visible-extensions="extensionPayload.visibleExtensions"
          :notification-settings="notificationSettings"
          @select="selectedExtension = $event"
          @test="testNotification"
          @bind="bindChannel"
          @unbind="unbindChannel"
          @scan="scanExtensions"
          @save-preferences="saveExtensionPreferences"
          @save-notification-settings="saveNotificationSettings"
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
    <CredentialBindingDialog
      v-model="credentialDialogOpen"
      :channel="credentialChannel"
      :label="credentialLabel"
      :message="credentialMessage"
      :help-url="credentialHelpUrl"
      :form="credentialForm"
      @bound="credentialCompleted"
      @failed="ElMessage.error($event)"
    />
  </div>
</template>
