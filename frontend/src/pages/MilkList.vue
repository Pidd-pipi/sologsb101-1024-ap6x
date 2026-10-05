<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import { Delete, Edit, Plus, Right } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar, {
  type FilterModel,
  type FilterSelectConfig
} from '@/components/common/FilterBar.vue'
import GradeTag from '@/components/common/GradeTag.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useAgingDays } from '@/hooks/useAgingDays'
import { useMilkStore } from '@/stores/milkStore'
import { useShelfStore } from '@/stores/shelfStore'
import {
  BATCH_STATES,
  CHEESE_TYPES,
  type Batch,
  type BatchState,
  type CheeseType
} from '@/types/batch'
import { MILK_KINDS, createEmptyMilkFilter, type Milk, type MilkKind } from '@/types/milk'
import type { TastingConclusion } from '@/types/tasting'
import { toDateString } from '@/utils/temperature'

const milkStore = useMilkStore()
const shelfStore = useShelfStore()

const { milks, batches, ready, filter, milkStatMap, overview } = storeToRefs(milkStore)
const { occupancyPercent } = storeToRefs(shelfStore)

/** 批次熟成派生值：最早可出库日期、已熟成天数、剩余天数与预警 */
const aging = useAgingDays({ batches: () => milkStore.batches })

const milkFormRef = ref<FormInstance>()
const batchFormRef = ref<FormInstance>()

const milkDialogVisible = ref(false)
const batchDialogVisible = ref(false)
const editingMilkId = ref<string | null>(null)
const editingBatchId = ref<string | null>(null)

const milkForm = reactive({
  farm: '',
  milkKind: '牛' as MilkKind,
  collectedAt: toDateString(new Date()),
  fatPct: 4,
  proteinPct: 3.3,
  note: ''
})

const batchForm = reactive({
  milkId: '',
  curdedAt: toDateString(new Date()),
  cheeseType: '硬质' as CheeseType,
  targetDays: 60,
  weightKg: 8,
  state: '凝乳' as BatchState
})

const milkRules: FormRules = {
  farm: [
    { required: true, message: '请填写牧场名称', trigger: 'blur' },
    { min: 2, max: 30, message: '牧场名称长度为 2 - 30 个字符', trigger: 'blur' }
  ],
  milkKind: [{ required: true, message: '请选择乳种', trigger: 'change' }],
  collectedAt: [{ required: true, message: '请选择收奶日期', trigger: 'change' }],
  fatPct: [
    {
      validator: (_rule: unknown, value: unknown, callback: (error?: Error) => void) => {
        const num = Number(value)
        if (value === '' || value === null || value === undefined || !Number.isFinite(num)) {
          callback(new Error('请填写脂肪率（0-20 之间的数字）'))
          return
        }
        if (num <= 0 || num > 20) {
          callback(new Error('脂肪率需大于 0 且不超过 20'))
          return
        }
        callback()
      },
      trigger: 'blur'
    }
  ],
  proteinPct: [
    {
      validator: (_rule: unknown, value: unknown, callback: (error?: Error) => void) => {
        const num = Number(value)
        if (value === '' || value === null || value === undefined || !Number.isFinite(num)) {
          callback(new Error('请填写蛋白率（0-10 之间的数字）'))
          return
        }
        if (num <= 0 || num > 10) {
          callback(new Error('蛋白率需大于 0 且不超过 10'))
          return
        }
        callback()
      },
      trigger: 'blur'
    }
  ]
}

const batchRules: FormRules = {
  milkId: [{ required: true, message: '请选择所属奶源', trigger: 'change' }],
  curdedAt: [{ required: true, message: '请选择凝乳日期', trigger: 'change' }],
  cheeseType: [{ required: true, message: '请选择奶酪类型', trigger: 'change' }],
  targetDays: [{ required: true, message: '请填写目标熟成天数', trigger: 'blur' }],
  weightKg: [{ required: true, message: '请填写入窖重量', trigger: 'blur' }]
}

const milkFilterModel = computed<FilterModel>(() => ({
  keyword: filter.value.keyword,
  milkKinds: [...filter.value.milkKinds],
  batchStates: [...filter.value.batchStates]
}))

const milkSelects = computed<FilterSelectConfig[]>(() => [
  {
    key: 'milkKinds',
    label: '乳种',
    queryKey: 'milk',
    options: MILK_KINDS.map((kind) => ({
      label: kind,
      value: kind,
      count: milks.value.filter((milk) => milk.milkKind === kind).length
    }))
  },
  {
    key: 'batchStates',
    label: '批次状态',
    queryKey: 'state',
    options: BATCH_STATES.map((state) => ({
      label: state,
      value: state,
      count: batches.value.filter((batch) => batch.state === state).length
    }))
  }
])

/** 批次表格行：附带奶源名与熟成派生值 */
interface BatchRow {
  batch: Batch
  milkName: string
  earliestOutAt: string
  remainDays: number
  progress: number
  warning: string
}

const batchRows = computed<BatchRow[]>(() =>
  milkStore.filteredBatches.map((batch) => {
    const info = aging.agingOf(batch)
    return {
      batch,
      milkName: milkStore.milkNameOf(batch.milkId),
      earliestOutAt: info?.earliestOutAt ?? batch.curdedAt,
      remainDays: info?.remainDays ?? 0,
      progress: info?.progress ?? 0,
      warning: info?.warning ?? ''
    }
  })
)

const milkRows = computed(() => milkStore.visibleMilks)

function applyFilter(model: FilterModel): void {
  milkStore.patchFilter({
    keyword: model.keyword,
    milkKinds: (model.milkKinds as MilkKind[]) ?? [],
    batchStates: (model.batchStates as string[]) ?? []
  })
}

function resetFilter(): void {
  milkStore.filter = createEmptyMilkFilter()
}

function resetMilkForm(): void {
  milkForm.farm = ''
  milkForm.milkKind = '牛'
  milkForm.collectedAt = toDateString(new Date())
  milkForm.fatPct = 4
  milkForm.proteinPct = 3.3
  milkForm.note = ''
}

function openMilkDialog(milk?: Milk): void {
  if (milk) {
    editingMilkId.value = milk.id
    milkForm.farm = milk.farm
    milkForm.milkKind = milk.milkKind
    milkForm.collectedAt = milk.collectedAt
    milkForm.fatPct = milk.fatPct
    milkForm.proteinPct = milk.proteinPct
    milkForm.note = milk.note
  } else {
    editingMilkId.value = null
    resetMilkForm()
  }
  milkDialogVisible.value = true
}

async function submitMilk(): Promise<void> {
  if (!milkFormRef.value) return
  const valid = await milkFormRef.value.validate().catch(() => false)
  if (!valid) return
  if (editingMilkId.value) {
    await milkStore.updateMilk(editingMilkId.value, { ...milkForm })
    ElMessage.success('奶源已更新')
  } else {
    const created = await milkStore.createMilk({ ...milkForm })
    milkStore.setCurrentMilk(created.id)
    ElMessage.success('奶源已新建，可继续挂接生产批次')
  }
  milkDialogVisible.value = false
}

function resetBatchForm(): void {
  batchForm.milkId = milkStore.currentMilkId ?? milks.value[0]?.id ?? ''
  batchForm.curdedAt = toDateString(new Date())
  batchForm.cheeseType = '硬质'
  batchForm.targetDays = 60
  batchForm.weightKg = 8
  batchForm.state = '凝乳'
}

function openBatchDialog(batch?: Batch, milkId?: string): void {
  if (batch) {
    editingBatchId.value = batch.id
    batchForm.milkId = batch.milkId
    batchForm.curdedAt = batch.curdedAt
    batchForm.cheeseType = batch.cheeseType
    batchForm.targetDays = batch.targetDays
    batchForm.weightKg = batch.weightKg
    batchForm.state = batch.state
  } else {
    editingBatchId.value = null
    resetBatchForm()
    if (milkId) batchForm.milkId = milkId
  }
  batchDialogVisible.value = true
}

/** 表单内实时预览：按目标熟成天数自动算最早可出库日期 */
const previewOutAt = computed(() => aging.earliestOutAt(batchForm.curdedAt, batchForm.targetDays))

async function submitBatch(): Promise<void> {
  if (!batchFormRef.value) return
  const valid = await batchFormRef.value.validate().catch(() => false)
  if (!valid) return
  if (editingBatchId.value) {
    await milkStore.updateBatch(editingBatchId.value, { ...batchForm })
    ElMessage.success('生产批次已更新，最早可出库日期已重算')
  } else {
    await milkStore.createBatch({ ...batchForm })
    ElMessage.success(`生产批次已新建，最早可出库日期：${previewOutAt.value}`)
  }
  batchDialogVisible.value = false
}

async function removeMilk(milk: Milk): Promise<void> {
  const batchCount = batches.value.filter((batch) => batch.milkId === milk.id).length
  try {
    await ElMessageBox.confirm(
      `删除奶源「${milk.farm}」将同时删除其 ${batchCount} 个生产批次，以及批次下的转架作业、环境记录与品评记录。是否继续？`,
      '级联删除确认',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    await milkStore.removeMilk(milk.id)
    ElMessage.success('奶源及其关联批次已删除')
  } catch (err) {
    ElMessage.warning(err instanceof Error ? err.message : '删除失败，请先处理关联的转架编排')
  }
}

async function removeBatch(batch: Batch): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除批次「${milkStore.milkNameOf(batch.milkId)} · ${batch.curdedAt}」将同时删除其转架作业、环境记录与品评记录，并释放占用的窖位。是否继续？`,
      '级联删除确认',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    await milkStore.removeBatch(batch.id)
    ElMessage.success('批次及其子记录已删除')
  } catch (err) {
    ElMessage.warning(err instanceof Error ? err.message : '删除失败，请先处理关联的转架编排')
  }
}

/** 状态流转：凝乳 → 熟成中 → 已出库 / 报废 */
async function advance(batch: Batch, next: BatchState): Promise<void> {
  const changed = await milkStore.advanceBatchState(batch.id, next)
  if (changed) {
    ElMessage.success(`批次状态已流转为「${next}」`)
  } else {
    ElMessage.warning(`当前状态「${batch.state}」不允许流转到「${next}」`)
  }
}

function nextStates(batch: Batch): BatchState[] {
  return milkStore.nextStates(batch.state)
}

function conclusionOf(batch: Batch): TastingConclusion | '' {
  return batch.conclusion === '优' || batch.conclusion === '合格' || batch.conclusion === '待改进'
    ? batch.conclusion
    : ''
}

function remainText(row: BatchRow): string {
  if (row.batch.state === '已出库' || row.batch.state === '报废') return '已终态'
  if (row.remainDays < 0) return `超期 ${Math.abs(row.remainDays)} 天`
  return `剩余 ${row.remainDays} 天`
}
</script>

<template>
  <section>
    <div class="page-title">
      <div>
        <h2>奶源与生产批次台账</h2>
        <p>录入牧场收奶记录，基于奶源建生产批次，并按目标熟成天数自动计算最早可出库日期。</p>
      </div>
      <div>
        <el-button type="primary" :icon="Plus" @click="openMilkDialog()">新建奶源</el-button>
        <el-button :icon="Plus" @click="openBatchDialog()">新建批次</el-button>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="奶源" :value="overview.milkCount" suffix="个" icon="Files" tone="primary" />
      <StatBadge label="生产批次" :value="overview.batchCount" suffix="批" icon="Grid" />
      <StatBadge
        label="熟成中"
        :value="overview.agingBatchCount"
        suffix="批"
        icon="AlarmClock"
        tone="warning"
      />
      <StatBadge
        label="累计入窖"
        :value="overview.totalWeightKg"
        suffix="kg"
        icon="Histogram"
        tone="info"
      />
      <StatBadge
        label="平均熟成天数"
        :value="aging.avgAgedDays.value"
        suffix="天"
        icon="TrendCharts"
        tone="success"
      />
      <StatBadge
        label="窖位占用率"
        :value="occupancyPercent"
        suffix="%"
        icon="PieChart"
        :percent="occupancyPercent"
        show-percent
        tone="danger"
      />
    </div>

    <FilterBar
      :model-value="milkFilterModel"
      :selects="milkSelects"
      keyword-placeholder="搜索牧场 / 乳种 / 奶酪类型 / 状态"
      @update:model-value="applyFilter"
      @reset="resetFilter"
    />

    <div class="section-card">
      <div class="section-card__head">
        <h3>奶源台账（{{ milkRows.length }} / {{ milks.length }}）</h3>
        <span class="muted">卡片回显已用批次数，可一键为该奶源建批次</span>
      </div>

      <EmptyPanel
        v-if="ready && milkRows.length === 0"
        title="没有符合条件的奶源"
        description="调整筛选条件，或新建一条奶源记录后继续挂接生产批次。"
        action-text="新建奶源"
        @action="openMilkDialog()"
      />
      <el-table v-else :data="milkRows" border stripe>
        <el-table-column prop="farm" label="牧场" min-width="160" />
        <el-table-column prop="milkKind" label="乳种" width="90" />
        <el-table-column prop="collectedAt" label="收奶日期" width="120" />
        <el-table-column label="脂肪率" width="90">
          <template #default="{ row }">
            <span class="mono">{{ row.fatPct }}%</span>
          </template>
        </el-table-column>
        <el-table-column label="蛋白率" width="90">
          <template #default="{ row }">
            <span class="mono">{{ row.proteinPct }}%</span>
          </template>
        </el-table-column>
        <el-table-column label="已用批次" width="110">
          <template #default="{ row }">
            <el-tag type="warning" effect="plain" round>
              {{ milkStatMap[row.id]?.batchCount ?? 0 }} 批
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="累计入窖" width="110">
          <template #default="{ row }">
            <span class="mono">{{ milkStatMap[row.id]?.totalWeightKg ?? 0 }} kg</span>
          </template>
        </el-table-column>
        <el-table-column prop="note" label="备注" min-width="180" show-overflow-tooltip />
        <el-table-column label="操作" width="240" fixed="right">
          <template #default="{ row }">
            <el-button text type="primary" :icon="Plus" @click="openBatchDialog(undefined, row.id)">
              建批次
            </el-button>
            <el-button text :icon="Edit" @click="openMilkDialog(row)">编辑</el-button>
            <el-button text type="danger" :icon="Delete" @click="removeMilk(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div class="section-card">
      <div class="section-card__head">
        <h3>生产批次（{{ batchRows.length }} / {{ batches.length }}）</h3>
        <span class="muted">最早可出库日期 = 凝乳日期 + 目标熟成天数</span>
      </div>

      <EmptyPanel
        v-if="ready && batchRows.length === 0"
        title="没有符合条件的批次"
        description="先建奶源，再按奶源建立生产批次；批次状态可从「凝乳」推进到「熟成中」。"
        action-text="新建批次"
        @action="openBatchDialog()"
      />
      <el-table v-else :data="batchRows" border stripe>
        <el-table-column label="奶源" min-width="150">
          <template #default="{ row }">{{ row.milkName }}</template>
        </el-table-column>
        <el-table-column prop="batch.cheeseType" label="类型" width="90" />
        <el-table-column prop="batch.curdedAt" label="凝乳日期" width="120" />
        <el-table-column label="目标天数" width="100">
          <template #default="{ row }">
            <span class="mono">{{ row.batch.targetDays }} 天</span>
          </template>
        </el-table-column>
        <el-table-column label="最早可出库" width="130">
          <template #default="{ row }">
            <span class="mono">{{ row.earliestOutAt }}</span>
          </template>
        </el-table-column>
        <el-table-column label="熟成进度" width="180">
          <template #default="{ row }">
            <el-progress
              :percentage="row.progress"
              :stroke-width="10"
              :color="aging.progressColor(aging.agingOf(row.batch))"
            />
            <span class="muted">{{ remainText(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="入窖重量" width="110">
          <template #default="{ row }">
            <span class="mono">{{ row.batch.weightKg }} kg</span>
          </template>
        </el-table-column>
        <el-table-column label="窖位" min-width="170">
          <template #default="{ row }">
            <el-tag v-if="row.batch.shelfId" type="success" effect="plain">
              {{ shelfStore.shelfLabel(row.batch.shelfId) }}
            </el-tag>
            <el-tag v-else type="info" effect="plain">未上架</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag
              :type="
                row.batch.state === '已出库'
                  ? 'success'
                  : row.batch.state === '报废'
                    ? 'danger'
                    : row.batch.state === '熟成中'
                      ? 'warning'
                      : 'info'
              "
              effect="dark"
            >
              {{ row.batch.state }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="结论" width="110">
          <template #default="{ row }">
            <GradeTag
              v-if="conclusionOf(row.batch)"
              :conclusion="conclusionOf(row.batch)"
              plain
              size="small"
            />
            <span v-else class="muted">未评</span>
          </template>
        </el-table-column>
        <el-table-column label="出库预警" min-width="190">
          <template #default="{ row }">
            <span :class="row.remainDays < 0 ? 'warn' : 'muted'">{{ row.warning || '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态流转" width="190" fixed="right">
          <template #default="{ row }">
            <template v-if="nextStates(row.batch).length > 0">
              <el-button
                v-for="state in nextStates(row.batch)"
                :key="state"
                text
                type="primary"
                :icon="Right"
                @click="advance(row.batch, state)"
              >
                {{ state }}
              </el-button>
            </template>
            <span v-else class="muted">已终态</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="160" fixed="right">
          <template #default="{ row }">
            <el-button text :icon="Edit" @click="openBatchDialog(row.batch)">编辑</el-button>
            <el-button text type="danger" :icon="Delete" @click="removeBatch(row.batch)">
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <el-dialog
      v-model="milkDialogVisible"
      :title="editingMilkId ? '编辑奶源' : '新建奶源'"
      width="560px"
      destroy-on-close
    >
      <el-form ref="milkFormRef" :model="milkForm" :rules="milkRules" label-width="110px">
        <el-form-item label="牧场名称" prop="farm">
          <el-input v-model="milkForm.farm" placeholder="如：清源高山牧场" clearable />
        </el-form-item>
        <el-form-item label="乳种" prop="milkKind">
          <el-select v-model="milkForm.milkKind" placeholder="选择乳种" style="width: 100%">
            <el-option v-for="kind in MILK_KINDS" :key="kind" :label="kind" :value="kind" />
          </el-select>
        </el-form-item>
        <el-form-item label="收奶日期" prop="collectedAt">
          <el-date-picker
            v-model="milkForm.collectedAt"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="选择收奶日期"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="脂肪率 %" prop="fatPct">
          <el-input-number v-model="milkForm.fatPct" :min="0" :max="20" :step="0.1" :precision="1" />
        </el-form-item>
        <el-form-item label="蛋白率 %" prop="proteinPct">
          <el-input-number
            v-model="milkForm.proteinPct"
            :min="0"
            :max="10"
            :step="0.1"
            :precision="1"
          />
        </el-form-item>
        <el-form-item label="备注" prop="note">
          <el-input
            v-model="milkForm.note"
            type="textarea"
            :rows="3"
            placeholder="饲料、体细胞数、异常情况等"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="milkDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitMilk">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="batchDialogVisible"
      :title="editingBatchId ? '编辑生产批次' : '新建生产批次'"
      width="560px"
      destroy-on-close
    >
      <el-form ref="batchFormRef" :model="batchForm" :rules="batchRules" label-width="120px">
        <el-form-item label="所属奶源" prop="milkId">
          <el-select v-model="batchForm.milkId" placeholder="选择奶源" style="width: 100%">
            <el-option
              v-for="milk in milks"
              :key="milk.id"
              :label="`${milk.farm}（${milk.milkKind} ${milk.collectedAt}）`"
              :value="milk.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="凝乳日期" prop="curdedAt">
          <el-date-picker
            v-model="batchForm.curdedAt"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="选择凝乳日期"
            style="width: 100%"
          />
        </el-form-item>
        <el-form-item label="奶酪类型" prop="cheeseType">
          <el-select v-model="batchForm.cheeseType" style="width: 100%">
            <el-option v-for="type in CHEESE_TYPES" :key="type" :label="type" :value="type" />
          </el-select>
        </el-form-item>
        <el-form-item label="目标熟成天数" prop="targetDays">
          <el-input-number v-model="batchForm.targetDays" :min="1" :max="720" :step="5" />
        </el-form-item>
        <el-form-item label="入窖重量 kg" prop="weightKg">
          <el-input-number
            v-model="batchForm.weightKg"
            :min="0.1"
            :max="500"
            :step="0.5"
            :precision="1"
          />
        </el-form-item>
        <el-form-item label="批次状态" prop="state">
          <el-select v-model="batchForm.state" style="width: 100%">
            <el-option v-for="state in BATCH_STATES" :key="state" :label="state" :value="state" />
          </el-select>
        </el-form-item>
        <el-alert type="success" :closable="false" show-icon>
          最早可出库日期：{{ previewOutAt }}（凝乳日期 + {{ batchForm.targetDays }} 天）
        </el-alert>
      </el-form>
      <template #footer>
        <el-button @click="batchDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitBatch">保存</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.warn {
  color: #c0392b;
  font-weight: 600;
}
</style>
