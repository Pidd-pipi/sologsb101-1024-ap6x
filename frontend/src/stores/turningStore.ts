import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, readUiPrefs, writeUiPrefs } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  createEmptyTurningFilter,
  TURNING_TYPES,
  type Turning,
  type TurningFilterState,
  type TurningPlanInput,
  type TurningState,
  type TurningSummary
} from '@/types/turning'
import type { Batch } from '@/types/batch'
import type { Shelf } from '@/types/shelf'
import { useMilkStore } from '@/stores/milkStore'
import { useShelfStore } from '@/stores/shelfStore'
import { addDays, toDateString } from '@/utils/temperature'

/** 转架作业行：作业 + 批次 + 窖位的展开结果，表格与拖拽列表共用 */
export interface TurningRow {
  turning: Turning
  batch: Batch | null
  shelf: Shelf | null
  batchLabel: string
  milkLabel: string
  shelfLabel: string
}

export interface NewTurningInput {
  batchId: string
  shelfId: string
  doneAt: string
  type: Turning['type']
  brinePct: number
  operator: string
  state: TurningState
}

/**
 * 转架作业 store：维护作业计划、执行状态、拖拽顺序与统计派生值。
 * 拖拽排序结果写回 Dexie 的 seq 字段（同一批次内按 seq 升序）。
 */
export const useTurningStore = defineStore('turning', () => {
  const turningsTable = useIdbTable<Turning>((database) => database.turnings, {
    sortByUpdatedAt: false
  })
  const milkStore = useMilkStore()
  const shelfStore = useShelfStore()

  const prefs = readUiPrefs()
  const filter = ref<TurningFilterState>(createEmptyTurningFilter())
  const sortMode = ref<'manual' | 'date'>(prefs.turningSort)
  const activeBatchId = ref<string | null>(null)
  const draggingId = ref<string | null>(null)
  const dragOverId = ref<string | null>(null)

  const turnings = computed<Turning[]>(() => turningsTable.rows.value)
  const loading = computed(() => turningsTable.loading.value)
  const ready = computed(() => turningsTable.ready.value)
  const error = computed(() => turningsTable.error.value)
  const today = computed(() => toDateString(new Date()))

  const batches = computed<Batch[]>(() => milkStore.batches)
  const shelves = computed<Shelf[]>(() => shelfStore.shelves)

  function batchOf(batchId: string): Batch | null {
    return batches.value.find((batch) => batch.id === batchId) ?? null
  }

  function batchLabelOf(batchId: string): string {
    const batch = batchOf(batchId)
    if (!batch) return '批次已删除'
    return `${batch.cheeseType} · ${batch.curdedAt}`
  }

  function milkLabelOf(batchId: string): string {
    const batch = batchOf(batchId)
    if (!batch) return '—'
    return milkStore.milkNameOf(batch.milkId)
  }

  /** 展开后的作业行，按 seq 升序（同一批次内） */
  const rows = computed<TurningRow[]>(() =>
    turnings.value.map((turning) => {
      const batch = batchOf(turning.batchId)
      return {
        turning,
        batch,
        shelf: shelves.value.find((shelf) => shelf.id === turning.shelfId) ?? null,
        batchLabel: batchLabelOf(turning.batchId),
        milkLabel: milkLabelOf(turning.batchId),
        shelfLabel: shelfStore.shelfLabel(turning.shelfId)
      }
    })
  )

  /** 关键字 + 类型多选 + 状态多选过滤 */
  const filteredRows = computed<TurningRow[]>(() => {
    const filtered = rows.value.filter((row) => {
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${row.turning.operator}${row.turning.type}${row.turning.state}${row.turning.doneAt}${row.batchLabel}${row.milkLabel}${row.shelfLabel}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.types.length > 0 && !filter.value.types.includes(row.turning.type)) return false
      if (filter.value.states.length > 0 && !filter.value.states.includes(row.turning.state)) return false
      if (activeBatchId.value && row.turning.batchId !== activeBatchId.value) return false
      return true
    })
    return filtered.slice().sort((a, b) => {
      if (sortMode.value === 'date') {
        const diff = a.turning.doneAt.localeCompare(b.turning.doneAt)
        if (diff !== 0) return diff
      }
      const batchDiff = a.turning.batchId.localeCompare(b.turning.batchId)
      if (batchDiff !== 0) return batchDiff
      return a.turning.seq - b.turning.seq
    })
  })

  /** 视图中的作业按批次分组，拖拽排序限定在同一批次内 */
  const groupedRows = computed<Array<{ batchId: string; label: string; rows: TurningRow[] }>>(() => {
    const groups = new Map<string, TurningRow[]>()
    filteredRows.value.forEach((row) => {
      const bucket = groups.get(row.turning.batchId) ?? []
      bucket.push(row)
      groups.set(row.turning.batchId, bucket)
    })
    return Array.from(groups.entries()).map(([batchId, list]) => ({
      batchId,
      label: list[0]?.batchLabel ?? '批次已删除',
      rows: list.slice().sort((a, b) => a.turning.seq - b.turning.seq)
    }))
  })

  const summary = computed<TurningSummary>(() => {
    const list = filteredRows.value.map((row) => row.turning)
    const done = list.filter((turning) => turning.state === '已完成').length
    const skipped = list.filter((turning) => turning.state === '已跳过').length
    const brine = list.filter((turning) => turning.brinePct > 0).map((turning) => turning.brinePct)
    return {
      total: list.length,
      pending: list.length - done - skipped,
      done,
      skipped,
      donePercent: list.length === 0 ? 0 : Math.round((done / list.length) * 100),
      avgBrinePct:
        brine.length === 0
          ? 0
          : Math.round((brine.reduce((sum, value) => sum + value, 0) / brine.length) * 10) / 10
    }
  })

  /** 今日待执行作业 */
  const todayRows = computed<TurningRow[]>(() =>
    rows.value.filter(
      (row) => row.turning.state === '待执行' && row.turning.doneAt === today.value
    )
  )

  /** 逾期未执行的作业 */
  const overdueRows = computed<TurningRow[]>(() =>
    rows.value.filter(
      (row) => row.turning.state === '待执行' && row.turning.doneAt < today.value
    )
  )

  function setSortMode(mode: 'manual' | 'date'): void {
    sortMode.value = mode
    writeUiPrefs({ ...readUiPrefs(), turningSort: mode })
  }

  function setActiveBatch(id: string | null): void {
    activeBatchId.value = id
  }

  function patchFilter(patch: Partial<TurningFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyTurningFilter()
  }

  function nextSeq(batchId: string): number {
    const list = turnings.value.filter((turning) => turning.batchId === batchId)
    return list.length === 0 ? 1 : Math.max(...list.map((turning) => turning.seq)) + 1
  }

  async function createTurning(payload: NewTurningInput): Promise<Turning> {
    return turningsTable.create({ ...payload, seq: nextSeq(payload.batchId) }, 'turn')
  }

  async function updateTurning(id: string, patch: Partial<Turning>): Promise<void> {
    await turningsTable.update(id, patch)
  }

  async function removeTurning(id: string): Promise<void> {
    const turning = turnings.value.find((item) => item.id === id)
    await turningsTable.remove(id)
    if (turning) await normalizeSeq(turning.batchId)
  }

  /** 逐条签署：待执行 → 已完成 / 已跳过（可回退为待执行） */
  async function setState(id: string, state: TurningState): Promise<boolean> {
    const turning = turnings.value.find((item) => item.id === id)
    if (!turning) return false
    await turningsTable.update(id, { state })
    return true
  }

  async function complete(id: string): Promise<boolean> {
    return setState(id, '已完成')
  }

  async function skip(id: string): Promise<boolean> {
    return setState(id, '已跳过')
  }

  async function reopen(id: string): Promise<boolean> {
    return setState(id, '待执行')
  }

  /** 按批次生成等间隔作业计划：起始日 + 间隔天数 × 次数 */
  async function generatePlan(input: TurningPlanInput): Promise<number> {
    const times = Math.max(1, Math.min(24, Math.round(input.times)))
    const interval = Math.max(1, Math.round(input.intervalDays))
    const startSeq = nextSeq(input.batchId)
    const now = Date.now()
    const records: Turning[] = []
    for (let index = 0; index < times; index += 1) {
      records.push({
        id: `${input.batchId}_plan_${now.toString(36)}_${index}`,
        batchId: input.batchId,
        shelfId: input.shelfId,
        doneAt: addDays(input.startAt, index * interval),
        type: input.type,
        brinePct: input.brinePct,
        operator: input.operator,
        state: '待执行',
        seq: startSeq + index,
        createdAt: now,
        updatedAt: now
      })
    }
    await turningsTable.bulkPut(records)
    return records.length
  }

  /** 拖拽后按新顺序批量回写 seq */
  async function reorder(batchId: string, orderedIds: string[]): Promise<void> {
    const now = Date.now()
    const rest = turnings.value
      .filter((turning) => turning.batchId === batchId && !orderedIds.includes(turning.id))
      .sort((a, b) => a.seq - b.seq)
    await db.transaction('rw', db.turnings, async () => {
      for (let index = 0; index < orderedIds.length; index += 1) {
        await db.turnings.update(orderedIds[index], { seq: index + 1, updatedAt: now })
      }
      for (let index = 0; index < rest.length; index += 1) {
        await db.turnings.update(rest[index].id, {
          seq: orderedIds.length + index + 1,
          updatedAt: now
        })
      }
    })
  }

  /** 把 seq 规范化为连续序号 */
  async function normalizeSeq(batchId: string): Promise<void> {
    const list = await db.turnings.where('batchId').equals(batchId).toArray()
    const sorted = list.sort((a, b) => a.seq - b.seq)
    const now = Date.now()
    await db.transaction('rw', db.turnings, async () => {
      for (let index = 0; index < sorted.length; index += 1) {
        if (sorted[index].seq !== index + 1) {
          await db.turnings.update(sorted[index].id, { seq: index + 1, updatedAt: now })
        }
      }
    })
  }

  /** 把一批逾期作业顺延到指定日期（批量改期） */
  async function reschedule(ids: string[], doneAt: string): Promise<number> {
    if (ids.length === 0) return 0
    const now = Date.now()
    await db.turnings
      .where('id')
      .anyOf(ids)
      .modify((turning) => {
        turning.doneAt = doneAt
        turning.updatedAt = now
      })
    return ids.length
  }

  function typeOptions() {
    return TURNING_TYPES
  }

  return {
    turnings,
    rows,
    filteredRows,
    groupedRows,
    loading,
    ready,
    error,
    today,
    filter,
    sortMode,
    activeBatchId,
    draggingId,
    dragOverId,
    summary,
    todayRows,
    overdueRows,
    batchOf,
    batchLabelOf,
    milkLabelOf,
    setSortMode,
    setActiveBatch,
    patchFilter,
    resetFilter,
    nextSeq,
    createTurning,
    updateTurning,
    removeTurning,
    setState,
    complete,
    skip,
    reopen,
    generatePlan,
    reorder,
    normalizeSeq,
    reschedule,
    typeOptions
  }
})

export type TurningStore = ReturnType<typeof useTurningStore>
