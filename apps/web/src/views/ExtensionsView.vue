<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Refresh, Setting } from '@element-plus/icons-vue'
import type { ChannelStatus, DeviceInfo, ExtensionCard, NotificationSettings } from '../types/monitor'
import ExtensionPanel from '../components/extensions/ExtensionPanel.vue'
import { filterExtensionsByKeys, getDisplayedExtensions, reconcileVisibleKeys } from '../utils/extension-selection'

const props = defineProps<{
  extensions: ExtensionCard[]
  channels: ChannelStatus[]
  selectedKey: string
  saving: boolean
  scanScope: string
  scanStatus: string
  scannedAt: string | null
  device: DeviceInfo
  configurableExtensions: string[]
  visibleExtensions: string[]
  notificationSettings: NotificationSettings
}>()
const emit = defineEmits<{
  select: [key: string]
  test: [key: string]
  bind: [channel: string]
  unbind: [channel: string]
  scan: []
  savePreferences: [keys: string[]]
  saveNotificationSettings: [settings: NotificationSettings]
}>()

const mode = ref<'detected' | 'all'>('detected')
const active = ref(props.selectedKey || '')
const preferenceDraft = ref<string[]>([])
const taskLimitDraft = ref(100)
const resultLimitDraft = ref(2000)
const settingsOpen = ref(false)

const allowedExtensions = computed(() => {
  return filterExtensionsByKeys(props.extensions, props.visibleExtensions)
})
const displayedExtensions = computed(() => getDisplayedExtensions(
  props.extensions, props.visibleExtensions, mode.value, props.scanStatus,
))
const configurableExtensions = computed(() => filterExtensionsByKeys(props.extensions, props.configurableExtensions))
const detectedCount = computed(() => allowedExtensions.value.filter(extension => extension.detected).length)
const selected = computed(() => displayedExtensions.value.find(item => item.key === active.value) || displayedExtensions.value[0])
const scanTime = computed(() => props.scannedAt
  ? new Date(props.scannedAt).toLocaleString('zh-CN', { hour12: false })
  : '尚未扫描')
const scanSummary = computed(() => props.scanStatus === 'unavailable'
  ? '无法扫描宿主机，已显示全部支持平台'
  : props.scanStatus === 'degraded'
    ? `扫描部分可用 · ${scanTime.value}`
    : `最近扫描 · ${scanTime.value}`)

watch(() => props.selectedKey, value => { if (value) active.value = value })
watch(active, value => emit('select', value))
watch(displayedExtensions, extensions => {
  if (!extensions.some(extension => extension.key === active.value)) {
    active.value = extensions[0]?.key || ''
  }
}, { immediate: true })
watch([() => props.visibleExtensions, () => props.configurableExtensions], ([visible, configurable]) => {
  if (!settingsOpen.value) preferenceDraft.value = reconcileVisibleKeys(visible, configurable)
}, { immediate: true })
watch(() => props.notificationSettings, value => {
  if (settingsOpen.value) return
  taskLimitDraft.value = value.taskLimit
  resultLimitDraft.value = value.resultLimit
}, { immediate: true, deep: true })

const savePreferences = () => emit('savePreferences', [...preferenceDraft.value])
const saveLimits = () => emit('saveNotificationSettings', {
  taskLimit: taskLimitDraft.value,
  resultLimit: resultLimitDraft.value,
})
</script>

<template>
  <section class="extension-workspace">
    <div class="extension-toolbar">
      <el-radio-group v-model="mode" size="small" aria-label="平台显示范围">
        <el-radio-button value="detected">已检测 {{ detectedCount }}</el-radio-button>
        <el-radio-button value="all">已展示 {{ allowedExtensions.length }}</el-radio-button>
      </el-radio-group>
      <span class="scan-meta"><span class="device-pill">{{ device.label }}<i v-if="device.container"> · 容器</i></span> {{ scanSummary }}</span>
      <div class="extension-toolbar-actions">
        <el-tooltip content="重新扫描" placement="bottom">
          <el-button :icon="Refresh" circle :loading="saving" aria-label="重新扫描" @click="emit('scan')" />
        </el-tooltip>
        <el-popover
          v-model:visible="settingsOpen"
          placement="bottom-end"
          :width="360"
          trigger="click"
          popper-class="extension-settings-popover"
        >
          <template #reference>
            <el-button :icon="Setting" circle aria-label="扩展设置" />
          </template>
          <div class="extension-settings">
            <div class="setting-block">
              <strong>显示平台</strong>
              <el-checkbox-group v-model="preferenceDraft" class="platform-options">
                <el-checkbox v-for="extension in configurableExtensions" :key="extension.key" :value="extension.key">
                  {{ extension.label }}
                </el-checkbox>
              </el-checkbox-group>
              <el-empty v-if="!configurableExtensions.length" :image-size="54" description="未检测到可配置平台" />
              <el-button type="primary" size="small" :loading="saving" @click="savePreferences">保存平台</el-button>
            </div>
            <div class="setting-block">
              <strong>通知长度</strong>
              <label class="limit-field">
                <span>提问</span>
                <el-input-number v-model="taskLimitDraft" :min="1" :max="2000" :step="50" controls-position="right" />
              </label>
              <label class="limit-field">
                <span>结果 / 失败消息</span>
                <el-input-number v-model="resultLimitDraft" :min="1" :max="24000" :step="500" controls-position="right" />
              </label>
              <el-button type="primary" size="small" :loading="saving" @click="saveLimits">保存长度</el-button>
            </div>
          </div>
        </el-popover>
      </div>
    </div>

    <div v-if="displayedExtensions.length" class="extension-switcher">
      <el-tabs v-model="active" class="extension-tabs">
        <el-tab-pane v-for="extension in displayedExtensions" :key="extension.key" :name="extension.key">
          <template #label>
            <span class="extension-tab-label">
              <i :class="{
                verified: extension.monitorVerified,
                configured: !extension.monitorVerified && extension.monitorConfigured,
                detected: !extension.monitorConfigured && extension.detected,
              }" />
              {{ extension.label }}
              <small>{{ extension.event_count }}</small>
            </span>
          </template>
        </el-tab-pane>
      </el-tabs>
    </div>
    <el-empty
      v-else
      class="extension-empty"
      :description="allowedExtensions.length ? '没有选择要展示的平台' : '未检测到可展示的平台'"
    />
    <ExtensionPanel
      v-if="selected"
      :extension="selected"
      :channels="channels"
      :saving="saving"
      :scan-scope="scanScope"
      @test="emit('test', selected.key)"
      @bind="emit('bind', $event)"
      @unbind="emit('unbind', $event)"
    />
  </section>
</template>
