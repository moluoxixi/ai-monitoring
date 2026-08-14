<script setup lang="ts">
import { Bell, Connection, Grid, Moon, Refresh, Sunny } from '@element-plus/icons-vue'
import type { Theme } from '../../composables/useTheme'

defineProps<{ activeView: string; eventCount: number; refreshing: boolean; theme: Theme }>()
defineEmits<{ refresh: []; view: [value: string]; toggleTheme: [] }>()
</script>

<template>
  <header class="app-header">
    <div class="brand">
      <span class="brand-mark"><el-icon><Connection /></el-icon></span>
      <strong>AI Monitor</strong>
    </div>
    <nav class="header-tabs" aria-label="主视图">
      <button :class="{ active: activeView === 'overview' }" type="button" aria-label="消息" @click="$emit('view', 'overview')">
        <el-icon><Bell /></el-icon><span>消息</span><small>{{ eventCount }}</small>
      </button>
      <button :class="{ active: activeView === 'extensions' }" type="button" aria-label="扩展" @click="$emit('view', 'extensions')">
        <el-icon><Grid /></el-icon><span>扩展</span>
      </button>
    </nav>
    <div class="header-actions">
      <el-tooltip :content="theme === 'dark' ? '切换浅色主题' : '切换深色主题'" placement="bottom">
        <el-button
          class="icon-action"
          :icon="theme === 'dark' ? Sunny : Moon"
          circle
          :aria-label="theme === 'dark' ? '切换浅色主题' : '切换深色主题'"
          @click="$emit('toggleTheme')"
        />
      </el-tooltip>
      <el-tooltip content="刷新数据" placement="bottom">
        <el-button class="icon-action" :icon="Refresh" circle :loading="refreshing" aria-label="刷新数据" @click="$emit('refresh')" />
      </el-tooltip>
    </div>
  </header>
</template>
