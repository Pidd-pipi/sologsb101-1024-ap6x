<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import {
  Check,
  Close,
  Delete,
  Edit,
  MagicStick,
  Plus,
  Rank,
  RefreshLeft
} from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar, {
  type FilterModel,
  type FilterSelectConfig
} from '@/components/common/FilterBar.vue'
import GradeTag from '@/components/common/GradeTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useMilkStore } from '@/stores/milkStore'
import { useShelfStore } from '@/stores/shelfStore'
import { useTurningStore, type TurningRow } from '@/stores/turningStore'
import {
  TURNING_STATES,
  TURNING_TYPES,
  createEmptyTurningFilter,
  type TurningState,
  type TurningType
} from '@/types/turning'
import type { TastingConclusion } from '@/types/tasting'
import { addDays, toDateString } from '@/utils/temperature'

const turningStore = useTurningStore()
const milkStore = useMilkStore()
const shelfStore = useShelfStore()

const { filteredRows, groupedRows, ready, filter, summary, todayRows, overdueRows, sortMode } =
  storeToRefs(turningStore)
const { batches } = storeToRefs(milkStore)
const { shelves } = storeToRefs(shelfStore)

const turningFormRef = ref<FormInstance>()
const planFormRef = ref<FormInstance>()
const turningDialogVisible = ref(false)
const planDialogVisible = ref(false)
const editingTurningId = ref<string | null>(null)
const dragOverId = ref<string | null>(null)
const draggingId = ref<string | null>(null)

const turningForm = reactive({
  batchId: '',
  shelfId: '',
  doneAt: toDateString(new Date()),
  type: '转架' as TurningType,
  brinePct: 18,
  operator: '',
  state: '待执行' as TurningState
})

const planForm = reactive({
  batchId: '',
  shelfId: '',
  startAt: toDateString(new Date()),
  times: 4,
  intervalDays: 14,
  type: '转架' as TurningType,
  brinePct: 18,
  operator: ''
})

const turningRules: FormRules = {
  batchId: [{ required: true, message: '请选择批次', trigger: 'change' }],
  shelfId: [{ required: true, message: '请选择作业窖位', trigger: 'change' }],
  doneAt: [{ required: true, message: '请选择作业日期', trigger: 'change' }],
  type: [{ required: true, message: '请选择作业类型', trigger: 'change' }],
  operator: [{ required: true, message: '请填写操作人', trigger: 'blur' }]
}

const planRules: FormRules = {
  batchId: [{ required: true, message: '请选择批次', trigger: 'change' }],
  shelfId: [{ required: true, message: '请选择作业窖位', trigger: 'change' }],
  startAt: [{ required: true, message: '请选择首次作业日期', trigger: 'change' }],
  times: [{ required: true, message: '请填写作业次数', trigger: 'blur' }],
  intervalDays: [{ required: true, message: '请填写间隔天数', trigger: 'blur' }],
  operator: [{ required: true, message: '请填写操作人', trigger: 'blur' }]
}

const turningFilterModel = computed<FilterModel>(() => ({
  keyword: filter.value.keyword,
  types: [...filter.value.types],
  states: [...filter.value.states]
}))

const turningSelects = computed<FilterSelectConfig[]>(() => [
  {
    key: 'types',
    label: '作业类型',
    queryKey: 'tt',
    options: TURNING_TYPES.map((type) => ({
      label: type,
      value: type,
      count: turningStore.turnings.filter((turning) => turning.type === type).length
    }))
  },
  {
    key: 'states',
    label: '作业状态',
    queryKey: 'st',
    options: TURNING_STATES.map((state) => ({
      label: state,
      value: state,
      count: turningStore.turnings.filter((turning) => turning.state === state).length
    }))
  }
])

const batchOptions = computed(() =>
  batches.value.map((batch) => ({
    label: `${milkStore.milkNameOf(batch.milkId)} · ${batch.cheeseType} ${batch.curdedAt}`,
    value: batch.id
  }))
)

const shelfOptions = computed(() =>
  shelves.value.map((shelf) => ({
    label: `${shelfStore.shelfLabel(shelf.id)}（余 ${shelfStore.occupancyMap[shelf.id]?.free ?? 0} 块）`,
    value: shelf.id
  }))
)

/** 等间隔计划预览：首次日期 + 间隔天数 × 次数 */
const planPreview = computed(() => {
  const times = Math.max(1, Math.min(8, Math.round(planForm.times)))
  const interval = Math.max(1, Math.round(planForm.intervalDays))
  return Array.from({ length: times }, (_, index) => addDays(planForm.startAt, index * interval))
})

function applyFilter(model: FilterModel): void {
  turningStore.patchFilter({
    keyword: model.keyword,
    types: (model.types as TurningType[]) ?? [],
    states: (model.states as TurningState[]) ?? []
  })
}

function resetFilter(): void {
  turningStore.filter = createEmptyTurningFilter()
}

function resetTurningForm(): void {
  const firstBatch = batches.value[0]
  turningForm.batchId = firstBatch?.id ?? ''
  turningForm.shelfId = firstBatch?.shelfId ?? shelves.value[0]?.id ?? ''
  turningForm.doneAt = toDateString(new Date())
  turningForm.type = '转架'
  turningForm.brinePct = 18
  turningForm.operator = ''
  turningForm.state = '待执行'
}

function openTurningDialog(row?: TurningRow): void {
  if (row) {
    editingTurningId.value = row.turning.id
    turningForm.batchId = row.turning.batchId
    turningForm.shelfId = row.turning.shelfId
    turningForm.doneAt = row.turning.doneAt
    turningForm.type = row.turning.type
    turningForm.brinePct = row.turning.brinePct
    turningForm.operator = row.turning.operator
    turningForm.state = row.turning.state
  } else {
    editingTurningId.value = null
    resetTurningForm()
  }
  turningDialogVisible.value = true
}

async function submitTurning(): Promise<void> {
  if (!turningFormRef.value) return
  const valid = await turningFormRef.value.validate().catch(() => false)
  if (!valid) return
  if (editingTurningId.value) {
    await turningStore.updateTurning(editingTurningId.value, { ...turningForm })
    ElMessage.success('转架作业已更新')
  } else {
    await turningStore.createTurning({ ...turningForm })
    ElMessage.success('转架作业已新建')
  }
  turningDialogVisible.value = false
}

function resetPlanForm(): void {
  const firstBatch = batches.value[0]
  planForm.batchId = firstBatch?.id ?? ''
  planForm.shelfId = firstBatch?.shelfId ?? shelves.value[0]?.id ?? ''
  planForm.startAt = toDateString(new Date())
  planForm.times = 4
  planForm.intervalDays = 14
  planForm.type = '转架'
  planForm.brinePct = 18
  planForm.operator = ''
}

function openPlanDialog(): void {
  resetPlanForm()
  planDialogVisible.value = true
}

async function submitPlan(): Promise<void> {
  if (!planFormRef.value) return
  const valid = await planFormRef.value.validate().catch(() => false)
  if (!valid) return
  const created = await turningStore.generatePlan({ ...planForm })
  ElMessage.success(`已按等间隔生成 ${created} 条作业计划`)
  planDialogVisible.value = false
}

async function removeTurning(row: TurningRow): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除「${row.batchLabel} · ${row.turning.type} ${row.turning.doneAt}」这条作业记录？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await turningStore.removeTurning(row.turning.id)
  ElMessage.success('作业记录已删除，剩余计划序号已重排')
}

async function sign(row: TurningRow, state: TurningState): Promise<void> {
  const changed = await turningStore.setState(row.turning.id, state)
  if (!changed) return
  if (state === '已完成') {
    ElMessage.success(`已签署：${row.turning.type} ${row.turning.doneAt} → 已完成`)
  } else if (state === '已跳过') {
    ElMessage.warning(`已跳过：${row.turning.type} ${row.turning.doneAt}`)
  } else {
    ElMessage.info('已退回为待执行')
  }
}

/** HTML5 原生拖拽：同批次内调整作业顺序，drop 后把新顺序写回 Dexie 的 seq 字段 */
function handleDragStart(row: TurningRow, event: DragEvent): void {
  draggingId.value = row.turning.id
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', row.turning.id)
  }
}

function handleDragOver(row: TurningRow, event: DragEvent): void {
  const sourceId = draggingId.value
  if (!sourceId || sourceId === row.turning.id) return
  const source = turningStore.turnings.find((turning) => turning.id === sourceId)
  if (!source || source.batchId !== row.turning.batchId) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  dragOverId.value = row.turning.id
}

function handleDragLeave(row: TurningRow): void {
  if (dragOverId.value === row.turning.id) dragOverId.value = null
}

async function handleDrop(row: TurningRow): Promise<void> {
  const sourceId = draggingId.value
  dragOverId.value = null
  draggingId.value = null
  if (!sourceId || sourceId === row.turning.id) return
  const source = turningStore.turnings.find((turning) => turning.id === sourceId)
  if (!source || source.batchId !== row.turning.batchId) {
    ElMessage.warning('仅支持在同一批次内调整作业顺序')
    return
  }
  const ids = turningStore.turnings
    .filter((turning) => turning.batchId === row.turning.batchId)
    .sort((a, b) => a.seq - b.seq)
    .map((turning) => turning.id)
  const fromIndex = ids.indexOf(sourceId)
  const toIndex = ids.indexOf(row.turning.id)
  if (fromIndex < 0 || toIndex < 0) return
  const [moved] = ids.splice(fromIndex, 1)
  ids.splice(toIndex, 0, moved)
  await turningStore.reorder(row.turning.batchId, ids)
  ElMessage.success('作业顺序已写入本地数据库')
}

function handleDragEnd(): void {
  draggingId.value = null
  dragOverId.value = null
}

async function rescheduleOverdue(): Promise<void> {
  const ids = overdueRows.value.map((row) => row.turning.id)
  if (ids.length === 0) {
    ElMessage.info('没有逾期的待执行作业')
    return
  }
  const changed = await turningStore.reschedule(ids, toDateString(new Date()))
  ElMessage.success(`已将 ${changed} 条逾期作业改期到今天`)
}

function conclusionOf(row: TurningRow): TastingConclusion | '' {
  const conclusion = row.batch?.conclusion ?? ''
  return conclusion === '优' || conclusion === '合格' || conclusion === '待改进' ? conclusion : ''
}

function changeSort(value: string | number | boolean | undefined): void {
  const mode = value === 'date' ? 'date' : 'manual'
  turningStore.setSortMode(mode)
  ElMessage.success(mode === 'manual' ? '已切换为按计划顺序排列' : '已切换为按作业日期排列')
}
</script>

<template>
  <section>
    <div class="page-title">
      <div>
        <h2>转架 / 翻面 / 擦洗作业计划</h2>
        <p>按批次生成等间隔作业计划并逐条签署；拖拽可调整同一批次内的作业顺序。</p>
      </div>
      <div>
        <el-button type="primary" :icon="Plus" @click="openTurningDialog()">新建作业</el-button>
        <el-button type="success" :icon="MagicStick" @click="openPlanDialog()">生成等间隔计划</el-button>
        <el-button :icon="RefreshLeft" @click="rescheduleOverdue">逾期改期</el-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="计划条数" :value="summary.total" suffix="条" icon="Tickets" />
      <StatBadge label="待执行" :value="summary.pending" suffix="条" icon="AlarmClock" tone="warning" />
      <StatBadge label="已完成" :value="summary.done" suffix="条" icon="CircleCheckFilled" tone="success" />
      <StatBadge label="已跳过" :value="summary.skipped" suffix="条" icon="InfoFilled" />
      <StatBadge
        label="完成率"
        :value="summary.donePercent"
        suffix="%"
        icon="TrendCharts"
        :percent="summary.donePercent"
        show-percent
        tone="primary"
      />
      <StatBadge
        label="平均盐水浓度"
        :value="summary.avgBrinePct"
        suffix="%"
        icon="Pouring"
        tone="info"
      />
    </div>

    <FilterBar
      :model-value="turningFilterModel"
      :selects="turningSelects"
      keyword-placeholder="搜索操作人 / 批次 / 窖位"
      @update:model-value="applyFilter"
      @reset="resetFilter"
    >
      <template #extra>
        <span class="filter-label">排序</span>
        <el-radio-group :model-value="sortMode" @update:model-value="changeSort">
          <el-radio-button value="manual">计划顺序（可拖拽）</el-radio-button>
          <el-radio-button value="date">作业日期</el-radio-button>
        </el-radio-group>
      </template>
    </FilterBar>

    <el-alert v-if="overdueRows.length > 0" type="warning" :closable="false" show-icon class="alert-gap">
      有 {{ overdueRows.length }} 条待执行作业已逾期，可点击「逾期改期」批量顺延到今天。
    </el-alert>
    <el-alert
      v-else-if="todayRows.length > 0"
      type="success"
      :closable="false"
      show-icon
      class="alert-gap"
    >
      今日需要执行 {{ todayRows.length }} 条作业，请在列表中逐条签署。
    </el-alert>

    <div class="section-card">
      <div class="section-card__head">
        <h3>作业计划（{{ filteredRows.length }} / {{ turningStore.turnings.length }}）</h3>
        <span class="muted">拖拽行首手柄调整同批次内顺序，结果写入 IndexedDB 的 seq 字段</span>
      </div>

      <EmptyPanel
        v-if="ready && filteredRows.length === 0"
        title="还没有作业计划"
        description="选择批次、首次作业日期、次数与间隔天数，一键生成等间隔的转架 / 翻面 / 擦洗计划。"
        action-text="新建单条作业"
        secondary-text="生成等间隔计划"
        @action="openTurningDialog()"
        @secondary="openPlanDialog()"
      />

      <div v-else class="turn-groups">
        <div v-for="group in groupedRows" :key="group.batchId" class="turn-group">
          <div class="turn-group__head">
            <strong>{{ group.label }}</strong>
            <span class="muted">{{ group.rows.length }} 条作业 · 拖拽可调整组内顺序</span>
          </div>

          <ul class="turn-list">
            <li
              v-for="row in group.rows"
              :key="row.turning.id"
              class="turn-item"
              :class="{
                'is-dragging': draggingId === row.turning.id,
                'is-over': dragOverId === row.turning.id
              }"
              draggable="true"
              @dragstart="handleDragStart(row, $event)"
              @dragover="handleDragOver(row, $event)"
              @dragleave="handleDragLeave(row)"
              @drop="handleDrop(row)"
              @dragend="handleDragEnd"
            >
              <span class="turn-item__handle" title="按住拖拽调整顺序">
                <el-icon><Rank /></el-icon>
                <em>{{ row.turning.seq }}</em>
              </span>

              <div class="turn-item__main">
                <div class="turn-item__title">
                  <el-tag
                    :type="
                      row.turning.type === '转架'
                        ? 'primary'
                        : row.turning.type === '翻面'
                          ? 'warning'
                          : 'info'
                    "
                    effect="plain"
                    size="small"
                  >
                    {{ row.turning.type }}
                  </el-tag>
                  <span class="mono">{{ row.turning.doneAt }}</span>
                  <el-tag
                    :type="
                      row.turning.state === '已完成'
                        ? 'success'
                        : row.turning.state === '已跳过'
                          ? 'info'
                          : 'warning'
                    "
                    effect="dark"
                    size="small"
                  >
                    {{ row.turning.state }}
                  </el-tag>
                  <GradeTag
                    v-if="conclusionOf(row)"
                    :conclusion="conclusionOf(row)"
                    size="small"
                    plain
                  />
                </div>
                <div class="turn-item__meta">
                  <span>{{ row.batchLabel }}</span>
                  <span class="muted">{{ row.milkLabel }}</span>
                  <span class="muted">{{ row.shelfLabel }}</span>
                  <span class="mono">盐水 {{ row.turning.brinePct }}%</span>
                  <span class="muted">操作人 {{ row.turning.operator }}</span>
                </div>
              </div>

              <div class="turn-item__actions">
                <el-button
                  v-if="row.turning.state !== '已完成'"
                  text
                  type="success"
                  :icon="Check"
                  @click="sign(row, '已完成')"
                >
                  完成
                </el-button>
                <el-button
                  v-if="row.turning.state !== '已跳过'"
                  text
                  type="info"
                  :icon="Close"
                  @click="sign(row, '已跳过')"
                >
                  跳过
                </el-button>
                <el-button
                  v-if="row.turning.state !== '待执行'"
                  text
                  :icon="RefreshLeft"
                  @click="sign(row, '待执行')"
                >
                  回退
                </el-button>
                <el-button text :icon="Edit" @click="openTurningDialog(row)">编辑</el-button>
                <el-button text type="danger" :icon="Delete" @click="removeTurning(row)">
                  删除
                </el-button>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </div>

    <el-dialog
      v-model="turningDialogVisible"
      :title="editingTurningId ? '编辑转架作业' : '新建转架作业'"
      width="580px"
      destroy-on-close
    >
      <el-form ref="turningFormRef" :model="turningForm" :rules="turningRules" label-width="120px">
        <el-form-item label="批次" prop="batchId">
          <el-select v-model="turningForm.batchId" filterable placeholder="选择批次" style="width: 100%">
            <el-option
              v-for="option in batchOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="作业窖位" prop="shelfId">
          <el-select v-model="turningForm.shelfId" filterable placeholder="选择窖位" style="width: 100%">
            <el-option
              v-for="option in shelfOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="作业日期" prop="doneAt">
          <el-date-picker
            v-model="turningForm.doneAt"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="选择作业日期"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="作业类型" prop="type">
          <el-radio-group v-model="turningForm.type">
            <el-radio-button v-for="type in TURNING_TYPES" :key="type" :value="type">
              {{ type }}
            </el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="盐水浓度 %" prop="brinePct">
          <el-input-number v-model="turningForm.brinePct" :min="0" :max="30" :step="1" />
        </el-form-item>
        <el-form-item label="操作人" prop="operator">
          <el-input v-model="turningForm.operator" placeholder="如：陈默" clearable />
        </el-form-item>
        <el-form-item label="状态" prop="state">
          <el-select v-model="turningForm.state" style="width: 100%">
            <el-option v-for="state in TURNING_STATES" :key="state" :label="state" :value="state" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="turningDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitTurning">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="planDialogVisible" title="生成等间隔作业计划" width="620px" destroy-on-close>
      <el-form ref="planFormRef" :model="planForm" :rules="planRules" label-width="130px">
        <el-form-item label="批次" prop="batchId">
          <el-select v-model="planForm.batchId" filterable placeholder="选择批次" style="width: 100%">
            <el-option
              v-for="option in batchOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="作业窖位" prop="shelfId">
          <el-select v-model="planForm.shelfId" filterable placeholder="选择窖位" style="width: 100%">
            <el-option
              v-for="option in shelfOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="首次作业日期" prop="startAt">
          <el-date-picker
            v-model="planForm.startAt"
            type="date"
            value-format="YYYY-MM-DD"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="作业次数" prop="times">
          <el-input-number v-model="planForm.times" :min="1" :max="24" />
        </el-form-item>
        <el-form-item label="间隔天数" prop="intervalDays">
          <el-input-number v-model="planForm.intervalDays" :min="1" :max="120" />
        </el-form-item>
        <el-form-item label="作业类型" prop="type">
          <el-radio-group v-model="planForm.type">
            <el-radio-button v-for="type in TURNING_TYPES" :key="type" :value="type">
              {{ type }}
            </el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="盐水浓度 %" prop="brinePct">
          <el-input-number v-model="planForm.brinePct" :min="0" :max="30" :step="1" />
        </el-form-item>
        <el-form-item label="操作人" prop="operator">
          <el-input v-model="planForm.operator" placeholder="如：周雨" clearable />
        </el-form-item>
        <el-alert type="success" :closable="false" show-icon>
          计划日期预览：{{ planPreview.join('、') }}
        </el-alert>
      </el-form>
      <template #footer>
        <el-button @click="planDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitPlan">生成计划</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.alert-gap {
  margin-bottom: 16px;
}

.filter-label {
  margin-right: 6px;
  color: #6b6257;
  font-size: 13px;
}

.turn-groups {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.turn-group__head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid #e7dfd0;
}

.turn-list {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.turn-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid #e7dfd0;
  border-left: 4px solid #c47a1c;
  border-radius: 10px;
  background: #fffdf8;
  cursor: grab;
}

.turn-item.is-dragging {
  opacity: 0.45;
}

.turn-item.is-over {
  outline: 2px dashed #c47a1c;
  outline-offset: -2px;
}

.turn-item__handle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 62px;
  color: #8a5a1c;
  font-weight: 600;
  user-select: none;
}

.turn-item__handle em {
  font-style: normal;
}

.turn-item__main {
  flex: 1;
  min-width: 0;
}

.turn-item__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.turn-item__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 12px;
}

.turn-item__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}
</style>
