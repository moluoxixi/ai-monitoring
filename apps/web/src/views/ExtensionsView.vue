<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ChannelStatus, ExtensionCard } from '../types/monitor'
import ExtensionPanel from '../components/extensions/ExtensionPanel.vue'

const props = defineProps<{ extensions: ExtensionCard[]; channels: ChannelStatus[]; selectedKey: string; saving: boolean }>()
const emit = defineEmits<{
  select: [key: string]
  test: [key: string]
  bind: [channel: string]
  unbind: [channel: string]
}>()

const active = ref(props.selectedKey || props.extensions[0]?.key || '')
watch(() => props.selectedKey, value => { if (value) active.value = value })
watch(active, value => emit('select', value))
const selected = computed(() => props.extensions.find(item => item.key === active.value) || props.extensions[0])
</script>

<template>
  <section class="extension-workspace">
    <div class="extension-switcher">
      <el-tabs v-model="active" class="extension-tabs">
        <el-tab-pane v-for="extension in extensions" :key="extension.key" :name="extension.key">
          <template #label>
            <span class="extension-tab-label">
              <i :class="{ active: extension.adapter.active }" />
              {{ extension.label }}
              <small>{{ extension.event_count }}</small>
            </span>
          </template>
        </el-tab-pane>
      </el-tabs>
    </div>
    <ExtensionPanel
      v-if="selected"
      :extension="selected"
      :channels="channels"
      :saving="saving"
      @test="emit('test', selected.key)"
      @bind="emit('bind', $event)"
      @unbind="emit('unbind', $event)"
    />
  </section>
</template>
