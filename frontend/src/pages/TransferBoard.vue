<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Plus, RefreshRight, Switch } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useMilkStore } from '@/stores/milkStore'
import { useShelfStore } from '@/stores/shelfStore'
import { useTransferStore } from '@/stores/transferStore'
import type { TransferPlan, TransferStep } from '@/types/transfer'

const transferStore = useTransferStore()
const milkStore = useMilkStore()
const shelfStore = useShelfStore()
const { plans, ready, runningId, lockHeldByOther, lockPlanId } = storeToRefs(transferStore)

const createVisible = ref(false)
const mode = ref<'manual' | 'swap' | 'room'>('manual')
const previewSteps = ref<TransferStep[]>([])
const previewError = ref('')
const previewOk = ref(false)
const saving = ref(false)

const form = reactive({ title: '', operator: '', note: '' })
const targetRows = ref<Array<{ batchId: string; targetShelfId: string }>>([])

const shelfA = ref('')
const shelfB = ref('')
const sourceRoom = ref('')
const targetRoom = ref('')

const movableBatches = computed(() =>
  milkStore.batches.filter((batch) => batch.state !== '已出库' && batch.state !== '报废')
)

const roomOptions = computed<string[]>(() => shelfStore.roomOptions)

function shelvesByRoom(room: string) {
  return shelfStore.shelves.filter((shelf) => shelf.room === room)
}

function batchLabel(batchId: string): string {
  const batch = milkStore.batches.find((item) => item.id === batchId)
  if (!batch) return '批次已删除'
  return `${milkStore.milkNameOf(batch.milkId)} · ${batch.cheeseType} ${batch.curdedAt}`
}

function openCreate(): void {
  mode.value = 'manual'
  form.title = ''
  form.operator = ''
  form.note = ''
  previewSteps.value = []
  previewError.value = ''
  previewOk.value = false
  shelfA.value = ''
  shelfB.value = ''
  sourceRoom.value = ''
  targetRoom.value = ''
  targetRows.value = movableBatches.value.map((batch) => ({
    batchId: batch.id,
    targetShelfId: ''
  }))
  createVisible.value = true
}

/** 两组货架对调：A 上的批次 → B，B 上的批次 → A（未选中目标的行保持不调拨） */
function applySwap(): void {
  if (!shelfA.value || !shelfB.value) {
    ElMessage.warning('请先选择两组要对调的窖位')
    return
  }
  if (shelfA.value === shelfB.value) {
    ElMessage.warning('两组窖位不能相同')
    return
  }
  const targets = new Map<string, string>()
  milkStore.batches.forEach((batch) => {
    if (batch.state === '已出库' || batch.state === '报废') return
    if (batch.shelfId === shelfA.value) targets.set(batch.id, shelfB.value)
    else if (batch.shelfId === shelfB.value) targets.set(batch.id, shelfA.value)
  })
  if (targets.size === 0) {
    ElMessage.warning('这两组窖位上没有可调拨的批次')
    return
  }
  targetRows.value = targetRows.value.map((row) =>
    targets.has(row.batchId) ? { ...row, targetShelfId: targets.get(row.batchId)! } : row
  )
  ElMessage.success(`已生成对调目标：${targets.size} 个批次，请确认后生成预览`)
}

/** 整库挪位：源库房窖位按「货架号#层号」映射到目标库房对应窖位 */
function applyRoomMove(): void {
  if (!sourceRoom.value || !targetRoom.value) {
    ElMessage.warning('请先选择源库房与目标库房')
    return
  }
  if (sourceRoom.value === targetRoom.value) {
    ElMessage.warning('源库房与目标库房不能相同')
    return
  }
  const sourceShelves = shelvesByRoom(sourceRoom.value)
  const targetShelves = shelvesByRoom(targetRoom.value)
  const targetKey = new Map<string, string>()
  targetShelves.forEach((shelf) => {
    targetKey.set(`${shelf.rackNo}#${shelf.layerNo}`, shelf.id)
  })
  let matched = 0
  targetRows.value = targetRows.value.map((row) => {
    const batch = milkStore.batches.find((item) => item.id === row.batchId)
    if (!batch?.shelfId) return row
    const source = sourceShelves.find((shelf) => shelf.id === batch.shelfId)
    if (!source) return row
    const targetId = targetKey.get(`${source.rackNo}#${source.layerNo}`)
    if (!targetId) return row
    matched += 1
    return { ...row, targetShelfId: targetId }
  })
  if (matched === 0) {
    ElMessage.warning('未找到可映射的窖位（请确认目标库房有相同货架号 / 层号的窖位）')
    return
  }
  ElMessage.success(`已映射 ${matched} 个批次的目标窖位，请确认后生成预览`)
}

function doPreview(): void {
  const targets = targetRows.value
    .filter((row) => row.targetShelfId)
    .map((row) => ({ batchId: row.batchId, targetShelfId: row.targetShelfId }))
  if (targets.length === 0) {
    previewError.value = '请先为至少一个批次选择目标窖位'
    previewSteps.value = []
    previewOk.value = false
    return
  }
  const result = transferStore.preview(targets)
  previewOk.value = result.ok
  previewSteps.value = result.steps
  previewError.value = result.error ?? ''
}

async function savePlan(): Promise<void> {
  if (!previewOk.value) {
    ElMessage.warning('请先生成可行的编排预览')
    return
  }
  const targets = targetRows.value
    .filter((row) => row.targetShelfId)
    .map((row) => ({ batchId: row.batchId, targetShelfId: row.targetShelfId }))
  saving.value = true
  try {
    const plan = await transferStore.createPlan({ ...form, targets })
    ElMessage.success(`编排单 ${plan.code} 已保存，共 ${plan.steps.length} 步，可开始执行`)
    createVisible.value = false
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '保存失败')
  } finally {
    saving.value = false
  }
}

async function runPlan(plan: TransferPlan): Promise<void> {
  const result = await transferStore.run(plan.id)
  if (result.conflict) {
    ElMessage.error(result.error ?? '提交冲突')
    return
  }
  if (result.ok) {
    ElMessage.success(`编排单 ${plan.code} 已全部落地，批次窖位、窖位占用与转架作业均已回写`)
  } else {
    ElMessage.error(`编排单 ${plan.code} 在执行中失败：${result.error}。已落地步骤不会重复占位，可续办。`)
  }
}

async function cancelPlan(plan: TransferPlan): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `取消编排单 ${plan.code}？已落地的步骤保留，未执行的步骤不再办理。`,
      '取消确认',
      { type: 'warning', confirmButtonText: '确认取消', cancelButtonText: '返回' }
    )
  } catch {
    return
  }
  await transferStore.cancel(plan.id)
  ElMessage.success('编排单已取消')
}

async function removePlan(plan: TransferPlan): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除编排单 ${plan.code}？仅删除编排记录，已落地的批次窖位 / 占用 / 转架作业保留不变。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await transferStore.remove(plan.id)
  ElMessage.success('编排单已删除')
}

const activeCount = computed(() => plans.value.filter((plan) => plan.status === '执行中').length)
const doneCount = computed(() => plans.value.filter((plan) => plan.status === '已完成').length)
const resumableCount = computed(
  () => plans.value.filter((plan) => transferStore.isResumable(plan)).length
)

function statusTagType(status: TransferPlan['status']) {
  switch (status) {
    case '已完成':
      return 'success'
    case '执行中':
      return 'primary'
    case '已失败':
      return 'danger'
    case '已取消':
      return 'info'
    default:
      return 'warning'
  }
}

function stepTagType(status: TransferStep['status']) {
  switch (status) {
    case '已落地':
      return 'success'
    case '失败':
      return 'danger'
    default:
      return 'info'
  }
}
</script>

<template>
  <section>
    <div class="page-title">
      <div>
        <h2>转架编排</h2>
        <p>整批调拨先按窖位容量排出临时位与执行顺序，确认后逐步办理；失败可续办，已落地步骤不重复占位。</p>
      </div>
      <el-button type="primary" :icon="Plus" @click="openCreate">新建编排</el-button>
    </div>

    <el-alert
      v-if="lockHeldByOther"
      type="warning"
      :closable="false"
      show-icon
      class="alert-gap"
    >
      另一窗口正在执行编排单{{ lockPlanId ? `（${lockPlanId}）` : '' }}，此时提交将收到冲突结果，请等待其完成。
    </el-alert>

    <div class="stat-row">
      <StatBadge label="编排单" :value="plans.length" suffix="单" icon="Tickets" />
      <StatBadge label="执行中" :value="activeCount" suffix="单" icon="Loading" tone="primary" />
      <StatBadge label="已完成" :value="doneCount" suffix="单" icon="CircleCheckFilled" tone="success" />
      <StatBadge
        label="可续办"
        :value="resumableCount"
        suffix="单"
        icon="RefreshRight"
        :tone="resumableCount > 0 ? 'danger' : 'default'"
      />
    </div>

    <EmptyPanel
      v-if="ready && plans.length === 0"
      title="还没有转架编排单"
      description="两组货架对调或整库挪位时，先编排临时周转位与执行顺序，确认后逐步落地，避免目标位排满。"
      action-text="新建编排"
      @action="openCreate()"
    />

    <div v-for="plan in plans" :key="plan.id" class="section-card">
      <div class="section-card__head">
        <div class="plan-head">
          <strong class="mono">{{ plan.code }}</strong>
          <span>{{ plan.title }}</span>
          <el-tag :type="statusTagType(plan.status)" effect="light">{{ plan.status }}</el-tag>
          <span class="muted">操作人 {{ plan.operator }}</span>
        </div>
        <div class="plan-actions">
          <el-button
            v-if="plan.status === '已编排' || transferStore.isResumable(plan)"
            type="primary"
            :icon="RefreshRight"
            :loading="runningId === plan.id"
            @click="runPlan(plan)"
          >
            {{ plan.status === '已编排' ? '开始执行' : '续办' }}
          </el-button>
          <el-button
            v-if="plan.status === '执行中' && runningId !== plan.id"
            type="primary"
            :icon="RefreshRight"
            @click="runPlan(plan)"
          >
            接管续办
          </el-button>
          <el-button
            v-if="plan.status !== '已完成' && plan.status !== '已取消'"
            @click="cancelPlan(plan)"
          >
            取消编排
          </el-button>
          <el-button text type="danger" :icon="Delete" @click="removePlan(plan)">删除</el-button>
        </div>
      </div>

      <el-progress
        :percentage="transferStore.progressOf(plan).percent"
        :status="plan.status === '已失败' ? 'exception' : plan.status === '已完成' ? 'success' : undefined"
      />

      <el-table :data="plan.steps" border stripe size="small" class="step-table">
        <el-table-column label="顺序" width="70">
          <template #default="{ row }">
            <span class="mono">{{ row.seq }}</span>
          </template>
        </el-table-column>
        <el-table-column label="批次" min-width="240">
          <template #default="{ row }">{{ batchLabel(row.batchId) }}</template>
        </el-table-column>
        <el-table-column label="移出窖位" min-width="180">
          <template #default="{ row }">
            {{ row.fromShelfId ? shelfStore.shelfLabel(row.fromShelfId) : '未上架' }}
          </template>
        </el-table-column>
        <el-table-column label="移入窖位" min-width="180">
          <template #default="{ row }">{{ shelfStore.shelfLabel(row.toShelfId) }}</template>
        </el-table-column>
        <el-table-column label="类型" width="110">
          <template #default="{ row }">
            <el-tag :type="row.kind === '临时周转' ? 'warning' : 'success'" effect="plain">
              {{ row.kind }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="stepTagType(row.status)" effect="light">{{ row.status }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="失败原因" min-width="200">
          <template #default="{ row }">
            <span v-if="row.failReason" class="fail-reason">{{ row.failReason }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
      </el-table>
      <p v-if="plan.note" class="muted plan-note">备注：{{ plan.note }}</p>
    </div>

    <el-dialog v-model="createVisible" title="新建转架编排" width="960px" destroy-on-close>
      <el-tabs v-model="mode">
        <el-tab-pane label="逐批调拨" name="manual" />
        <el-tab-pane label="两组货架对调" name="swap" />
        <el-tab-pane label="整库挪位" name="room" />
      </el-tabs>

      <div v-if="mode === 'swap'" class="mode-row">
        <span>窖位 A</span>
        <el-select v-model="shelfA" filterable placeholder="选择窖位" style="width: 260px">
          <el-option-group v-for="room in roomOptions" :key="room" :label="room">
            <el-option
              v-for="shelf in shelvesByRoom(room)"
              :key="shelf.id"
              :label="shelfStore.shelfLabel(shelf.id)"
              :value="shelf.id"
            />
          </el-option-group>
        </el-select>
        <Switch class="mode-switch" />
        <span>窖位 B</span>
        <el-select v-model="shelfB" filterable placeholder="选择窖位" style="width: 260px">
          <el-option-group v-for="room in roomOptions" :key="room" :label="room">
            <el-option
              v-for="shelf in shelvesByRoom(room)"
              :key="shelf.id"
              :label="shelfStore.shelfLabel(shelf.id)"
              :value="shelf.id"
            />
          </el-option-group>
        </el-select>
        <el-button @click="applySwap">生成对调目标</el-button>
      </div>

      <div v-if="mode === 'room'" class="mode-row">
        <span>源库房</span>
        <el-select v-model="sourceRoom" placeholder="选择库房" style="width: 200px">
          <el-option v-for="room in roomOptions" :key="room" :label="room" :value="room" />
        </el-select>
        <span>目标库房</span>
        <el-select v-model="targetRoom" placeholder="选择库房" style="width: 200px">
          <el-option v-for="room in roomOptions" :key="room" :label="room" :value="room" />
        </el-select>
        <el-button @click="applyRoomMove">按货架号映射目标</el-button>
      </div>

      <el-table :data="targetRows" border stripe size="small" max-height="380" class="target-table">
        <el-table-column label="批次" min-width="260">
          <template #default="{ row }">{{ batchLabel(row.batchId) }}</template>
        </el-table-column>
        <el-table-column label="当前窖位" min-width="180">
          <template #default="{ row }">
            {{ shelfStore.shelfLabel(milkStore.batches.find((b) => b.id === row.batchId)?.shelfId ?? null) }}
          </template>
        </el-table-column>
        <el-table-column label="目标窖位（留空 = 不调拨）" min-width="260">
          <template #default="{ row }">
            <el-select
              v-model="row.targetShelfId"
              filterable
              clearable
              placeholder="选择目标窖位"
              style="width: 100%"
            >
              <el-option-group v-for="room in roomOptions" :key="room" :label="room">
                <el-option
                  v-for="shelf in shelvesByRoom(room)"
                  :key="shelf.id"
                  :label="`${shelfStore.shelfLabel(shelf.id)}（余 ${shelf.capacity - Math.max(shelf.occupied, shelfStore.batchesOfShelf(shelf.id).length)}）`"
                  :value="shelf.id"
                />
              </el-option-group>
            </el-select>
          </template>
        </el-table-column>
      </el-table>

      <div class="dialog-meta">
        <el-input v-model="form.title" placeholder="编排标题，如：一号库两组对调" />
        <el-input v-model="form.operator" placeholder="操作人" style="width: 180px" />
        <el-input v-model="form.note" type="textarea" :rows="2" placeholder="备注（可选）" />
      </div>

      <el-alert
        v-if="previewError"
        type="error"
        :closable="false"
        show-icon
        class="alert-gap"
        :title="previewError"
      />

      <div v-if="previewSteps.length > 0" class="preview-block">
        <h4>编排预览（{{ previewSteps.length }} 步，含临时周转）</h4>
        <el-table :data="previewSteps" border size="small" max-height="260">
          <el-table-column label="顺序" width="70">
            <template #default="{ row }">
              <span class="mono">{{ row.seq }}</span>
            </template>
          </el-table-column>
          <el-table-column label="批次" min-width="220">
            <template #default="{ row }">{{ batchLabel(row.batchId) }}</template>
          </el-table-column>
          <el-table-column label="路径" min-width="300">
            <template #default="{ row }">
              <span v-if="row.fromShelfId">{{ shelfStore.shelfLabel(row.fromShelfId) }}</span>
              <span v-else class="muted">未上架</span>
              →
              <span :class="{ 'temp-target': row.kind === '临时周转' }">
                {{ shelfStore.shelfLabel(row.toShelfId) }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="类型" width="110">
            <template #default="{ row }">
              <el-tag :type="row.kind === '临时周转' ? 'warning' : 'success'" effect="plain">
                {{ row.kind }}
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <template #footer>
        <el-button @click="doPreview">生成预览</el-button>
        <el-button type="primary" :loading="saving" :disabled="!previewOk" @click="savePlan">
          保存编排单
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.alert-gap {
  margin-bottom: 16px;
}

.plan-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.plan-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.step-table {
  margin-top: 10px;
}

.fail-reason {
  color: #c4561a;
}

.plan-note {
  margin: 8px 0 0;
  font-size: 12px;
}

.mode-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}

.mode-switch {
  color: var(--brand);
}

.target-table {
  margin-bottom: 12px;
}

.dialog-meta {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 12px;
}

.preview-block {
  margin-top: 12px;
}

.preview-block h4 {
  margin: 0 0 8px;
  font-size: 14px;
}

.temp-target {
  color: #c47a1c;
  font-weight: 600;
}
</style>
