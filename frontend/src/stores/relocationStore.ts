import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import {
  ACTIVE_RELOCATION_STATUSES,
  createEmptyRelocationFilter,
  type NewRelocationInput,
  type PlannerConflict,
  type PlannerInput,
  type Relocation,
  type RelocationFilterState,
  type RelocationMove,
  type RelocationStatus,
  type RelocationStep
} from '@/types/relocation'
import type { Turning } from '@/types/turning'
import { useMilkStore } from '@/stores/milkStore'
import { useShelfStore } from '@/stores/shelfStore'
import { formatStepNote, planRelocation, projectionOfPlan } from '@/utils/relocation'
import { toDateString } from '@/utils/temperature'

/** 编排单提交时的并发 / 容量冲突（第二个浏览器窗口提交时收到该错误） */
export class RelocationConflictError extends Error {
  conflicts: PlannerConflict[]
  constructor(conflicts: PlannerConflict[]) {
    super(conflicts.map((item) => item.message).join('；'))
    this.name = 'RelocationConflictError'
    this.conflicts = conflicts
  }
}

export interface RelocationPreview {
  ok: boolean
  message: string
  stepCount: number
  tempCount: number
  tempShelfIds: string[]
  conflicts: PlannerConflict[]
}

/** 单步办理结果 */
export interface ExecuteResult {
  ok: boolean
  message: string
  /** 本步是否已在此之前落地（幂等命中，不重复占位 / 不再生成作业） */
  alreadyDone?: boolean
  conflicts?: PlannerConflict[]
}

/** 正在办理中的编排单（本标签页内存防重，跨标签由 IndexedDB 事务串行保证） */
const inFlightPlans = new Set<string>()

/**
 * 整批调拨转架编排 store：
 * - 创建编排单：在同一个 IndexedDB 读写事务内做「其他在办单投影 + 容量试算」，
 *   两个浏览器窗口同时提交时后提交方一定收到 RelocationConflictError；
 * - 逐步办理：批次窖位、窖位占用、转架作业与编排步骤在同一事务内同步写回；
 * - 失败恢复：失败原因与步骤状态持久化，刷新页面后可从未完成队列续办。
 */
export const useRelocationStore = defineStore('relocation', () => {
  const table = useIdbTable<Relocation>((database) => database.relocations)
  const milkStore = useMilkStore()
  const shelfStore = useShelfStore()

  const filter = ref<RelocationFilterState>(createEmptyRelocationFilter())
  const plans = computed<Relocation[]>(() =>
    table.rows.value.slice().sort((a, b) => b.createdAt - a.createdAt)
  )
  const loading = computed(() => table.loading.value)
  const ready = computed(() => table.ready.value)
  const error = computed(() => table.error.value)

  function batchLabelOf(batchId: string): string {
    const batch = milkStore.batches.find((item) => item.id === batchId)
    if (!batch) return `批次 ${batchId}`
    return `${milkStore.milkNameOf(batch.milkId)} · ${batch.cheeseType} ${batch.curdedAt}`
  }

  function planOf(id: string): Relocation | undefined {
    return plans.value.find((item) => item.id === id)
  }

  function nextPendingStep(plan: Relocation): RelocationStep | null {
    return plan.steps.find((step) => step.state === '待执行' || step.state === '失败') ?? null
  }

  /** 仍占用资源、需要办理（或续办）的编排单 */
  const activePlans = computed<Relocation[]>(() =>
    plans.value.filter((plan) => ACTIVE_RELOCATION_STATUSES.includes(plan.status))
  )

  const statusCounts = computed<Record<RelocationStatus, number>>(() => {
    const counts: Record<RelocationStatus, number> = {
      待执行: 0,
      执行中: 0,
      已完成: 0,
      已失败: 0,
      已取消: 0
    }
    plans.value.forEach((plan) => {
      counts[plan.status] += 1
    })
    return counts
  })

  const filteredPlans = computed<Relocation[]>(() =>
    plans.value.filter((plan) => {
      if (
        filter.value.statuses.length > 0 &&
        !filter.value.statuses.includes(plan.status)
      ) {
        return false
      }
      const keyword = filter.value.keyword.trim()
      if (keyword.length === 0) return true
      const haystack = [
        plan.title,
        plan.operator,
        plan.status,
        ...plan.batchIds.map((id) => batchLabelOf(id)),
        ...plan.shelfIds.map((id) => shelfStore.shelfLabel(id))
      ].join('')
      return haystack.includes(keyword)
    })
  )

  function patchFilter(patch: Partial<RelocationFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyRelocationFilter()
  }

  /** 组装规划器入参：基于 store 缓存的现状 + 指定的其他在办单投影 */
  function buildPlannerInput(
    moves: RelocationMove[],
    others: Relocation[] = activePlans.value
  ): PlannerInput {
    return {
      batches: milkStore.batches.map((batch) => ({ id: batch.id, shelfId: batch.shelfId })),
      shelves: shelfStore.shelves.map((shelf) => ({ id: shelf.id, capacity: shelf.capacity })),
      others: others.map(projectionOfPlan),
      moves
    }
  }

  /** 不写库的容量 / 顺序预演，供新建对话框实时提示 */
  function previewPlan(moves: RelocationMove[]): RelocationPreview {
    const result = planRelocation(buildPlannerInput(moves))
    return {
      ok: result.ok,
      message: result.message,
      stepCount: result.steps.length,
      tempCount: result.steps.filter((step) => step.temporary).length,
      tempShelfIds: result.tempShelfIds,
      conflicts: result.conflicts
    }
  }

  /**
   * 确认创建编排单：冲突检查与落库放在同一个读写事务里。
   * IndexedDB 事务在同一源的多个标签页之间严格串行，因此两个窗口同时提交时，
   * 后提交方读到的一定是先提交方已落库的在办单，并收到冲突结果。
   */
  async function createPlan(input: NewRelocationInput): Promise<Relocation> {
    const moves = input.moves.filter((move) => move.batchId && move.toShelfId)
    if (moves.length === 0) throw new Error('请至少添加一条「批次 → 目标窖位」的调拨意向')

    const now = Date.now()
    let created: Relocation | null = null

    await db.transaction(
      'rw',
      [db.relocations, db.batches, db.shelves],
      async () => {
        const [active, allBatches, allShelves] = await Promise.all([
          db.relocations
            .where('status')
            .anyOf(ACTIVE_RELOCATION_STATUSES)
            .toArray(),
          db.batches.toArray(),
          db.shelves.toArray()
        ])

        // 结构性校验：批次状态不能再调拨
        const batchMap = new Map(allBatches.map((batch) => [batch.id, batch]))
        for (const move of moves) {
          const batch = batchMap.get(move.batchId)
          if (!batch) throw new Error(`批次 ${move.batchId} 不存在，请刷新后重试`)
          if (batch.state === '已出库' || batch.state === '报废') {
            throw new Error(`批次「${batch.cheeseType} ${batch.curdedAt}」状态为「${batch.state}」，不能再转架`)
          }
        }

        const plannerInput: PlannerInput = {
          batches: allBatches.map((batch) => ({ id: batch.id, shelfId: batch.shelfId })),
          shelves: allShelves.map((shelf) => ({ id: shelf.id, capacity: shelf.capacity })),
          others: active.map(projectionOfPlan),
          moves
        }
        const planned = planRelocation(plannerInput)
        if (!planned.ok) throw new RelocationConflictError(planned.conflicts)

        const steps: RelocationStep[] = planned.steps.map((draft) => ({
          seq: draft.seq,
          batchId: draft.batchId,
          fromShelfId: draft.fromShelfId,
          toShelfId: draft.toShelfId,
          temporary: draft.temporary,
          note: formatStepNote(draft, batchLabelOf, shelfStore.shelfLabel),
          state: '待执行',
          turningId: null,
          doneAt: null,
          executedAt: null,
          failReason: '',
          failedAt: null
        }))
        const batchIds = Array.from(new Set(steps.map((step) => step.batchId)))
        const shelfIds = Array.from(
          new Set(
            steps.flatMap((step) => [step.toShelfId, ...(step.fromShelfId ? [step.fromShelfId] : [])])
          )
        )

        created = {
          id: createId('relo'),
          title: input.title.trim() || `整批调拨 ${toDateString(new Date())}`,
          operator: input.operator.trim(),
          plannedAt: input.plannedAt,
          turningType: input.turningType,
          brinePct: input.brinePct,
          status: '待执行',
          batchIds,
          shelfIds,
          steps,
          failReason: '',
          createdAt: now,
          updatedAt: now,
          confirmedAt: now,
          completedAt: null
        }
        await db.relocations.put(created)
      }
    )

    if (!created) throw new Error('编排单创建失败，请重试')
    return created
  }

  /**
   * 办理单个步骤（可对失败步骤重试）。
   * 批次窖位、窖位占用、转架作业、步骤状态在同一事务内写回：
   * - 已完成的步骤幂等命中，不重复占位、不再生成作业；
   * - 事务失败时回滚业务写入，随后把失败原因持久化到编排单，供续办。
   */
  async function executeStep(planId: string, seq: number): Promise<ExecuteResult> {
    const plan = await db.relocations.get(planId)
    if (!plan) return { ok: false, message: '编排单不存在，可能已被删除' }
    const step = plan.steps.find((item) => item.seq === seq)
    if (!step) return { ok: false, message: `第 ${seq} 步不存在` }
    if (step.state === '已取消') return { ok: false, message: '该步骤已随编排单取消，不能办理' }
    if (step.state === '已完成') {
      return { ok: true, alreadyDone: true, message: `第 ${seq} 步此前已落地，跳过不重复办理` }
    }
    if (plan.status === '已取消' || plan.status === '已完成') {
      return { ok: false, message: `编排单已${plan.status}，不能再办理` }
    }
    // 前序步骤必须先完成，保证按执行顺序逐步办理
    const blocker = plan.steps.find(
      (item) => item.seq < seq && item.state !== '已完成'
    )
    if (blocker) {
      return {
        ok: false,
        message: `请先办理第 ${blocker.seq} 步（${blocker.temporary ? '临时中转' : '正式转架'}），再执行本步`
      }
    }
    if (inFlightPlans.has(planId)) {
      return { ok: false, message: '该编排单正在办理中，请勿重复提交' }
    }
    inFlightPlans.add(planId)

    try {
      await db.transaction(
        'rw',
        [db.relocations, db.batches, db.shelves, db.turnings],
        async () => {
          // 事务内重读最新状态，防止两个窗口/手动操作导致脏写
          const [livePlan, batch, toShelf] = await Promise.all([
            db.relocations.get(planId),
            db.batches.get(step.batchId),
            db.shelves.get(step.toShelfId)
          ])
          if (!livePlan) throw new Error('编排单已被删除')
          const liveStep = livePlan.steps.find((item) => item.seq === seq)
          if (!liveStep) throw new Error(`第 ${seq} 步不存在`)
          if (liveStep.state === '已完成') return
          if (!batch) throw new Error(`批次 ${step.batchId} 已被删除，无法办理`)
          if (batch.state === '已出库' || batch.state === '报废') {
            throw new Error(`批次状态已变为「${batch.state}」，不能再转架`)
          }
          if (!toShelf) throw new Error(`目标窖位 ${step.toShelfId} 已被删除`)
          // 批次当前必须确实在步骤记录的源窖位（或尚未上架），否则说明队列与现状脱节
          if (batch.shelfId !== step.fromShelfId) {
            throw new Error(
              `批次当前窖位与编排不一致（当前：${batch.shelfId ?? '未上架'}，本步源位：${
                step.fromShelfId ?? '未上架'
              }），请核对后再续办`
            )
          }

          const hostedOnTarget = await db.batches
            .where('shelfId')
            .equals(step.toShelfId)
            .count()
          if (hostedOnTarget >= toShelf.capacity) {
            throw new Error(
              `目标窖位已满（${hostedOnTarget}/${toShelf.capacity}），可能被其他在办编排或手动上架占用，请稍后重试`
            )
          }

          const now = Date.now()
          // 转架作业幂等键：步骤的 turningId 已存在则不再生成新作业
          let turningId = liveStep.turningId
          if (!turningId) {
            const existingTurnings = await db.turnings.where('batchId').equals(step.batchId).toArray()
            const nextSeq = existingTurnings.reduce((max, item) => Math.max(max, item.seq), 0) + 1
            turningId = createId('turn')
            const turning: Turning = {
              id: turningId,
              batchId: step.batchId,
              shelfId: step.toShelfId,
              doneAt: livePlan.plannedAt,
              type: livePlan.turningType,
              brinePct: livePlan.brinePct,
              operator: livePlan.operator,
              state: '已完成',
              seq: nextSeq,
              relocationId: livePlan.id,
              relocationStepSeq: step.seq,
              createdAt: now,
              updatedAt: now
            }
            await db.turnings.put(turning)
          }

          // 批次窖位回写
          await db.batches.update(step.batchId, {
            shelfId: step.toShelfId,
            state: batch.state === '凝乳' ? '熟成中' : batch.state,
            updatedAt: now
          })

          // 窖位占用按实际在架批次数重算（源位释放、目标位占位一次写准）
          const affected = [step.toShelfId, ...(step.fromShelfId ? [step.fromShelfId] : [])]
          for (const shelfId of Array.from(new Set(affected))) {
            const shelf = await db.shelves.get(shelfId)
            if (!shelf) continue
            const hosted = await db.batches.where('shelfId').equals(shelfId).count()
            await db.shelves.update(shelfId, {
              occupied: Math.max(0, Math.min(shelf.capacity, hosted)),
              updatedAt: now
            })
          }

          // 编排步骤状态写回
          const nextSteps = livePlan.steps.map((item) =>
            item.seq === seq
              ? {
                  ...item,
                  state: '已完成' as const,
                  turningId,
                  doneAt: livePlan.plannedAt,
                  executedAt: now,
                  failReason: '',
                  failedAt: null
                }
              : item
          )
          const allDone = nextSteps.every((item) =>
            item.state === '已完成' || item.state === '已取消'
          ) && nextSteps.some((item) => item.state === '已完成')
          await db.relocations.update(planId, {
            steps: nextSteps,
            status: allDone ? '已完成' : '执行中',
            failReason: '',
            completedAt: allDone ? now : null,
            updatedAt: now
          })
        }
      )
      return {
        ok: true,
        message: `第 ${seq} 步已办理：批次窖位、窖位占用与转架作业已同步写回`
      }
    } catch (err) {
      // 业务事务已回滚；此处仅持久化失败原因（不覆盖业务数据），供恢复后续办
      const reason = err instanceof Error ? err.message : '办理失败，请重试'
      await persistFailure(planId, seq, reason)
      return { ok: false, message: reason }
    } finally {
      inFlightPlans.delete(planId)
    }
  }

  /** 把失败原因写入步骤与编排单（独立事务，失败信息也保存在本地） */
  async function persistFailure(planId: string, seq: number, reason: string): Promise<void> {
    try {
      const now = Date.now()
      const livePlan = await db.relocations.get(planId)
      if (!livePlan) return
      const nextSteps = livePlan.steps.map((item) =>
        item.seq === seq && item.state !== '已完成'
          ? { ...item, state: '失败' as const, failReason: reason, failedAt: now }
          : item
      )
      await db.relocations.update(planId, {
        steps: nextSteps,
        status: '已失败',
        failReason: `第 ${seq} 步失败：${reason}`,
        updatedAt: now
      })
    } catch {
      // 失败原因写不进去时保持原状态，交由页面重试
    }
  }

  /** 续办：从第一个未完成（待执行 / 失败）步骤开始逐步办理，遇到失败立即停下 */
  async function resumePlan(planId: string): Promise<{ executed: number; result: ExecuteResult | null }> {
    const plan = await db.relocations.get(planId)
    if (!plan) return { executed: 0, result: { ok: false, message: '编排单不存在' } }
    let executed = 0
    let guard = 0
    // 每办一步 plan 都会变化，循环内重读直到没有未完成步骤或办理失败
    while (guard < plan.steps.length + 2) {
      guard += 1
      const current = await db.relocations.get(planId)
      if (!current) break
      const step = nextPendingStep(current)
      if (!step) break
      const result = await executeStep(planId, step.seq)
      if (!result.ok) return { executed, result }
      if (!result.alreadyDone) executed += 1
    }
    return { executed, result: null }
  }

  /** 取消编排单：未完成步骤标记为已取消；已落地步骤保持不变，不回滚实物 */
  async function cancelPlan(planId: string): Promise<void> {
    const now = Date.now()
    const livePlan = await db.relocations.get(planId)
    if (!livePlan) return
    if (livePlan.status === '已完成' || livePlan.status === '已取消') return
    const nextSteps = livePlan.steps.map((step) =>
      step.state === '已完成'
        ? step
        : { ...step, state: '已取消' as const, failReason: step.failReason || '编排单已取消' }
    )
    await db.relocations.update(planId, {
      steps: nextSteps,
      status: '已取消',
      failReason: livePlan.failReason || '用户取消编排，未完成步骤作废（已落地步骤保留）',
      updatedAt: now
    })
  }

  /** 删除编排单：仅已完成 / 已取消的终态单可删（在办单需先取消或办理完） */
  async function removePlan(planId: string): Promise<void> {
    const livePlan = await db.relocations.get(planId)
    if (!livePlan) return
    if (ACTIVE_RELOCATION_STATUSES.includes(livePlan.status)) {
      throw new Error('在办编排单不能删除，请先办理完成或取消')
    }
    await db.relocations.delete(planId)
  }

  /** 单批次档案导出用：步骤中涉及该批次的编排单 */
  async function plansOfBatch(batchId: string): Promise<Relocation[]> {
    const all = await db.relocations.toArray()
    return all.filter((plan) => plan.steps.some((step) => step.batchId === batchId))
  }

  /** 某批次是否还被在办编排单占用（删除批次 / 奶源前的硬校验） */
  function activePlanHoldingBatch(batchId: string): Relocation | null {
    const holder = activePlans.value.find(
      (plan) =>
        plan.batchIds.includes(batchId) &&
        plan.steps.some((step) => step.state !== '已完成' && step.state !== '已取消')
    )
    return holder ?? null
  }

  /** 某窖位是否还被在办编排单的未完成步骤使用（删除窖位前的硬校验） */
  function activePlanHoldingShelf(shelfId: string): Relocation | null {
    return (
      activePlans.value.find((plan) =>
        plan.steps.some(
          (step) =>
            step.state !== '已完成' &&
            step.state !== '已取消' &&
            (step.toShelfId === shelfId || step.fromShelfId === shelfId)
        )
      ) ?? null
    )
  }

  return {
    plans,
    activePlans,
    filteredPlans,
    statusCounts,
    loading,
    ready,
    error,
    filter,
    batchLabelOf,
    planOf,
    nextPendingStep,
    patchFilter,
    resetFilter,
    previewPlan,
    buildPlannerInput,
    createPlan,
    executeStep,
    resumePlan,
    cancelPlan,
    removePlan,
    plansOfBatch,
    activePlanHoldingBatch,
    activePlanHoldingShelf
  }
})

export type RelocationStore = ReturnType<typeof useRelocationStore>
