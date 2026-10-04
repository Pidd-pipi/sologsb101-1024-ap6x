<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router'
import { Refresh, Search } from '@element-plus/icons-vue'

export interface FilterSelectOption {
  label: string
  value: string
  /** 该选项对应的记录数，用于下拉项右侧计数 */
  count?: number
}

export interface FilterSelectConfig {
  /** 组件内唯一标识，同时作为筛选模型的字段名 */
  key: string
  label: string
  options: FilterSelectOption[]
  placeholder?: string
  /** 多选（默认）或单选 */
  multiple?: boolean
  /** URL query 中的键名，缺省时使用 key */
  queryKey?: string
}

export interface FilterModel {
  keyword: string
  [key: string]: string | string[] | boolean
}

const props = withDefaults(
  defineProps<{
    modelValue: FilterModel
    selects?: FilterSelectConfig[]
    keywordPlaceholder?: string
    /** 附加开关文案，如「仅看异常记录」 */
    switchLabel?: string
    switchValue?: boolean
    /** 是否渲染附加开关 */
    hasSwitch?: boolean
    /** 开关对应的筛选模型字段名 */
    switchKey?: string
    /** 开关对应的 URL query 键名 */
    switchQueryKey?: string
    showReset?: boolean
    /** 是否把筛选条件同步到 URL query，默认同步 */
    syncUrl?: boolean
  }>(),
  {
    selects: () => [],
    keywordPlaceholder: '搜索关键字…',
    switchLabel: '',
    switchValue: false,
    hasSwitch: false,
    switchKey: 'only',
    switchQueryKey: 'only',
    showReset: true,
    syncUrl: true
  }
)

const emit = defineEmits<{
  (event: 'update:modelValue', value: FilterModel): void
  (event: 'update:switchValue', value: boolean): void
  (event: 'change', value: FilterModel): void
  (event: 'reset'): void
}>()

const route = useRoute()
const router = useRouter()

/** 关键字对应的 URL query 键名 */
const KEYWORD_QUERY_KEY = 'kw'

function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item))
  if (typeof value === 'string' && value.length > 0) return value.split(',').filter((item) => item.length > 0)
  return []
}

function queryKeyOf(select: FilterSelectConfig): string {
  return select.queryKey ?? select.key
}

/** 依据 props 配置拼出空筛选模型 */
function emptyModel(): FilterModel {
  const model: FilterModel = { keyword: '' }
  props.selects.forEach((select) => {
    model[select.key] = select.multiple === false ? '' : []
  })
  if (props.hasSwitch) model[props.switchKey] = false
  return model
}

const keyword = ref(props.modelValue.keyword ?? '')

/** 把当前筛选条件写入 URL query（空条件从 query 中移除） */
function syncQuery(model: FilterModel, switchOn: boolean): void {
  if (!props.syncUrl) return
  const query: LocationQueryRaw = { ...route.query }
  const kw = String(model.keyword ?? '').trim()
  if (kw) query[KEYWORD_QUERY_KEY] = kw
  else delete query[KEYWORD_QUERY_KEY]

  props.selects.forEach((select) => {
    const key = queryKeyOf(select)
    const value = model[select.key]
    if (Array.isArray(value) && value.length > 0) query[key] = value.join(',')
    else if (typeof value === 'string' && value.length > 0) query[key] = value
    else delete query[key]
  })

  if (props.hasSwitch) {
    if (switchOn) query[props.switchQueryKey] = '1'
    else delete query[props.switchQueryKey]
  }

  const current = JSON.stringify(route.query)
  const next = JSON.stringify(query)
  if (current === next) return
  void router.replace({ query })
}

/** 从 URL query 还原筛选条件（深链进入时用） */
function readQuery(): FilterModel {
  const model = emptyModel()
  if (!props.syncUrl) return model
  const query = route.query
  model.keyword = typeof query[KEYWORD_QUERY_KEY] === 'string' ? String(query[KEYWORD_QUERY_KEY]) : ''
  props.selects.forEach((select) => {
    const raw = query[queryKeyOf(select)]
    if (select.multiple === false) {
      model[select.key] = typeof raw === 'string' ? raw : ''
    } else {
      const allowed = new Set(select.options.map((option) => option.value))
      const values = toArray(raw).filter((item) => allowed.size === 0 || allowed.has(item))
      model[select.key] = values
    }
  })
  if (props.hasSwitch) {
    model[props.switchKey] = query[props.switchQueryKey] === '1'
  }
  return model
}

const restored = readQuery()
keyword.value = restored.keyword
if (
  props.syncUrl &&
  (restored.keyword !== (props.modelValue.keyword ?? '') ||
    props.selects.some((select) => {
      const next = restored[select.key]
      const current = props.modelValue[select.key]
      return JSON.stringify(next) !== JSON.stringify(current)
    }))
) {
  emit('update:modelValue', restored)
  emit('change', restored)
}

watch(
  () => props.modelValue,
  (value) => {
    keyword.value = value.keyword ?? ''
  },
  { deep: true }
)

watch(
  () => route.query,
  () => {
    if (!props.syncUrl) return
    const next = readQuery()
    keyword.value = next.keyword
    emit('update:modelValue', next)
    emit('change', next)
  }
)

const activeCount = computed(() => {
  const entries = Object.entries(props.modelValue).filter(([key]) => key !== 'keyword')
  return entries.reduce((sum, [, value]) => {
    if (Array.isArray(value)) return sum + value.length
    if (typeof value === 'string' && value.length > 0) return sum + 1
    if (typeof value === 'boolean' && value) return sum + 1
    return sum
  }, 0)
})

function emitChange(next: FilterModel): void {
  emit('update:modelValue', next)
  emit('change', next)
  syncQuery(next, Boolean(props.switchValue))
}

function handleKeywordInput(value: string): void {
  keyword.value = value
  emitChange({ ...props.modelValue, keyword: value })
}

function handleSelect(key: string, value: string | string[]): void {
  emitChange({ ...props.modelValue, [key]: value })
}

function handleSwitch(value: boolean): void {
  emit('update:switchValue', value)
  emitChange({ ...props.modelValue, [props.switchKey]: value })
}

function handleReset(): void {
  const cleared = emptyModel()
  keyword.value = ''
  emit('update:switchValue', false)
  emitChange(cleared)
  emit('reset')
}

function valueOf(key: string): string | string[] {
  const value = props.modelValue[key]
  if (Array.isArray(value)) return value
  return typeof value === 'string' ? value : ''
}
</script>

<template>
  <div class="filter-bar">
    <div class="filter-bar__main">
      <el-input
        :model-value="keyword"
        class="filter-bar__keyword"
        :placeholder="keywordPlaceholder"
        clearable
        @update:model-value="handleKeywordInput"
      >
        <template #prefix>
          <el-icon><Search /></el-icon>
        </template>
      </el-input>

      <div v-for="select in selects" :key="select.key" class="filter-bar__select">
        <span class="filter-bar__label">{{ select.label }}</span>
        <el-select
          :model-value="valueOf(select.key)"
          :multiple="select.multiple !== false"
          :collapse-tags="select.multiple !== false"
          collapse-tags-tooltip
          clearable
          :placeholder="select.placeholder ?? `选择${select.label}`"
          class="filter-bar__control"
          @update:model-value="(value: string | string[]) => handleSelect(select.key, value)"
        >
          <el-option
            v-for="option in select.options"
            :key="option.value"
            :label="option.count === undefined ? option.label : `${option.label}（${option.count}）`"
            :value="option.value"
          />
        </el-select>
      </div>

      <div v-if="hasSwitch" class="filter-bar__switch">
        <el-switch
          :model-value="switchValue"
          :active-text="switchLabel"
          @update:model-value="handleSwitch"
        />
      </div>

      <slot name="extra" />
    </div>

    <div class="filter-bar__side">
      <slot name="actions" />
      <el-tag v-if="activeCount > 0" type="warning" effect="plain" round>
        {{ activeCount }} 项条件
      </el-tag>
      <el-button v-if="showReset" :icon="Refresh" text type="primary" @click="handleReset">
        重置
      </el-button>
    </div>
  </div>
</template>

<style scoped>
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  background: #ffffff;
  border: 1px solid #e6e0d6;
  border-radius: 10px;
  margin-bottom: 16px;
}

.filter-bar__main {
  display: flex;
  flex: 1 1 520px;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}

.filter-bar__side {
  display: flex;
  align-items: center;
  gap: 8px;
}

.filter-bar__keyword {
  width: 220px;
}

.filter-bar__label {
  margin-right: 6px;
  font-size: 13px;
  color: #6b6257;
}

.filter-bar__select {
  display: flex;
  align-items: center;
}

.filter-bar__control {
  width: 180px;
}
</style>
