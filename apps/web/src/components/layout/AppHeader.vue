<script setup lang="ts">
import { Bell, Connection, Grid, Refresh } from '@element-plus/icons-vue'

defineProps<{ activeView: string; eventCount: number; refreshing: boolean }>()
defineEmits<{ refresh: []; view: [value: string] }>()
</script>

<template>
  <header class="app-header">
    <div class="brand">
      <span class="brand-mark"><el-icon><Connection /></el-icon></span>
      <strong>AI Monitor</strong>
    </div>
    <nav class="header-tabs" aria-label="主视图">
      <button :class="{ active: activeView === 'overview' }" type="button" @click="$emit('view', 'overview')">
        <el-icon><Bell /></el-icon><span>消息</span><small>{{ eventCount }}</small>
      </button>
      <button :class="{ active: activeView === 'extensions' }" type="button" @click="$emit('view', 'extensions')">
        <el-icon><Grid /></el-icon><span>扩展</span>
      </button>
    </nav>
    <div class="header-actions">
      <el-tooltip content="刷新数据" placement="bottom">
        <el-button class="icon-action" :icon="Refresh" circle :loading="refreshing" @click="$emit('refresh')" />
      </el-tooltip>
    </div>
  </header>
</template>
