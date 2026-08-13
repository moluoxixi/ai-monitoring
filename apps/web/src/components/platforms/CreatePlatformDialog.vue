<script setup lang="ts">
import { reactive, ref } from 'vue'
import type { FormInstance, FormRules } from 'element-plus'

defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  create: [payload: { key: string; label: string; aliases: string[] }]
}>()
const formRef = ref<FormInstance>()
const form = reactive({ key: '', label: '', aliases: '' })
const rules: FormRules = {
  key: [{ required: true, pattern: /^[a-z0-9][a-z0-9-]{0,39}$/, message: '使用小写字母、数字和连字符', trigger: 'blur' }],
  label: [{ required: true, message: '请输入软件名称', trigger: 'blur' }],
}

const submit = async () => {
  await formRef.value?.validate()
  emit('create', {
    key: form.key.trim(),
    label: form.label.trim(),
    aliases: form.aliases.split(/[,\n]/).map(item => item.trim()).filter(Boolean),
  })
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="注册事件来源"
    width="min(560px, calc(100vw - 28px))"
    @open="Object.assign(form, { key: '', label: '', aliases: '' })"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-alert
      title="注册只会建立消息分类和通用事件入口。原生自动监控仍需要为该 AI 软件安装 hook 或编写适配器。"
      type="info"
      :closable="false"
      show-icon
    />
    <el-form ref="formRef" class="create-platform-form" :model="form" :rules="rules" label-position="top">
      <div class="dialog-grid">
        <el-form-item label="来源标识" prop="key"><el-input v-model="form.key" placeholder="例如 gemini" /></el-form-item>
        <el-form-item label="显示名称" prop="label"><el-input v-model="form.label" placeholder="例如 Gemini" /></el-form-item>
      </div>
      <el-form-item label="事件别名"><el-input v-model="form.aliases" type="textarea" :rows="2" placeholder="例如 gemini-cli, gemini-desktop" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" @click="submit">注册来源</el-button>
    </template>
  </el-dialog>
</template>
