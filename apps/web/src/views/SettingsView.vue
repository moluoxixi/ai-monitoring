<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ArrowDown, ArrowUp, Delete, EditPen, Link } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { monitorApi } from '../api/monitor'
import type {
  AnswerSummaryProviderId,
  AnswerSummaryProviderStatus,
  AnswerSummaryProviderUpdate,
  AnswerSummaryStatus,
} from '../types/monitor'

const loading = ref(true)
const saving = ref(false)
const status = ref<AnswerSummaryStatus>({ order: [], providers: [] })
const dialogOpen = ref(false)
const editing = ref<AnswerSummaryProviderStatus | null>(null)
const form = reactive<AnswerSummaryProviderUpdate>({ apiKey: '', model: '', baseUrl: '', enabled: true })

const orderedProviders = computed(() => status.value.order
  .map(id => status.value.providers.find(provider => provider.id === id))
  .filter((provider): provider is AnswerSummaryProviderStatus => Boolean(provider)))

const load = async () => {
  loading.value = true
  try {
    status.value = await monitorApi.answerSummary()
  } catch (reason) {
    ElMessage.error(reason instanceof Error ? reason.message : '无法加载回答摘要设置')
  } finally {
    loading.value = false
  }
}

const openEditor = (provider: AnswerSummaryProviderStatus) => {
  editing.value = provider
  form.apiKey = ''
  form.model = provider.model
  form.baseUrl = provider.baseUrl
  form.enabled = provider.configured ? provider.enabled : true
  dialogOpen.value = true
}

const saveProvider = async () => {
  if (!editing.value || !form.model.trim() || (!editing.value.configured && !form.apiKey?.trim())) {
    ElMessage.warning('请填写模型和 API Key')
    return
  }
  if (editing.value.custom && !form.baseUrl?.trim()) {
    ElMessage.warning('请填写 Base URL')
    return
  }
  saving.value = true
  try {
    status.value = await monitorApi.updateAnswerSummaryProvider(editing.value.id, {
      apiKey: form.apiKey?.trim() || undefined,
      model: form.model.trim(),
      baseUrl: editing.value.custom ? form.baseUrl?.trim() : undefined,
      enabled: form.enabled,
    })
    dialogOpen.value = false
    ElMessage.success(`${editing.value.label} 配置已保存`)
  } catch (reason) {
    ElMessage.error(reason instanceof Error ? reason.message : '保存失败')
  } finally {
    saving.value = false
  }
}

const removeProvider = async (provider: AnswerSummaryProviderStatus) => {
  try {
    await ElMessageBox.confirm(`删除 ${provider.label} 的本地配置？`, '删除配置', {
      confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning',
    })
    status.value = await monitorApi.removeAnswerSummaryProvider(provider.id)
    ElMessage.success('配置已删除')
  } catch (reason) {
    if (reason !== 'cancel' && reason !== 'close') {
      ElMessage.error(reason instanceof Error ? reason.message : '删除失败')
    }
  }
}

const move = async (provider: AnswerSummaryProviderId, direction: -1 | 1) => {
  const order = [...status.value.order]
  const index = order.indexOf(provider)
  const target = index + direction
  if (index < 0 || target < 0 || target >= order.length) return
  ;[order[index], order[target]] = [order[target]!, order[index]!]
  try {
    status.value = await monitorApi.updateAnswerSummaryOrder(order)
  } catch (reason) {
    ElMessage.error(reason instanceof Error ? reason.message : '排序失败')
  }
}

const providerState = (provider: AnswerSummaryProviderStatus) => {
  if (!provider.configured) return { label: '未配置', tone: 'muted' }
  if (!provider.enabled) return { label: '已停用', tone: 'muted' }
  if (provider.cooldownUntil) return { label: '今日限流', tone: 'warning' }
  if (provider.lastError) return { label: '调用异常', tone: 'danger' }
  return { label: '已启用', tone: 'success' }
}

onMounted(load)
</script>

<template>
  <section v-loading="loading" class="settings-surface">
    <header class="settings-heading">
      <div>
        <h2>回答摘要</h2>
        <span>{{ orderedProviders.length }} 个在线渠道</span>
      </div>
    </header>

    <el-alert
      v-if="status.configurationError"
      :title="status.configurationError"
      type="error"
      show-icon
      :closable="false"
    />

    <div class="provider-list">
      <article v-for="(provider, index) in orderedProviders" :key="provider.id" class="provider-row">
        <span class="provider-priority">{{ index + 1 }}</span>
        <div class="provider-copy">
          <div class="provider-name">
            <strong>{{ provider.label }}</strong>
            <span :class="providerState(provider).tone">{{ providerState(provider).label }}</span>
          </div>
          <small>{{ provider.configured ? provider.model : (provider.model ? `建议模型：${provider.model}` : '未设置模型') }}</small>
        </div>
        <div class="provider-actions">
          <el-tooltip content="上移" placement="top">
            <el-button :icon="ArrowUp" circle :disabled="index === 0" aria-label="上移" @click="move(provider.id, -1)" />
          </el-tooltip>
          <el-tooltip content="下移" placement="top">
            <el-button :icon="ArrowDown" circle :disabled="index === orderedProviders.length - 1" aria-label="下移" @click="move(provider.id, 1)" />
          </el-tooltip>
          <el-tooltip content="配置" placement="top">
            <el-button :icon="EditPen" circle aria-label="配置" @click="openEditor(provider)" />
          </el-tooltip>
          <el-tooltip v-if="provider.configured" content="删除配置" placement="top">
            <el-button :icon="Delete" circle aria-label="删除配置" @click="removeProvider(provider)" />
          </el-tooltip>
        </div>
      </article>
    </div>
  </section>

  <el-dialog
    v-model="dialogOpen"
    :title="editing ? `配置 ${editing.label}` : '配置渠道'"
    width="min(520px, calc(100vw - 28px))"
    :close-on-click-modal="!saving"
    :close-on-press-escape="!saving"
    :show-close="!saving"
  >
    <el-form v-if="editing" label-position="top" class="summary-provider-form" @submit.prevent="saveProvider">
      <el-form-item label="API Key" required>
        <el-input
          v-model="form.apiKey"
          type="password"
          show-password
          autocomplete="new-password"
          :placeholder="editing.configured ? '留空以保留当前 Key' : '请输入 API Key'"
        />
      </el-form-item>
      <el-form-item label="模型" required>
        <el-input v-model="form.model" autocomplete="off" />
      </el-form-item>
      <el-form-item v-if="editing.custom" label="Base URL" required>
        <el-input v-model="form.baseUrl" autocomplete="url" placeholder="https://api.example.com/v1" />
      </el-form-item>
      <el-form-item v-else label="Base URL">
        <el-input :model-value="editing.baseUrl" disabled />
      </el-form-item>
      <div class="provider-form-footer">
        <el-link v-if="editing.apiKeyUrl" :href="editing.apiKeyUrl" target="_blank" rel="noopener noreferrer" :icon="Link">
          获取 API Key
        </el-link>
        <el-switch v-model="form.enabled" aria-label="启用渠道" inline-prompt active-text="启用" inactive-text="停用" />
      </div>
    </el-form>
    <template #footer>
      <el-button :disabled="saving" @click="dialogOpen = false">取消</el-button>
      <el-button type="primary" :loading="saving" @click="saveProvider">保存</el-button>
    </template>
  </el-dialog>
</template>
