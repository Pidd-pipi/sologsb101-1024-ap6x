import type { Batch } from '@/types/batch'
import type { Shelf } from '@/types/shelf'
import type {
  TransferPlanPreview,
  TransferStep,
  TransferTargetInput
} from '@/types/transfer'

/**
 * 转架编排推演：按窖位容量把整批调拨排成「临时周转 + 落位」的有序步骤。
 *
 * 规则：
 * 1. 每轮优先把「目标窖位仍有余量」的批次直接落位（落位步）；
 * 2. 若所有待调拨批次的目标窖位都满（死锁，典型：两组货架对调），
 *    把「占着别人目标窖位」的批次先挪到一个有余量的临时周转位（临时周转步），
 *    腾出位置后其余批次即可依次落位；
 * 3. 既无法落位又找不到临时周转位时拒绝编排，错误中指明冲突批次与目标窖位。
 *
 * 纯函数：不读写 IndexedDB，容量以调用方传入的批次 / 窖位实时数据为准。
 */
interface PlannerContext {
  batches: Batch[]
  shelves: Shelf[]
}

function shelfLabel(shelf: Shelf): string {
  return `${shelf.room} ${shelf.rackNo} 第 ${shelf.layerNo} 层`
}

function batchLabel(batch: Batch): string {
  return `${batch.cheeseType}批（${batch.curdedAt}）`
}

export function buildTransferPlan(
  targets: TransferTargetInput[],
  ctx: PlannerContext
): TransferPlanPreview {
  const shelfMap = new Map(ctx.shelves.map((shelf) => [shelf.id, shelf]))
  const batchMap = new Map(ctx.batches.map((batch) => [batch.id, batch]))

  // 虚拟占用：以实际挂接批次数兜底 shelf.occupied，避免脏数据导致余量虚高
  const occ = new Map<string, number>()
  ctx.shelves.forEach((shelf) => {
    const hosted = ctx.batches.filter((batch) => batch.shelfId === shelf.id).length
    occ.set(shelf.id, Math.max(shelf.occupied, hosted))
  })
  // 虚拟批次位置：batchId -> 当前窖位（null = 未上架）
  const pos = new Map<string, string | null>()
  ctx.batches.forEach((batch) => pos.set(batch.id, batch.shelfId))

  const pending = new Map<string, string>()
  for (const target of targets) {
    const batch = batchMap.get(target.batchId)
    if (!batch) continue
    if (batch.state === '已出库' || batch.state === '报废') continue
    if (!shelfMap.has(target.targetShelfId)) {
      return {
        ok: false,
        steps: [],
        error: `目标窖位不存在或已删除，请重新选择目标窖位`,
        conflictShelfId: target.targetShelfId
      }
    }
    if (pos.get(target.batchId) !== target.targetShelfId) {
      pending.set(target.batchId, target.targetShelfId)
    }
  }
  if (pending.size === 0) {
    return {
      ok: false,
      steps: [],
      error: '没有需要调拨的批次（目标窖位与当前窖位一致，或批次已出库 / 报废）'
    }
  }

  const steps: TransferStep[] = []

  function freeOf(shelfId: string): number {
    const shelf = shelfMap.get(shelfId)
    if (!shelf) return 0
    return shelf.capacity - (occ.get(shelfId) ?? 0)
  }

  function applyMove(batchId: string, toShelfId: string, kind: TransferStep['kind']): void {
    const fromShelfId = pos.get(batchId) ?? null
    steps.push({
      seq: steps.length + 1,
      batchId,
      fromShelfId,
      toShelfId,
      kind,
      status: '待执行'
    })
    if (fromShelfId) occ.set(fromShelfId, Math.max(0, (occ.get(fromShelfId) ?? 1) - 1))
    occ.set(toShelfId, (occ.get(toShelfId) ?? 0) + 1)
    pos.set(batchId, toShelfId)
  }

  let guard = 0
  while (pending.size > 0) {
    guard += 1
    if (guard > 500) {
      return {
        ok: false,
        steps: [],
        error: '编排推演超过上限（500 步），请缩小调拨范围后分批编排'
      }
    }

    // 第一轮：所有目标窖位有余量的批次直接落位
    let moved = false
    for (const [batchId, targetShelfId] of [...pending]) {
      if (freeOf(targetShelfId) > 0) {
        applyMove(batchId, targetShelfId, '落位')
        pending.delete(batchId)
        moved = true
      }
    }
    if (moved) continue

    // 死锁：优先把「当前窖位正是别人目标」的批次临时周转出去，解开对调 / 循环挪位
    const blockerEntry =
      [...pending].find(([batchId]) => {
        const fromShelfId = pos.get(batchId)
        return fromShelfId !== null && fromShelfId !== undefined && [...pending.values()].includes(fromShelfId)
      }) ?? [...pending][0]
    if (!blockerEntry) {
      // 理论上不会发生：pending 非空时每轮至少能选一个 blocker
      continue
    }
    const [blockerId, blockerTargetId] = blockerEntry
    const blockerBatch = batchMap.get(blockerId)
    if (!blockerBatch) {
      pending.delete(blockerId)
      continue
    }
    const blockerFromId = pos.get(blockerId)

    // 临时周转位：排除目标窖位与当前窖位，优先选「不是任何人目标」的有余量窖位
    const temp = ctx.shelves
      .filter(
        (shelf) =>
          shelf.id !== blockerTargetId && shelf.id !== blockerFromId && freeOf(shelf.id) > 0
      )
      .sort((a, b) => {
        const aIsTarget = [...pending.values()].includes(a.id) ? 1 : 0
        const bIsTarget = [...pending.values()].includes(b.id) ? 1 : 0
        if (aIsTarget !== bIsTarget) return aIsTarget - bIsTarget
        return freeOf(b.id) - freeOf(a.id)
      })[0]

    if (!temp) {
      const targetShelf = shelfMap.get(blockerTargetId)
      const targetOcc = occ.get(blockerTargetId) ?? 0
      // 冲突批次：目标窖位上实际占用的另一个批次（卡住目标的批次）
      const occupant = ctx.batches.find(
        (batch) => batch.shelfId === blockerTargetId && batch.id !== blockerId
      )
      return {
        ok: false,
        steps: [],
        error:
          `容量不足，无法编排：${batchLabel(blockerBatch)} 的目标窖位 ` +
          `${targetShelf ? shelfLabel(targetShelf) : blockerTargetId} 已满` +
          `（${targetOcc}/${targetShelf?.capacity ?? targetOcc}），且没有可用的临时周转窖位。` +
          (occupant
            ? `冲突批次：${batchLabel(occupant)}（占用目标窖位）；`
            : '') +
          `请先腾出余量或分批调拨。`,
        conflictBatchId: occupant?.id ?? blockerId,
        conflictShelfId: blockerTargetId
      }
    }

    applyMove(blockerId, temp.id, '临时周转')
  }

  return { ok: true, steps }
}
