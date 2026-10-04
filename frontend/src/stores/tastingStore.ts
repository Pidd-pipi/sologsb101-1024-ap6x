import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, readLastBackupAt, stampBackupTime } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  averageScore,
  createEmptyTastingFilter,
  scoreToConclusion,
  type BatchScore,
  type Tasting,
  type TastingConclusion,
  type TastingFilterState
} from '@/types/tasting'
import type { Batch } from '@/types/batch'
import { useMilkStore } from '@/stores/milkStore'
import { round } from '@/utils/temperature'

export interface NewTastingInput {
  batchId: string
  outAt: string
  appearance: string
  flavor: string
  texture: string
  appearanceScore: number
  flavorScore: number
  textureScore: number
  taster: string
}

/** 品评行：品评 + 批次 + 奶源名回显 */
export interface TastingRow {
  tasting: Tasting
  batch: Batch | null
  batchLabel: string
  milkLabel: string
}

/**
 * 品评 store：维护品评记录、批次均分派生值与「均分回写批次结论」。
 * 同时提供全量 JSON 导入导出的落地能力（文件下载由 utils/export.ts 负责）。
 */
export const useTastingStore = defineStore('tasting', () => {
  const tastingsTable = useIdbTable<Tasting>((database) => database.tastings)
  const milkStore = useMilkStore()

  const filter = ref<TastingFilterState>(createEmptyTastingFilter())
  const lastBackupAt = ref<string | null>(readLastBackupAt())
  const busy = ref(false)

  const tastings = computed<Tasting[]>(() => tastingsTable.rows.value)
  const loading = computed(() => tastingsTable.loading.value)
  const ready = computed(() => tastingsTable.ready.value)
  const error = computed(() => tastingsTable.error.value)
  const batches = computed<Batch[]>(() => milkStore.batches)

  /** 同批次均分与各维度均分，用于回写批次结论 */
  const batchScores = computed<BatchScore[]>(() => {
    const grouped = new Map<string, Tasting[]>()
    tastings.value.forEach((tasting) => {
      const bucket = grouped.get(tasting.batchId) ?? []
      bucket.push(tasting)
      grouped.set(tasting.batchId, bucket)
    })
    const result: BatchScore[] = []
    grouped.forEach((list, batchId) => {
      const avg = (pick: (item: Tasting) => number): number =>
        round(list.reduce((sum, item) => sum + pick(item), 0) / list.length, 1)
      const avgScore = avg((item) => item.score)
      result.push({
        batchId,
        count: list.length,
        avgScore,
        conclusion: scoreToConclusion(avgScore),
        avgAppearance: avg((item) => item.appearanceScore),
        avgFlavor: avg((item) => item.flavorScore),
        avgTexture: avg((item) => item.textureScore),
        lastOutAt:
          list
            .map((item) => item.outAt)
            .sort((a, b) => b.localeCompare(a))[0] ?? ''
      })
    })
    return result.sort((a, b) => b.avgScore - a.avgScore)
  })

  const batchScoreMap = computed<Record<string, BatchScore>>(() => {
    const map: Record<string, BatchScore> = {}
    batchScores.value.forEach((score) => {
      map[score.batchId] = score
    })
    return map
  })

  const rows = computed<TastingRow[]>(() =>
    tastings.value.map((tasting) => {
      const batch = batches.value.find((item) => item.id === tasting.batchId) ?? null
      return {
        tasting,
        batch,
        batchLabel: batch ? `${batch.cheeseType} · ${batch.curdedAt}` : '批次已删除',
        milkLabel: batch ? milkStore.milkNameOf(batch.milkId) : '—'
      }
    })
  )

  /** 关键字 + 批次多选 + 结论多选过滤 */
  const filteredRows = computed<TastingRow[]>(() =>
    rows.value.filter((row) => {
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${row.tasting.appearance}${row.tasting.flavor}${row.tasting.texture}${row.tasting.taster}${row.tasting.conclusion}${row.batchLabel}${row.milkLabel}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.batchIds.length > 0 && !filter.value.batchIds.includes(row.tasting.batchId)) {
        return false
      }
      if (
        filter.value.conclusions.length > 0 &&
        !filter.value.conclusions.includes(row.tasting.conclusion)
      ) {
        return false
      }
      return true
    })
  )

  const avgScore = computed(() =>
    tastings.value.length === 0
      ? 0
      : round(
          tastings.value.reduce((sum, tasting) => sum + tasting.score, 0) / tastings.value.length,
          1
        )
  )

  const conclusionCounts = computed<Record<TastingConclusion, number>>(() => {
    const counts: Record<TastingConclusion, number> = { 优: 0, 合格: 0, 待改进: 0 }
    tastings.value.forEach((tasting) => {
      counts[tasting.conclusion] += 1
    })
    return counts
  })

  const excellentPercent = computed(() =>
    tastings.value.length === 0
      ? 0
      : Math.round((conclusionCounts.value['优'] / tastings.value.length) * 100)
  )

  /** 待品评的批次：已出库但尚无品评记录 */
  const pendingBatches = computed<Batch[]>(() =>
    batches.value.filter(
      (batch) =>
        batch.state === '已出库' && !tastings.value.some((tasting) => tasting.batchId === batch.id)
    )
  )

  function tastingsOf(batchId: string): Tasting[] {
    return tastings.value
      .filter((tasting) => tasting.batchId === batchId)
      .sort((a, b) => b.outAt.localeCompare(a.outAt))
  }

  function scoreOf(batchId: string): BatchScore | null {
    return batchScoreMap.value[batchId] ?? null
  }

  function setLastBackupAt(iso: string | null): void {
    lastBackupAt.value = iso
  }

  function markBackupNow(): void {
    const iso = new Date().toISOString()
    stampBackupTime(iso)
    lastBackupAt.value = iso
  }

  function patchFilter(patch: Partial<TastingFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyTastingFilter()
  }

  async function createTasting(payload: NewTastingInput): Promise<Tasting> {
    const score = averageScore(payload.appearanceScore, payload.flavorScore, payload.textureScore)
    const tasting = await tastingsTable.create(
      { ...payload, score, conclusion: scoreToConclusion(score) },
      'tast'
    )
    await syncBatchConclusion(payload.batchId)
    return tasting
  }

  async function updateTasting(id: string, patch: Partial<Tasting>): Promise<void> {
    const current = tastings.value.find((item) => item.id === id)
    if (!current) return
    const merged: Partial<Tasting> = { ...patch }
    if (
      patch.appearanceScore !== undefined ||
      patch.flavorScore !== undefined ||
      patch.textureScore !== undefined
    ) {
      const score = averageScore(
        patch.appearanceScore ?? current.appearanceScore,
        patch.flavorScore ?? current.flavorScore,
        patch.textureScore ?? current.textureScore
      )
      merged.score = score
      merged.conclusion = scoreToConclusion(score)
    }
    await tastingsTable.update(id, merged)
    await syncBatchConclusion(current.batchId)
  }

  async function removeTasting(id: string): Promise<void> {
    const tasting = tastings.value.find((item) => item.id === id)
    await tastingsTable.remove(id)
    if (tasting) await syncBatchConclusion(tasting.batchId)
  }

  /**
   * 均分回写批次结论：按同批次均分换算 优 / 合格 / 待改进；
   * 该批次已无品评记录时清空结论。
   */
  async function syncBatchConclusion(batchId: string): Promise<string> {
    const scores = await db.tastings.where('batchId').equals(batchId).toArray()
    if (scores.length === 0) {
      await milkStore.setBatchConclusion(batchId, '')
      return ''
    }
    const avg = scores.reduce((sum, item) => sum + item.score, 0) / scores.length
    const conclusion = scoreToConclusion(round(avg, 1))
    await milkStore.setBatchConclusion(batchId, conclusion)
    return conclusion
  }

  /** 对所有有品评记录的批次重算结论 */
  async function syncAllConclusions(): Promise<number> {
    const batchIds = Array.from(new Set(tastings.value.map((tasting) => tasting.batchId)))
    for (const batchId of batchIds) {
      await syncBatchConclusion(batchId)
    }
    return batchIds.length
  }

  return {
    tastings,
    rows,
    filteredRows,
    loading,
    ready,
    error,
    filter,
    busy,
    lastBackupAt,
    batchScores,
    batchScoreMap,
    avgScore,
    conclusionCounts,
    excellentPercent,
    pendingBatches,
    tastingsOf,
    scoreOf,
    setLastBackupAt,
    markBackupNow,
    patchFilter,
    resetFilter,
    createTasting,
    updateTasting,
    removeTasting,
    syncBatchConclusion,
    syncAllConclusions
  }
})

export type TastingStore = ReturnType<typeof useTastingStore>
