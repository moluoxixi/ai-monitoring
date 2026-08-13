<script setup lang="ts">
import { Connection, Refresh } from '@element-plus/icons-vue'

defineProps<{ refreshing: boolean; updatedAt: Date | null }>()
defineEmits<{ refresh: [] }>()
</script>

<template>
  <header class="app-header">
    <div class="brand">
      <span class="brand-mark"><el-icon><Connection /></el-icon></span>
      <span><strong>AI Monitor</strong><small>本地任务通知中心</small></span>
    </div>
    <div class="header-state">
      <span class="online-dot" />
      <span class="header-state-copy">本地服务运行中</span>
      <span v-if="updatedAt" class="updated-at">{{ updatedAt.toLocaleTimeString('zh-CN', { hour12: false }) }} 更新</span>
      <el-tooltip content="刷新数据" placement="bottom">
        <el-button class="icon-action" :icon="Refresh" circle :loading="refreshing" @click="$emit('refresh')" />
      </el-tooltip>
    </div>
  </header>
</template>
