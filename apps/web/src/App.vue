<script setup lang="ts">
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Bell, Monitor } from '@element-plus/icons-vue'
import { monitorApi } from './api/monitor'
import AppHeader from './components/layout/AppHeader.vue'
import ChannelBindingDialog from './components/platforms/ChannelBindingDialog.vue'
import CreatePlatformDialog from './components/platforms/CreatePlatformDialog.vue'
import { useMonitor } from './composables/useMonitor'
import OverviewView from './views/OverviewView.vue'
import PlatformsView from './views/PlatformsView.vue'

const { stats, events, platforms, channels, loading, refreshing, error, updatedAt, refresh } = useMonitor()
const activeView = ref('overview')
const selectedPlatform = ref('codex')
const createDialogOpen = ref(false)
const saving = ref(false)
const bindingDialogOpen = ref(false)
const bindingChannel = ref('')
const bindingQrUrl = ref('')
const bindingMessage = ref('')
const bindingLabel = computed(() => channels.value.find(item => item.id === bindingChannel.value)?.label || '消息通道')

const selectPlatform = (key: string) => {
  selectedPlatform.value = key
  activeView.value = 'platforms'
}

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

const savePlatform = (key: string, payload: { channel: string | null }) =>
  run(() => monitorApi.updatePlatform(key, payload), '平台配置已保存')

const createPlatform = async (payload: { key: string; label: string; aliases: string[] }) => {
  await run(() => monitorApi.createPlatform(payload), '事件来源已注册')
  createDialogOpen.value = false
  selectPlatform(payload.key)
}

const deletePlatform = async (key: string) => {
  try {
    await ElMessageBox.confirm('删除后不会删除历史消息，但该事件来源将不再参与分类和路由。', '删除事件来源', {
      confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning',
    })
    await run(() => monitorApi.deletePlatform(key), '事件来源已删除')
    selectedPlatform.value = platforms.value[0]?.key || ''
  } catch (reason) {
    if (reason !== 'cancel' && reason !== 'close') ElMessage.error(reason instanceof Error ? reason.message : '删除失败')
  }
}

const testNotification = async (key: string) => {
  saving.value = true
  try {
    const result = await monitorApi.testNotification(key)
    if (!result.channels.length) ElMessage.warning('测试事件已记录，但该平台还没有可用通知通道')
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
  try {
    await monitorApi.updatePlatform(selectedPlatform.value, { channel: bindingChannel.value })
    ElMessage.success(`${bindingLabel.value}已绑定并用于当前平台`)
    await refresh(true)
  } catch (reason) {
    ElMessage.error(reason instanceof Error
      ? `通道已绑定，但自动分配失败：${reason.message}`
      : '通道已绑定，但自动分配到当前平台失败')
  }
}

const unbindChannel = (channel: string) => run(() => monitorApi.unbind(channel), '通道已解绑')
</script>

<template>
  <div class="app-shell">
    <AppHeader :refreshing="refreshing" :updated-at="updatedAt" @refresh="refresh()" />
    <main class="page-shell">
      <div class="page-intro">
        <div><span class="overline">NOTIFICATION CENTER</span><h1>AI 任务消息中心</h1><p>汇总完成、失败和接口异常消息，点击消息进入 Phoenix 查看调用详情。</p></div>
      </div>

      <el-alert v-if="error" class="page-error" :title="error" type="error" show-icon :closable="false"><el-button link type="danger" @click="refresh()">重新加载</el-button></el-alert>

      <el-tabs v-model="activeView" class="primary-navigation">
        <el-tab-pane name="overview"><template #label><span><el-icon><Bell /></el-icon>消息概览<el-badge :value="stats.events" :max="999" /></span></template></el-tab-pane>
        <el-tab-pane name="platforms"><template #label><span><el-icon><Monitor /></el-icon>平台配置<el-badge :value="platforms.length" /></span></template></el-tab-pane>
      </el-tabs>

      <div v-loading="loading" class="view-container">
        <OverviewView v-if="activeView === 'overview'" :events="events" :platforms="platforms" />
        <PlatformsView
          v-else
          :platforms="platforms"
          :channels="channels"
          :selected-key="selectedPlatform"
          :saving="saving"
          @select="selectedPlatform = $event"
          @create="createDialogOpen = true"
          @save="savePlatform"
          @test="testNotification"
          @bind="bindChannel"
          @unbind="unbindChannel"
          @delete="deletePlatform"
        />
      </div>
    </main>
    <CreatePlatformDialog v-model="createDialogOpen" @create="createPlatform" />
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
