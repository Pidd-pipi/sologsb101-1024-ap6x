import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { buildTransferPlan } from '@/utils/transferPlanner'
import {
  acquireOrchestrationLock,
  heartbeatOrchestrationLock,
  notifyTransfersChanged,
  onTransfersChanged,
  refreshOrchestrationLock,
  releaseOrchestrationLock
} from '@/utils/transferSync'
import type {
  TransferPlan,
  TransferPlanPreview,
  TransferTargetInput
} from '@/types/transfer'
import { useMilkStore } from '@/stores/milkStore'
import { useShelfStore } from '@/stores/shelfStore'
import { toDateString } from '@/utils/temperature'

export interface PlanProgress {
  total: number
  landed: number
  failed: number
  pending: number
  percent: number
}

/** 编排单执行引擎：逐步落地、失败保留队列、续办幂等、跨标签页互斥 */
export const useTransferStore = defineStore('transfer', () => {
  const table = useIdbTable<TransferPlan>((database) => database.transferPlans, {
    sortByUpdatedAt: false
  })
  const milkStore = useMilkStore()
  const shelfStore = useShelfStore()

  const plans = computed<TransferPlan[]>(() =>
    [...table.rows.value].sort((a, b) => b.createdAt - a.createdAt)
  )
  const ready = computed(() => table.ready.value)

  /** 本标签页正在执行的编排单 id */
  const runningId = ref<string | null>(null)
  /** 其他标签页持有编排锁时为 true（后提交一方收到冲突结果） */
  const lockHeldByOther = ref(false)
  const lockPlanId = ref<string | null>(null)

  /** 按当前窖位容量推演编排方案（纯函数，不落库） */
  function preview(targets: TransferTargetInput[]): TransferPlanPreview {
    return buildTransferPlan(targets, {
      batches: milkStore.batches,
      shelves: shelfStore.shelves
    })
  }

  /** 保存编排单：先推演，容量不足时拒绝落库并抛出冲突批次 / 目标窖位 */
  async function createPlan(input: {
    title: string
    operator: string
    note: string
    targets: TransferTargetInput[]
  }): Promise<TransferPlan> {
    const result = preview(input.targets)
    if (!result.ok) {
      throw new Error(result.error ?? '编排方案不可行')
    }
    const now = Date.now()
    const plan: TransferPlan = {
      id: createId('trplan'),
      code: `ZB${now.toString(36).toUpperCase()}`,
      title: input.title.trim() || '未命名编排',
      status: '已编排',
      steps: result.steps,
      operator: input.operator.trim() || '系统编排',
      note: input.note,
      createdAt: now,
      updatedAt: now
    }
    await table.create(plan)
    notifyTransfersChanged()
    return plan
  }

  async function patchPlan(id: string, patch: Partial<TransferPlan>): Promise<void> {
    await table.update(id, patch)
  }

  /**
   * 落地单步：一个事务内同步回写「批次窖位 + 窖位占用 + 转架作业」。
   * 步骤已落地时直接返回——不重复占位、不再生成作业（转架作业用确定性 id）。
   * 事务抛出则整步回滚，由 run() 标记失败原因，队列保留待续办。
   */
  async function landStep(planId: string, seq: number): Promise<void> {
    await db.transaction(
      'rw',
      [db.transferPlans, db.shelves, db.batches, db.turnings],
      async () => {
        const plan = await db.transferPlans.get(planId)
        if (!plan) throw new Error('编排单不存在')
        const step = plan.steps.find((item) => item.seq === seq)
        if (!step) throw new Error('执行步骤不存在')
        if (step.status === '已落地') return

        const batch = await db.batches.get(step.batchId)
        if (!batch) throw new Error('批次不存在或已删除，无法继续')
        if (batch.state === '已出库' || batch.state === '报废') {
          throw new Error(`批次已${batch.state}，无法调拨`)
        }
        const to = await db.shelves.get(step.toShelfId)
        if (!to) throw new Error('目标窖位不存在或已删除')

        // 目标窖位余量以数据库实时占用为准
        const hosted = await db.batches.where('shelfId').equals(to.id).count()
        const occ = Math.max(to.occupied, hosted)
        if (occ >= to.capacity) {
          throw new Error(`目标窖位已满（${occ}/${to.capacity}），请调整后续办`)
        }

        const now = Date.now()
        // 释放源窖位：以批次实时挂接的窖位为准（计划生成后若被手动挪过，也不会重复占位）
        const actualFromId = batch.shelfId
        if (actualFromId) {
          const from = await db.shelves.get(actualFromId)
          if (from) {
            const remaining = await db.batches
              .where('shelfId')
              .equals(from.id)
              .and((item) => item.id !== batch.id)
              .count()
            await db.shelves.update(from.id, {
              occupied: Math.max(0, Math.min(from.capacity, remaining)),
              updatedAt: now
            })
          }
        }
        await db.shelves.update(to.id, {
          occupied: Math.min(to.capacity, occ + 1),
          updatedAt: now
        })
        await db.batches.update(batch.id, {
          shelfId: to.id,
          state: batch.state === '凝乳' ? '熟成中' : batch.state,
          updatedAt: now
        })

        // 转架作业：确定性 id（tr_编排单_步骤序），崩溃后重试 put 同 id 不重复生成
        const turningId = `turn_transfer_${plan.id}_${step.seq}`
        const existing = await db.turnings.get(turningId)
        const turningCount = await db.turnings.where('batchId').equals(batch.id).count()
        await db.turnings.put({
          id: turningId,
          batchId: batch.id,
          shelfId: to.id,
          doneAt: toDateString(new Date()),
          type: '转架',
          brinePct: 0,
          operator: plan.operator,
          state: '已完成',
          seq: existing?.seq ?? turningCount + 1,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now
        })

        step.fromShelfId = actualFromId ?? null
        step.status = '已落地'
        step.landedAt = now
        step.turningId = turningId
        step.failReason = ''
        plan.status = '执行中'
        plan.updatedAt = now
        await db.transferPlans.put(plan)
      }
    )
  }

  /** 把执行失败的步骤标记为失败并持久化原因（独立事务，与上一步的回滚互不影响） */
  async function markFailed(planId: string, seq: number, reason: string): Promise<void> {
    await db.transaction('rw', db.transferPlans, async () => {
      const plan = await db.transferPlans.get(planId)
      if (!plan) return
      const step = plan.steps.find((item) => item.seq === seq)
      if (step && step.status !== '已落地') {
        step.status = '失败'
        step.failReason = reason
      }
      plan.status = '已失败'
      plan.updatedAt = Date.now()
      await db.transferPlans.put(plan)
    })
  }

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  function startHeartbeat(): void {
    if (heartbeatTimer) return
    heartbeatTimer = setInterval(() => void heartbeatOrchestrationLock(), 15_000)
  }
  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  /**
   * 执行 / 续办编排单：
   * - 先抢全局编排锁，抢不到返回 conflict（后提交一方收到冲突结果）；
   * - 逐步落地，已落地步骤自动跳过；
   * - 任一步失败即停，失败原因落库，队列保留，可续办。
   */
  async function run(
    planId: string
  ): Promise<{ ok: boolean; conflict?: boolean; error?: string }> {
    const plan = await table.getById(planId)
    if (!plan) return { ok: false, error: '编排单不存在' }
    if (plan.status === '已完成') return { ok: true }
    if (plan.status === '已取消') return { ok: false, error: '编排单已取消' }

    const lock = await acquireOrchestrationLock(plan.id)
    if (!lock.ok) {
      return {
        ok: false,
        conflict: true,
        error: `提交冲突：另一窗口（${lock.heldBy ?? '其他窗口'}）正在执行编排单，请等待其完成后再提交`
      }
    }

    runningId.value = plan.id
    startHeartbeat()
    let failedSeq = 0
    try {
      await patchPlan(plan.id, { status: '执行中', startedAt: plan.startedAt ?? Date.now() })
      notifyTransfersChanged()
      for (const step of plan.steps) {
        if (step.status === '已落地') continue
        failedSeq = step.seq
        await landStep(plan.id, step.seq)
        notifyTransfersChanged()
        // 步骤间稍作停顿，便于页面观察逐步落地过程
        await new Promise((resolve) => setTimeout(resolve, 120))
      }
      await patchPlan(plan.id, { status: '已完成', finishedAt: Date.now() })
      notifyTransfersChanged()
      return { ok: true }
    } catch (err) {
      const reason = err instanceof Error ? err.message : '执行失败'
      await markFailed(plan.id, failedSeq, reason)
      notifyTransfersChanged()
      return { ok: false, error: reason }
    } finally {
      stopHeartbeat()
      runningId.value = null
      await releaseOrchestrationLock()
      notifyTransfersChanged()
    }
  }

  async function cancel(planId: string): Promise<void> {
    const plan = await table.getById(planId)
    if (!plan || plan.status === '已完成') return
    await patchPlan(planId, { status: '已取消' })
    if (runningId.value === planId) {
      stopHeartbeat()
      runningId.value = null
      await releaseOrchestrationLock()
    }
    notifyTransfersChanged()
  }

  async function remove(planId: string): Promise<void> {
    await table.remove(planId)
    notifyTransfersChanged()
  }

  async function refreshLockState(): Promise<void> {
    const state = await refreshOrchestrationLock()
    lockHeldByOther.value = state.heldByOther
    lockPlanId.value = state.planId ?? null
  }

  // 跨标签页同步：其他窗口落地后刷新列表与锁状态
  onTransfersChanged(() => {
    void table.refresh()
    void refreshLockState()
  })
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', () => {
      void table.refresh()
      void refreshLockState()
    })
    window.addEventListener('pagehide', () => {
      void releaseOrchestrationLock()
    })
    void refreshLockState()
    setInterval(() => void refreshLockState(), 10_000)
  }

  function progressOf(plan: TransferPlan): PlanProgress {
    const total = plan.steps.length
    const landed = plan.steps.filter((step) => step.status === '已落地').length
    const failed = plan.steps.filter((step) => step.status === '失败').length
    return {
      total,
      landed,
      failed,
      pending: total - landed,
      percent: total === 0 ? 0 : Math.round((landed / total) * 100)
    }
  }

  /** 失败的编排单、或本窗口崩溃遗留的「执行中」编排单都可续办 */
  function isResumable(plan: TransferPlan): boolean {
    if (plan.status === '已失败') return true
    if (plan.status === '执行中' && runningId.value !== plan.id && !lockHeldByOther.value) {
      return true
    }
    return false
  }

  return {
    plans,
    ready,
    runningId,
    lockHeldByOther,
    lockPlanId,
    preview,
    createPlan,
    run,
    cancel,
    remove,
    refreshLockState,
    progressOf,
    isResumable
  }
})

export type TransferStore = ReturnType<typeof useTransferStore>
