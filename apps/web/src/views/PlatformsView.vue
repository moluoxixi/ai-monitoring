<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Plus } from '@element-plus/icons-vue'
import type { ChannelStatus, PlatformCard } from '../types/monitor'
import PlatformConfigPanel from '../components/platforms/PlatformConfigPanel.vue'

const props = defineProps<{ platforms: PlatformCard[]; channels: ChannelStatus[]; selectedKey: string; saving: boolean }>()
const emit = defineEmits<{
  select: [key: string]
  create: []
  save: [key: string, payload: { channel: string | null }]
  test: [key: string]
  bind: [channel: string]
  unbind: [channel: string]
  delete: [key: string]
}>()
const active = ref(props.selectedKey || props.platforms[0]?.key || '')
watch(() => props.selectedKey, value => { if (value) active.value = value })
watch(active, value => emit('select', value))
const selected = computed(() => props.platforms.find(item => item.key === active.value) || props.platforms[0])
</script>

<template>
  <div class="platform-toolbar"><div><h2>AI 软件</h2><p>每个软件独立配置一个消息通道，监控详情统一进入 Phoenix</p></div><el-button type="primary" :icon="Plus" @click="$emit('create')">注册事件来源</el-button></div>
  <el-tabs v-model="active" class="platform-tabs">
    <el-tab-pane v-for="platform in platforms" :key="platform.key" :name="platform.key">
      <template #label><span class="platform-tab-label"><i :class="{ ready: platform.channel_status?.bound }" />{{ platform.label }}<small>{{ platform.messages.length }}</small></span></template>
    </el-tab-pane>
  </el-tabs>
  <PlatformConfigPanel
    v-if="selected"
    :platform="selected"
    :channels="channels"
    :saving="saving"
    @save="emit('save', selected.key, $event)"
    @test="emit('test', selected.key)"
    @bind="emit('bind', $event)"
    @unbind="emit('unbind', $event)"
    @delete="emit('delete', selected.key)"
  />
</template>
