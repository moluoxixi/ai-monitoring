<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { Connection, Delete, Link, Message, Notification } from '@element-plus/icons-vue'
import type { ChannelStatus, PlatformCard } from '../../types/monitor'
import { deliveryLabel, formatTime, statusTone } from '../../utils/presentation'

const props = defineProps<{ platform: PlatformCard; channels: ChannelStatus[]; saving: boolean }>()
const emit = defineEmits<{
  save: [payload: { channel: string | null }]
  test: []
  bind: [channel: string]
  unbind: [channel: string]
  delete: []
}>()
const form = reactive({ channel: props.platform.channel || '' })
watch(() => props.platform, platform => Object.assign(form, { channel: platform.channel || '' }), { deep: true })
const selectedStatus = computed(() => props.channels.find(item => item.id === form.channel))
const bindableChannels = computed(() => props.channels.filter(item => item.bindingMode !== 'none'))
const capabilities = computed(() => [
  ['任务完成', props.platform.integration.capabilities.completed],
  ['任务失败', props.platform.integration.capabilities.failed],
  ['任务中断', props.platform.integration.capabilities.interrupted],
  ['工具错误', props.platform.integration.capabilities.toolFailed],
  ['Trace', props.platform.integration.capabilities.tracing],
])
</script>

<template>
  <section class="config-surface">
    <header class="config-header">
      <div>
        <span class="overline">{{ platform.custom ? '自定义事件来源' : '内置适配器' }}</span>
        <h2>{{ platform.label }}</h2>
        <p>事件别名：{{ platform.aliases.join('、') }}</p>
      </div>
      <el-tag :type="platform.integration.state === 'ready' ? 'success' : 'warning'" effect="light">
        {{ platform.integration.state === 'ready' ? '适配器已就绪' : '需要适配器' }}
      </el-tag>
    </header>

    <div class="config-section integration-section">
      <div class="subheading"><el-icon><Connection /></el-icon><div><h3>软件接入</h3><p>{{ platform.integration.description }}</p></div></div>
      <div class="capability-list">
        <el-tag v-for="item in capabilities" :key="String(item[0])" :type="item[1] ? 'success' : 'info'" effect="plain">
          {{ item[0] }}{{ item[1] ? '' : ' · 未覆盖' }}
        </el-tag>
      </div>
      <div v-if="platform.custom" class="webhook-contract">
        <code>POST /api/events</code>
        <span>事件中的 <code>client</code> 使用 <code>{{ platform.key }}</code> 或上方任一别名。</span>
      </div>
    </div>

    <div class="config-section">
      <div class="subheading"><el-icon><Notification /></el-icon><div><h3>消息通道</h3><p>每个 AI 软件当前只能选择一个已绑定通道</p></div></div>
      <el-form label-position="top" class="config-form single-field-form">
        <el-form-item label="发送到">
          <el-select v-model="form.channel" clearable placeholder="不发送通知">
            <el-option v-for="channel in channels.filter(item => item.bound)" :key="channel.id" :label="channel.label" :value="channel.id">
              <span>{{ channel.label }}</span><el-tag v-if="channel.error" type="danger" size="small">异常</el-tag>
            </el-option>
          </el-select>
        </el-form-item>
      </el-form>
      <el-alert v-if="form.channel && selectedStatus?.error" title="该通道当前连接异常，消息仍会进入重试队列" type="error" :closable="false" show-icon />
      <div v-if="bindableChannels.length" class="channel-bindings">
        <div v-for="channel in bindableChannels" :key="channel.id" class="binding-row">
          <span><el-icon><Message /></el-icon><span><strong>{{ channel.label }}</strong><small>{{ channel.bound ? '已绑定' : (channel.message || (channel.bindingMode === 'qr' ? '扫描二维码完成绑定' : '需要在 OpenClaw 中登录')) }}</small></span></span>
          <el-button v-if="channel.bound" size="small" @click="emit('unbind', channel.id)">解绑</el-button>
          <el-button v-else size="small" type="primary" plain @click="emit('bind', channel.id)">绑定</el-button>
        </div>
      </div>
      <div class="form-actions">
        <el-button v-if="platform.custom" :icon="Delete" type="danger" plain @click="emit('delete')">删除来源</el-button>
        <span />
        <el-button :icon="Message" :disabled="!form.channel" @click="emit('test')">发送测试</el-button>
        <el-button type="primary" :loading="saving" @click="emit('save', { channel: form.channel || null })">保存配置</el-button>
      </div>
    </div>

    <div class="config-section recent-section">
      <div class="subheading"><el-icon><Message /></el-icon><div><h3>最近消息</h3><p>该软件最近 5 条任务和投递结果，点击进入 Phoenix</p></div></div>
      <div v-if="platform.messages.length" class="recent-list">
        <a v-for="message in platform.messages" :key="message.id" :href="platform.detail_url" target="_blank" rel="noopener noreferrer">
          <i :class="statusTone(message.status)" /><strong>{{ message.title }}</strong><span>{{ deliveryLabel(message.delivery_state) }}</span><time>{{ formatTime(message.created_at) }}</time><el-icon><Link /></el-icon>
        </a>
      </div>
      <el-empty v-else description="暂无消息" :image-size="52" />
    </div>
  </section>
</template>
