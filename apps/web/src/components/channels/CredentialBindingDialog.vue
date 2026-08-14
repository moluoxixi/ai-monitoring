<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Link } from '@element-plus/icons-vue'
import { monitorApi } from '../../api/monitor'
import type { ChannelFormField, ChannelFormSchema } from '../../types/monitor'

const props = defineProps<{
  modelValue: boolean
  channel: string
  label: string
  message: string
  helpUrl?: string
  form?: ChannelFormSchema
}>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  bound: []
  failed: [message: string]
}>()

const credential = ref('')
const values = reactive<Record<string, string>>({})
const saving = ref(false)
const title = computed(() => `绑定${props.label}`)
const fields = computed(() => props.form?.fields || [])

const reset = () => {
  credential.value = ''
  for (const key of Object.keys(values)) delete values[key]
  for (const item of fields.value) values[item.key] = item.defaultValue || ''
}

watch(() => props.modelValue, (open) => {
  if (open) reset()
})

const close = (value: boolean) => {
  if (saving.value) return
  emit('update:modelValue', value)
}

const missingField = (): ChannelFormField | undefined => fields.value.find((item) => item.required && !values[item.key]?.trim())

const submit = async () => {
  const missing = missingField()
  if (missing) {
    ElMessage.warning(`请输入${missing.label}`)
    return
  }
  if (!fields.value.length && !credential.value.trim()) {
    ElMessage.warning('请输入 Token')
    return
  }
  saving.value = true
  try {
    const payload = fields.value.length ? { ...values } : credential.value
    const result = await monitorApi.bindCredential(props.channel, payload)
    if (!result.bound) throw new Error(result.message || '绑定失败')
    emit('bound')
    emit('update:modelValue', false)
  } catch (error) {
    const message = error instanceof Error ? error.message : '绑定失败'
    emit('failed', message)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <el-dialog :model-value="modelValue" :title="title" width="min(520px, calc(100vw - 28px))" @update:model-value="close">
    <div class="credential-binding">
      <p v-if="message" class="credential-message">{{ message }}</p>
      <el-form v-if="fields.length" label-position="top" @submit.prevent="submit">
        <el-form-item v-for="item in fields" :key="item.key" :label="item.label" :required="item.required">
          <el-select
            v-if="item.type === 'select'"
            v-model="values[item.key]"
            :placeholder="item.placeholder || `请选择${item.label}`"
          >
            <el-option v-for="option in item.options" :key="option.value" :label="option.label" :value="option.value" />
          </el-select>
          <el-input
            v-else
            v-model="values[item.key]"
            :type="item.type === 'password' ? 'password' : item.type === 'number' ? 'number' : 'text'"
            :show-password="item.type === 'password'"
            :autocomplete="item.type === 'password' ? 'new-password' : 'off'"
            :placeholder="item.placeholder || `请输入${item.label}`"
            clearable
            @keyup.enter="submit"
          />
        </el-form-item>
      </el-form>
      <el-input
        v-else
        v-model="credential"
        type="password"
        show-password
        clearable
        autocomplete="new-password"
        :placeholder="`粘贴${label} Token`"
        @keyup.enter="submit"
      />
      <el-link v-if="helpUrl" :href="helpUrl" target="_blank" :icon="Link" type="primary">打开配置说明</el-link>
    </div>
    <template #footer>
      <el-button @click="close(false)">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submit">绑定</el-button>
    </template>
  </el-dialog>
</template>
