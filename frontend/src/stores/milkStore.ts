import { defineStore } from 'pinia'
import { computed, ref, type ComputedRef } from 'vue'
import { db } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  createEmptyMilkFilter,
  type Milk,
  type MilkFilterState,
  type MilkKind,
  type MilkOverview,
  type MilkStat
} from '@/types/milk'
import {
  BATCH_STATE_FLOW,
  type Batch,
  type BatchState,
  type CheeseType
} from '@/types/batch'
import { computeAging } from '@/hooks/useAgingDays'
import { toDateString } from '@/utils/temperature'
import { useRelocationStore } from '@/stores/relocationStore'

export interface NewMilkInput {
  farm: string
  milkKind: MilkKind
  collectedAt: string
  fatPct: number
  proteinPct: number
  note: string
}

export interface NewBatchInput {
  milkId: string
  curdedAt: string
  cheeseType: CheeseType
  targetDays: number
  weightKg: number
  state: BatchState
}

/**
 * 奶源与生产批次 store：维护奶源台账、批次台账、筛选条件与派生统计。
 * 页面只读 store，跨页状态（筛选条件、选中项）不留在组件内部。
 */
export const useMilkStore = defineStore('milk', () => {
  const milksTable = useIdbTable<Milk>((database) => database.milks)
  const batchesTable = useIdbTable<Batch>((database) => database.batches, {
    sortByUpdatedAt: false
  })
  const relocationStore = useRelocationStore()

  const filter = ref<MilkFilterState>(createEmptyMilkFilter())
  const currentMilkId = ref<string | null>(null)

  const milks = computed<Milk[]>(() => milksTable.rows.value)
  const batches = computed<Batch[]>(() => batchesTable.rows.value)
  const loading = computed(() => milksTable.loading.value || batchesTable.loading.value)
  const ready = computed(() => milksTable.ready.value && batchesTable.ready.value)
  const error = computed(() => milksTable.error.value ?? batchesTable.error.value)
  const today = computed(() => toDateString(new Date()))

  const currentMilk: ComputedRef<Milk | null> = computed(
    () => milks.value.find((milk) => milk.id === currentMilkId.value) ?? null
  )

  /** milkId → 该奶源下的批次列表 */
  const batchesByMilk = computed<Record<string, Batch[]>>(() => {
    const grouped: Record<string, Batch[]> = {}
    batches.value.forEach((batch) => {
      const bucket = grouped[batch.milkId] ?? []
      bucket.push(batch)
      grouped[batch.milkId] = bucket
    })
    return grouped
  })

  /** 奶源卡片回显：已用批次数、累计重量、在熟成批次数 */
  const milkStats = computed<MilkStat[]>(() =>
    milks.value.map((milk) => {
      const list = batchesByMilk.value[milk.id] ?? []
      return {
        milkId: milk.id,
        batchCount: list.length,
        totalWeightKg: Math.round(list.reduce((sum, batch) => sum + batch.weightKg, 0) * 10) / 10,
        agingCount: list.filter((batch) => batch.state === '熟成中').length
      }
    })
  )

  const milkStatMap = computed<Record<string, MilkStat>>(() => {
    const map: Record<string, MilkStat> = {}
    milkStats.value.forEach((stat) => {
      map[stat.milkId] = stat
    })
    return map
  })

  const overview = computed<MilkOverview>(() => ({
    milkCount: milks.value.length,
    batchCount: batches.value.length,
    agingBatchCount: batches.value.filter((batch) => batch.state === '熟成中').length,
    totalWeightKg: Math.round(batches.value.reduce((sum, batch) => sum + batch.weightKg, 0) * 10) / 10,
    releasedCount: batches.value.filter((batch) => batch.state === '已出库').length
  }))

  /** 关键字 + 乳种多选过滤奶源 */
  const filteredMilks = computed<Milk[]>(() =>
    milks.value.filter((milk) => {
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${milk.farm}${milk.milkKind}${milk.collectedAt}${milk.note}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.milkKinds.length > 0 && !filter.value.milkKinds.includes(milk.milkKind)) {
        return false
      }
      return true
    })
  )

  /**
   * 批次行过滤：批次状态多选 + 命中的奶源范围。
   * 奶源页把「乳种」多选同时作用于批次列表，保证两个列表口径一致。
   */
  const visibleMilks = computed<Milk[]>(() => {
    const keyword = filter.value.keyword.trim()
    if (keyword.length === 0 || filter.value.milkKinds.length > 0) return filteredMilks.value
    // 仅关键字命中批次时，也把其奶源纳入可见范围
    const batchHitMilkIds = new Set(
      batches.value
        .filter((batch) => `${batch.cheeseType}${batch.state}${batch.curdedAt}`.includes(keyword))
        .map((batch) => batch.milkId)
    )
    return milks.value.filter((milk) => filteredMilks.value.includes(milk) || batchHitMilkIds.has(milk.id))
  })

  const filteredBatches = computed<Batch[]>(() => {
    const keyword = filter.value.keyword.trim()
    const milkIds = new Set(visibleMilks.value.map((milk) => milk.id))
    return batches.value
      .filter((batch) => milkIds.has(batch.milkId))
      .filter((batch) => {
        if (keyword.length === 0) return true
        const milk = milks.value.find((item) => item.id === batch.milkId)
        const haystack = `${batch.cheeseType}${batch.state}${batch.curdedAt}${batch.conclusion}${
          milk?.farm ?? ''
        }`
        return haystack.includes(keyword)
      })
      .filter((batch) =>
        filter.value.batchStates.length === 0
          ? true
          : filter.value.batchStates.includes(batch.state)
      )
  })

  /** 批次 → 奶源名回显 */
  function milkNameOf(milkId: string): string {
    return milks.value.find((milk) => milk.id === milkId)?.farm ?? '奶源已删除'
  }

  function batchAging(batch: Batch | undefined | null) {
    return batch ? computeAging(batch, today.value) : null
  }

  function batchesOf(milkId: string): Batch[] {
    return (batchesByMilk.value[milkId] ?? []).slice().sort((a, b) => b.curdedAt.localeCompare(a.curdedAt))
  }

  /** 可流转到的下一状态 */
  function nextStates(state: BatchState): BatchState[] {
    return BATCH_STATE_FLOW[state]
  }

  function patchFilter(patch: Partial<MilkFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyMilkFilter()
  }

  function setCurrentMilk(id: string | null): void {
    currentMilkId.value = id
  }

  async function createMilk(payload: NewMilkInput): Promise<Milk> {
    return milksTable.create({ ...payload }, 'milk')
  }

  async function updateMilk(id: string, patch: Partial<Milk>): Promise<void> {
    await milksTable.update(id, patch)
  }

  /** 级联删除：奶源 → 批次 → 转架 / 环境 / 品评 */
  async function removeMilk(id: string): Promise<void> {
    const batchIds = batches.value.filter((batch) => batch.milkId === id).map((batch) => batch.id)
    const heldBy = batchIds
      .map((batchId) => relocationStore.activePlanHoldingBatch(batchId))
      .find((plan) => plan !== null)
    if (heldBy) {
      throw new Error(
        `该奶源下有批次仍在转架编排单「${heldBy.title}」中办理，请先完成或取消该编排单后再删除`
      )
    }
    await db.transaction(
      'rw',
      [db.milks, db.batches, db.shelves, db.turnings, db.environments, db.tastings],
      async () => {
        await db.turnings.where('batchId').anyOf(batchIds).delete()
        await db.environments.where('batchId').anyOf(batchIds).delete()
        await db.tastings.where('batchId').anyOf(batchIds).delete()
        await db.batches.bulkDelete(batchIds)
        await db.milks.delete(id)
      }
    )
    if (currentMilkId.value === id) currentMilkId.value = null
  }

  async function createBatch(payload: NewBatchInput): Promise<Batch> {
    const batch = await batchesTable.create(
      { ...payload, shelfId: null, conclusion: '' },
      'batch'
    )
    return batch
  }

  async function updateBatch(id: string, patch: Partial<Batch>): Promise<void> {
    await batchesTable.update(id, patch)
  }

  /** 回写批次结论（品评均分回写） */
  async function setBatchConclusion(id: string, conclusion: string): Promise<void> {
    await batchesTable.update(id, { conclusion })
  }

  /** 批次状态流转：凝乳 → 熟成中 → 已出库 / 报废 */
  async function advanceBatchState(id: string, next: BatchState): Promise<boolean> {
    const batch = batches.value.find((item) => item.id === id)
    if (!batch) return false
    if (!BATCH_STATE_FLOW[batch.state].includes(next)) return false
    await batchesTable.update(id, { state: next })
    return true
  }

  /** 级联删除：批次 → 转架 / 环境 / 品评 */
  async function removeBatch(id: string): Promise<boolean> {
    const batch = batches.value.find((item) => item.id === id)
    if (!batch) return false
    const heldBy = relocationStore.activePlanHoldingBatch(id)
    if (heldBy) {
      throw new Error(
        `批次仍在转架编排单「${heldBy.title}」中办理，请先完成或取消该编排单后再删除`
      )
    }
    await db.transaction(
      'rw',
      [db.batches, db.shelves, db.turnings, db.environments, db.tastings],
      async () => {
        await db.turnings.where('batchId').equals(id).delete()
        await db.environments.where('batchId').equals(id).delete()
        await db.tastings.where('batchId').equals(id).delete()
        await db.batches.delete(id)
        // 已占用窖位释放一块
        if (batch.shelfId) {
          const shelf = await db.shelves.get(batch.shelfId)
          if (shelf) {
            await db.shelves.update(shelf.id, {
              occupied: Math.max(0, shelf.occupied - 1),
              updatedAt: Date.now()
            })
          }
        }
      }
    )
    return true
  }

  return {
    milks,
    batches,
    loading,
    ready,
    error,
    today,
    filter,
    currentMilkId,
    currentMilk,
    batchesByMilk,
    milkStats,
    milkStatMap,
    overview,
    filteredMilks,
    visibleMilks,
    filteredBatches,
    milkNameOf,
    batchAging,
    batchesOf,
    nextStates,
    patchFilter,
    resetFilter,
    setCurrentMilk,
    createMilk,
    updateMilk,
    removeMilk,
    createBatch,
    updateBatch,
    setBatchConclusion,
    advanceBatchState,
    removeBatch
  }
})

export type MilkStore = ReturnType<typeof useMilkStore>
