import { computed, type ComputedRef, type Ref } from 'vue'
import type { Batch, BatchAging } from '@/types/batch'
import { addDays, diffDays, round, toDateString } from '@/utils/temperature'

/** 距离可出库日期不足该天数时给出「临近出库」预警 */
export const DUE_SOON_DAYS = 7

export type BatchSource = Ref<Batch[]> | (() => Batch[]) | Batch[]

export interface UseAgingDaysOptions {
  /** 参与计算的批次集合：Ref / getter / 普通数组均可 */
  batches: BatchSource
  /** 参考「今天」，默认取真实当天；传入后可用于固定日期的统计 */
  today?: Ref<string> | string
}

export interface UseAgingDaysResult {
  /** 参考日期（YYYY-MM-DD） */
  today: ComputedRef<string>
  /** 全部批次的熟成派生值 */
  agingList: ComputedRef<BatchAging[]>
  /** batchId → 熟成派生值 */
  agingMap: ComputedRef<Record<string, BatchAging>>
  /** 已到最早可出库日期且仍在熟成中的批次 */
  dueBatches: ComputedRef<BatchAging[]>
  /** 7 天内即将可出库的批次 */
  soonBatches: ComputedRef<BatchAging[]>
  /** 已超期未出库的批次 */
  overdueBatches: ComputedRef<BatchAging[]>
  /** 熟成中的批次平均已熟成天数 */
  avgAgedDays: ComputedRef<number>
  /** 单批次派生值 */
  agingOf: (batch: Batch | undefined | null) => BatchAging | null
  /** 入库日 + 目标天数 → 最早可出库日期 */
  earliestOutAt: (curdedAt: string, targetDays: number) => string
  /** 进度条颜色：超期红 / 到期橙 / 正常绿 */
  progressColor: (aging: BatchAging | null) => string
}

function resolveToday(source: Ref<string> | string | undefined): string {
  if (typeof source === 'string') return source
  if (source) return source.value
  return toDateString(new Date())
}

/**
 * 纯函数：单个批次的熟成派生值（已熟成天数、剩余天数、最早可出库日期、预警）。
 * 无需组件上下文，store 与 hook 共用同一算法。
 */
export function computeAging(batch: Batch, today: string): BatchAging {
  const days = Math.max(0, Math.round(batch.targetDays))
  const earliest = addDays(batch.curdedAt, days)
  const agedDays = Math.max(0, diffDays(batch.curdedAt, today))
  const remainDays = diffDays(today, earliest)
  const progress = days === 0 ? 100 : Math.min(100, Math.round((agedDays / days) * 100))
  const due = remainDays <= 0

  let warning = ''
  if (batch.state === '熟成中') {
    if (remainDays < 0) warning = `已超目标熟成期 ${Math.abs(remainDays)} 天，请尽快安排出库品评`
    else if (remainDays === 0) warning = '今日到达最早可出库日期，可安排出库'
    else if (remainDays <= DUE_SOON_DAYS) warning = `${remainDays} 天后可出库，请提前备好品评`
  } else if (batch.state === '凝乳' && due) {
    warning = '已达目标天数但仍处于凝乳状态，请确认是否上架熟成'
  } else if (batch.state === '已出库') {
    warning = '已出库，可在品评页复核均分'
  }

  return { batchId: batch.id, earliestOutAt: earliest, agedDays, remainDays, progress, due, warning }
}

/** 一组批次的平均已熟成天数（仅统计熟成中批次） */
export function averageAgedDays(batches: Batch[], today: string): number {
  const aging = batches
    .filter((batch) => batch.state === '熟成中')
    .map((batch) => Math.max(0, diffDays(batch.curdedAt, today)))
  if (aging.length === 0) return 0
  return round(aging.reduce((sum, value) => sum + value, 0) / aging.length, 0)
}

/**
 * 批次熟成天数派生 hook：被奶源页（批次表）与品评页（出库提示）共同消费。
 * 支持传入 Ref / getter / 数组，随 Pinia store 的响应式数据自动更新。
 */
export function useAgingDays(options: UseAgingDaysOptions): UseAgingDaysResult {
  const batches = computed<Batch[]>(() => {
    const source = options.batches
    if (typeof source === 'function') return source()
    if (Array.isArray(source)) return source
    return source.value
  })

  const today = computed<string>(() => resolveToday(options.today))

  const earliestOutAt = (curdedAt: string, targetDays: number): string =>
    addDays(curdedAt, Math.max(0, Math.round(targetDays)))

  const agingList = computed<BatchAging[]>(() =>
    batches.value.map((batch) => computeAging(batch, today.value))
  )

  const agingMap = computed<Record<string, BatchAging>>(() => {
    const map: Record<string, BatchAging> = {}
    agingList.value.forEach((aging) => {
      map[aging.batchId] = aging
    })
    return map
  })

  const dueBatches = computed<BatchAging[]>(() =>
    agingList.value.filter((aging) => {
      const batch = batches.value.find((item) => item.id === aging.batchId)
      return Boolean(batch) && aging.due && batch?.state === '熟成中'
    })
  )

  const soonBatches = computed<BatchAging[]>(() =>
    agingList.value.filter((aging) => aging.remainDays > 0 && aging.remainDays <= DUE_SOON_DAYS)
  )

  const overdueBatches = computed<BatchAging[]>(() =>
    agingList.value.filter((aging) => aging.remainDays < 0)
  )

  return {
    today,
    earliestOutAt,
    agingList,
    agingMap,
    dueBatches,
    soonBatches,
    overdueBatches,
    avgAgedDays: computed(() => averageAgedDays(batches.value, today.value)),
    agingOf: (batch) => (batch ? computeAging(batch, today.value) : null),
    progressColor: (aging) => {
      if (!aging) return '#909399'
      if (aging.remainDays < 0) return '#c0392b'
      if (aging.due) return '#d68910'
      return '#1e8449'
    }
  }
}
