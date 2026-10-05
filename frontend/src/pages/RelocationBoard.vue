<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Delete, Plus, RefreshRight, VideoPlay } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar, {
  type FilterModel,
  type FilterSelectConfig
} from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useMilkStore } from '@/stores/milkStore'
import { useShelfStore } from '@/stores/shelfStore'
import {
  RelocationConflictError,
  useRelocationStore,
  type RelocationPreview
} from '@/stores/relocationStore'
import {
  RELOCATION_STATUSES,
  type Relocation,
  type RelocationMove,
  type RelocationStatus,
  type RelocationStep
} from '@/types/relocation'
import { TURNING_TYPES, type TurningType } from '@/types/turning'
import { toDateString } from '@/utils/temperature'

const relocationStore = useRelocationStore()
const milkStore = useMilkStore()
const shelfStore = useShelfStore()

const { filteredPlans, plans, ready, filter, statusCounts, activePlans } =
  storeToRefs(relocationStore)
const { batches } = storeToRefs(milkStore)
const { shelves, occupancyMap } = storeToRefs(shelfStore)

const formRef = ref<FormInstance>()
const dialogVisible = ref(false)
const submitting = ref(false)
const executingId = ref<string | null>(null)

interface MoveRow {
  key: number
  batchId: string
  toShelfId: string
}

const form = reactive({
  title: '',
  operator: '',
  plannedAt: toDateString(new Date()),
  turningType: '转架' as TurningType,
  brinePct: 18,
  moves: [] as MoveRow[]
})
let moveKeySeed = 0

const rules: FormRules = {
  title: [{ required: true, message: '请填写编排单标题', trigger: 'blur' }],
  operator: [{ required: true, message: '请填写办理人', trigger: 'blur' }],
  plannedAt: [{ required: true, message: '请选择作业日期', trigger: 'change' }]
}

const filterModel = computed<FilterModel>(() => ({
  keyword: filter.value.keyword,
  statuses: [...filter.value.statuses]
}))

const statusSelects = computed<FilterSelectConfig[]>(() => [
  {
    key: 'statuses',
    label: '编排状态',
    queryKey: 'st',
    options: RELOCATION_STATUSES.map((status) => ({
      label: status,
      value: status,
      count: statusCounts.value[status]
    }))
  }
])

/** 可参与调拨的批次：未出库 / 未报废 */
const movableBatches = computed(() =>
  batches.value.filter((batch) => batch.state !== '已出库' && batch.state !== '报废')
)

function batchOptionLabel(batchId: string): string {
  const batch = batches.value.find((item) => item.id === batchId)
  if (!batch) return batchId
  return `${milkStore.milkNameOf(batch.milkId)} · ${batch.cheeseType} ${batch.curdedAt}（${
    batch.state
  }，现：${shelfStore.shelfLabel(batch.shelfId)}）`
}

function shelfOptionLabel(shelfId: string): string {
  const free = occupancyMap.value[shelfId]?.free ?? 0
  return `${shelfStore.shelfLabel(shelfId)} ${
    shelves.value.find((item) => item.id === shelfId)?.tempZone ?? ''
  }（余 ${free} 块）`
}

function applyFilter(model: FilterModel): void {
  relocationStore.patchFilter({
    keyword: model.keyword,
    statuses: (model.statuses as RelocationStatus[]) ?? []
  })
}

function resetFilter(): void {
  relocationStore.resetFilter()
}

function addMoveRow(batchId = '', toShelfId = ''): void {
  moveKeySeed += 1
  form.moves.push({ key: moveKeySeed, batchId, toShelfId })
}

function removeMoveRow(key: number): void {
  const index = form.moves.findIndex((row) => row.key === key)
  if (index >= 0) form.moves.splice(index, 1)
}

function resetForm(): void {
  form.title = ''
  form.operator = ''
  form.plannedAt = toDateString(new Date())
  form.turningType = '转架'
  form.brinePct = 18
  form.moves = []
  moveKeySeed = 0
  const firstBatch = movableBatches.value[0]
  const freeShelf = shelves.value.find((shelf) => (occupancyMap.value[shelf.id]?.free ?? 0) > 0)
  addMoveRow(firstBatch?.id ?? '', freeShelf?.id ?? '')
  addMoveRow()
}

function openDialog(): void {
  resetForm()
  dialogVisible.value = true
}

const validMoves = computed<RelocationMove[]>(() =>
  form.moves
    .filter((row) => row.batchId && row.toShelfId)
    .map((row) => ({ batchId: row.batchId, toShelfId: row.toShelfId }))
)

/** 对话框内实时容量 / 顺序预演：不写库，只给规划结果与冲突提示 */
const preview = computed<RelocationPreview | null>(() => {
  if (validMoves.value.length === 0) return null
  return relocationStore.previewPlan(validMoves.value)
})

const duplicateBatches = computed(() => {
  const seen = new Set<string>()
  const dup = new Set<string>()
  validMoves.value.forEach((move) => {
    if (seen.has(move.batchId)) dup.add(move.batchId)
    seen.add(move.batchId)
  })
  return Array.from(dup)
})

async function submit(): Promise<void> {
  if (!formRef.value) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  if (validMoves.value.length === 0) {
    ElMessage.warning('请至少完整添加一条「批次 → 目标窖位」的调拨意向')
    return
  }
  if (duplicateBatches.value.length > 0) {
    ElMessage.warning(`批次重复指定了目标窖位：${duplicateBatches.value.map(batchOptionLabel).join('、')}`)
    return
  }
  if (preview.value && !preview.value.ok) {
    ElMessage.warning(preview.value.message)
    return
  }
  submitting.value = true
  try {
    const created = await relocationStore.createPlan({
      title: form.title,
      operator: form.operator,
      plannedAt: form.plannedAt,
      turningType: form.turningType,
      brinePct: form.brinePct,
      moves: validMoves.value
    })
    ElMessage.success(`编排单「${created.title}」已确认，共 ${created.steps.length} 步，可开始逐步办理`)
    dialogVisible.value = false
  } catch (err) {
    if (err instanceof RelocationConflictError) {
      // 另一个浏览器窗口先提交 / 容量不足：后提交方收到冲突结果
      await ElMessageBox.alert(err.message, '提交冲突，编排未启动', {
        type: 'error',
        confirmButtonText: '我知道了'
      })
    } else {
      ElMessage.error(err instanceof Error ? err.message : '创建编排单失败')
    }
  } finally {
    submitting.value = false
  }
}

function stepTagType(step: RelocationStep): 'success' | 'warning' | 'danger' | 'info' {
  if (step.state === '已完成') return 'success'
  if (step.state === '失败') return 'danger'
  if (step.state === '已取消') return 'info'
  return 'warning'
}

function statusTagType(status: RelocationStatus): 'success' | 'warning' | 'danger' | 'info' | 'primary' {
  if (status === '已完成') return 'success'
  if (status === '执行中') return 'primary'
  if (status === '已失败') return 'danger'
  if (status === '已取消') return 'info'
  return 'warning'
}

const currentStepOf = (plan: Relocation): RelocationStep | null =>
  relocationStore.nextPendingStep(plan)

const doneCountOf = (plan: Relocation): number =>
  plan.steps.filter((step) => step.state === '已完成').length

const percentOf = (plan: Relocation): number =>
  plan.steps.length === 0 ? 0 : Math.round((doneCountOf(plan) / plan.steps.length) * 100)

async function executeOne(plan: Relocation, step: RelocationStep): Promise<void> {
  executingId.value = plan.id
  try {
    const result = await relocationStore.executeStep(plan.id, step.seq)
    if (result.ok) {
      if (result.alreadyDone) ElMessage.info(result.message)
      else ElMessage.success(result.message)
    } else {
      ElMessage.error(result.message)
    }
  } finally {
    executingId.value = null
  }
}

async function resume(plan: Relocation): Promise<void> {
  executingId.value = plan.id
  try {
    const { executed, result } = await relocationStore.resumePlan(plan.id)
    if (result && !result.ok) {
      ElMessage.error(`续办在第 ${currentStepOf(plan)?.seq ?? '?'} 步前停下：${result.message}`)
    } else if (executed > 0) {
      ElMessage.success(`已续办 ${executed} 步，编排单全部步骤办理完成`)
    } else {
      ElMessage.info('编排单已是最新状态，没有待办步骤')
    }
  } finally {
    executingId.value = null
  }
}

async function cancel(plan: Relocation): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `取消编排单「${plan.title}」？已落地的 ${doneCountOf(plan)} 步保持不变，未完成步骤将标记为已取消。`,
      '取消编排确认',
      { type: 'warning', confirmButtonText: '确认取消', cancelButtonText: '返回' }
    )
  } catch {
    return
  }
  await relocationStore.cancelPlan(plan.id)
  ElMessage.success('编排单已取消，已落地步骤与转架作业保留')
}

async function remove(plan: Relocation): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除终态编排单「${plan.title}」？已生成的转架作业仍保留。`, '删除确认', {
      type: 'warning',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  try {
    await relocationStore.removePlan(plan.id)
    ElMessage.success('编排单已删除')
  } catch (err) {
    ElMessage.warning(err instanceof Error ? err.message : '删除失败')
  }
}

const conflictPlans = computed(() =>
  plans.value.filter((plan) => plan.status === '已失败')
)
</script>

<template>
  <section>
    <div class="page-title">
      <div>
        <h2>整批调拨 · 转架编排</h2>
        <p>
          先按窖位容量排出临时位与执行顺序，确认后逐步办理；每步同步写回批次窖位、窖位占用与转架作业，
          失败可续办，刷新页面后接着处理。
        </p>
      </div>
      <div>
        <el-button type="primary" :icon="Plus" @click="openDialog">新建转架编排</el-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="编排单" :value="plans.length" suffix="单" icon="Sort" />
      <StatBadge
        label="待执行 / 执行中"
        :value="statusCounts['待执行'] + statusCounts['执行中']"
        suffix="单"
        icon="VideoPlay"
        tone="primary"
      />
      <StatBadge
        label="待续办（失败）"
        :value="statusCounts['已失败']"
        suffix="单"
        icon="WarningFilled"
        tone="danger"
      />
      <StatBadge
        label="已完成"
        :value="statusCounts['已完成']"
        suffix="单"
        icon="CircleCheckFilled"
        tone="success"
      />
      <StatBadge label="已取消" :value="statusCounts['已取消']" suffix="单" icon="RefreshRight" />
      <StatBadge
        label="在办占用批次"
        :value="activePlans.reduce((sum, plan) => sum + plan.batchIds.length, 0)"
        suffix="批"
        icon="Box"
        tone="warning"
      />
    </div>

    <el-alert
      v-for="plan in conflictPlans"
      :key="plan.id"
      type="error"
      show-icon
      :closable="false"
      class="alert-gap"
    >
      <div class="conflict-alert">
        <span>编排单「{{ plan.title }}」办理中断：{{ plan.failReason || '存在未完成步骤' }}</span>
        <el-button size="small" type="danger" :icon="RefreshRight" @click="resume(plan)">
          恢复未完成队列并续办
        </el-button>
      </div>
    </el-alert>

    <FilterBar
      :model-value="filterModel"
      :selects="statusSelects"
      keyword-placeholder="搜索编排单 / 批次 / 窖位 / 办理人"
      @update:model-value="applyFilter"
      @reset="resetFilter"
    />

    <EmptyPanel
      v-if="ready && filteredPlans.length === 0"
      title="还没有转架编排单"
      description="选择多个批次与各自目标窖位：两组货架对调或整库挪位时，系统会先排出临时中转位与执行顺序，容量不足会拒绝启动并指明冲突批次与目标窖位。"
      action-text="新建转架编排"
      @action="openDialog"
    />

    <div v-else class="relo-list">
      <article v-for="plan in filteredPlans" :key="plan.id" class="relo-card">
        <header class="relo-card__head">
          <div>
            <h4>{{ plan.title }}</h4>
            <p class="muted">
              办理人 {{ plan.operator }} · 作业日期
              <span class="mono">{{ plan.plannedAt }}</span> ·
              {{ plan.turningType }} 盐水 {{ plan.brinePct }}%
            </p>
          </div>
          <el-tag :type="statusTagType(plan.status)" effect="dark" size="default">
            {{ plan.status }}
          </el-tag>
        </header>

        <el-progress
          :percentage="percentOf(plan)"
          :stroke-width="10"
          :status="plan.status === '已失败' ? 'exception' : plan.status === '已完成' ? 'success' : undefined"
        />

        <el-alert
          v-if="plan.status === '已失败'"
          type="error"
          :closable="false"
          show-icon
          class="alert-gap"
          :title="plan.failReason || '存在办理失败的步骤'"
        />
        <el-alert
          v-else-if="plan.status === '已取消'"
          type="info"
          :closable="false"
          show-icon
          class="alert-gap"
          title="编排单已取消，未完成步骤作废；已落地步骤与转架作业保留。"
        />

        <ol class="step-list">
          <li
            v-for="step in plan.steps"
            :key="step.seq"
            class="step-item"
            :data-state="step.state"
            :class="{ 'is-current': currentStepOf(plan)?.seq === step.seq }"
          >
            <div class="step-item__main">
              <div class="step-item__title">
                <em class="step-item__seq">{{ step.seq }}</em>
                <el-tag v-if="step.temporary" type="warning" effect="plain" size="small">临时位</el-tag>
                <el-tag :type="stepTagType(step)" size="small" effect="dark">{{ step.state }}</el-tag>
              </div>
              <p class="step-item__note">{{ step.note }}</p>
              <p v-if="step.failReason" class="step-item__fail">失败原因：{{ step.failReason }}</p>
            </div>
            <div class="step-item__actions">
              <el-button
                v-if="
                  (step.state === '待执行' || step.state === '失败') &&
                  (plan.status === '待执行' || plan.status === '执行中' || plan.status === '已失败')
                "
                size="small"
                type="primary"
                :loading="executingId === plan.id"
                @click="executeOne(plan, step)"
              >
                {{ step.state === '失败' ? '重试本步' : '办理本步' }}
              </el-button>
              <span v-else-if="step.turningId" class="muted step-item__linked">
                作业 {{ step.turningId.slice(-6) }}
              </span>
            </div>
          </li>
        </ol>

        <footer class="relo-card__foot">
          <span class="muted">
            共 {{ plan.steps.length }} 步 · 已落地 {{ doneCountOf(plan) }} 步 ·
            涉及批次 {{ plan.batchIds.length }} 个 · 窖位 {{ plan.shelfIds.length }} 个
          </span>
          <div class="relo-card__buttons">
            <el-button
              v-if="plan.status === '待执行' || plan.status === '执行中' || plan.status === '已失败'"
              size="small"
              type="success"
              :icon="VideoPlay"
              :loading="executingId === plan.id"
              @click="resume(plan)"
            >
              {{ plan.status === '已失败' ? '恢复并续办' : '逐步办理' }}
            </el-button>
            <el-button
              v-if="plan.status === '待执行' || plan.status === '执行中' || plan.status === '已失败'"
              size="small"
              @click="cancel(plan)"
            >
              取消编排
            </el-button>
            <el-button
              v-if="plan.status === '已完成' || plan.status === '已取消'"
              size="small"
              type="danger"
              text
              :icon="Delete"
              @click="remove(plan)"
            >
              删除
            </el-button>
          </div>
        </footer>
      </article>
    </div>

    <el-dialog v-model="dialogVisible" title="新建整批调拨转架编排" width="760px" destroy-on-close>
      <el-form ref="formRef" :model="form" :rules="rules" label-width="110px">
        <el-form-item label="编排标题" prop="title">
          <el-input v-model="form.title" placeholder="如：两组货架对调 / 一号库整库挪位" clearable />
        </el-form-item>
        <div class="form-grid">
          <el-form-item label="作业日期" prop="plannedAt">
            <el-date-picker
              v-model="form.plannedAt"
              type="date"
              value-format="YYYY-MM-DD"
              style="width: 100%"
            />
          </el-form-item>
          <el-form-item label="办理人" prop="operator">
            <el-input v-model="form.operator" placeholder="如：周雨" clearable />
          </el-form-item>
        </div>
        <div class="form-grid">
          <el-form-item label="作业类型">
            <el-radio-group v-model="form.turningType">
              <el-radio-button v-for="type in TURNING_TYPES" :key="type" :value="type">
                {{ type }}
              </el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="盐水浓度 %">
            <el-input-number v-model="form.brinePct" :min="0" :max="30" :step="1" />
          </el-form-item>
        </div>

        <el-divider content-position="left">调拨批次与目标窖位</el-divider>

        <div v-for="row in form.moves" :key="row.key" class="move-row">
          <el-select
            v-model="row.batchId"
            filterable
            placeholder="选择批次"
            class="move-row__batch"
          >
            <el-option
              v-for="batch in movableBatches"
              :key="batch.id"
              :label="batchOptionLabel(batch.id)"
              :value="batch.id"
            />
          </el-select>
          <span class="move-row__arrow">→</span>
          <el-select v-model="row.toShelfId" filterable placeholder="选择目标窖位" class="move-row__shelf">
            <el-option
              v-for="shelf in shelves"
              :key="shelf.id"
              :label="shelfOptionLabel(shelf.id)"
              :value="shelf.id"
            />
          </el-select>
          <el-button text type="danger" :icon="Delete" @click="removeMoveRow(row.key)" />
        </div>
        <el-button text type="primary" :icon="Plus" @click="addMoveRow()">添加一批</el-button>

        <el-alert
          v-if="duplicateBatches.length > 0"
          type="warning"
          :closable="false"
          show-icon
          class="alert-gap"
          :title="`同一批次在本单中重复：${duplicateBatches.map(batchOptionLabel).join('、')}`"
        />
        <el-alert
          v-else-if="preview && preview.ok"
          type="success"
          :closable="false"
          show-icon
          class="alert-gap"
        >
          <div>{{ preview.message }}</div>
          <div class="muted preview-hint">确认后编排单将按此顺序逐步办理，每步生成一条「已完成」转架作业。</div>
        </el-alert>
        <el-alert
          v-else-if="preview && !preview.ok"
          type="error"
          :closable="false"
          show-icon
          class="alert-gap"
        >
          <div>{{ preview.message }}</div>
          <div class="muted preview-hint">
            容量不足、目标位互相占满且没有可周转临时位，或与其他在办编排单冲突时，编排不会启动。
          </div>
        </el-alert>
        <el-alert v-else type="info" :closable="false" show-icon class="alert-gap"
          >选择批次与目标窖位后，系统会按窖位容量实时排出临时位与执行顺序。</el-alert
        >
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submit">确认编排</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.alert-gap {
  margin: 10px 0;
}

.conflict-alert {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.relo-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.relo-card {
  padding: 16px 18px;
  border: 1px solid #e7dfd0;
  border-left: 4px solid #c47a1c;
  border-radius: 12px;
  background: #fffdf8;
}

.relo-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.relo-card__head h4 {
  margin: 0 0 4px;
  font-size: 16px;
}

.step-list {
  margin: 8px 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.step-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border: 1px solid #ece4d4;
  border-radius: 10px;
  background: #ffffff;
}

.step-item[data-state='已完成'] {
  border-color: #bfe3cd;
  background: #f6fdf9;
}

.step-item[data-state='失败'] {
  border-color: #e6b3ad;
  background: #fdf6f5;
}

.step-item[data-state='已取消'] {
  opacity: 0.62;
}

.step-item.is-current {
  box-shadow: 0 0 0 2px rgba(196, 122, 28, 0.25);
}

.step-item__main {
  min-width: 0;
}

.step-item__title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.step-item__seq {
  display: inline-grid;
  width: 22px;
  height: 22px;
  place-items: center;
  border-radius: 50%;
  background: #c47a1c;
  color: #ffffff;
  font-size: 12px;
  font-style: normal;
}

.step-item__note {
  margin: 4px 0 0;
  font-size: 13px;
}

.step-item__fail {
  margin: 4px 0 0;
  color: #c0392b;
  font-size: 12px;
}

.step-item__linked {
  font-size: 12px;
}

.relo-card__foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed #e7dfd0;
  font-size: 12px;
}

.relo-card__buttons {
  display: flex;
  gap: 8px;
}

.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 16px;
}

.move-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.move-row__batch {
  flex: 1.2;
}

.move-row__shelf {
  flex: 1;
}

.move-row__arrow {
  color: #8a5a1c;
  font-weight: 700;
}

.preview-hint {
  margin-top: 4px;
  font-size: 12px;
}
</style>
