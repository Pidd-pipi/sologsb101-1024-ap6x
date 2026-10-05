import type {
  ActivePlanProjection,
  PlannerBatch,
  PlannerCapacityConflict,
  PlannerConflict,
  PlannerInput,
  PlannerResult,
  PlannerShelf,
  Relocation,
  RelocationMove,
  RelocationStepDraft
} from '@/types/relocation'

/** 规划器迭代上限：每批最多「一次中转 + 一次到位」，再留一档余量防止环路 */
function stepLimit(moveCount: number): number {
  return Math.max(8, moveCount * 4 + 4)
}

function dedupe<T>(list: T[]): T[] {
  return Array.from(new Set(list))
}

/**
 * 由一张已存在的编排单推导其「全部落地后」的资源占用投影：
 * 每个批次最终落在其最后一个步骤的目标窖位，过程中碰过的窖位（含临时位）全部计入。
 */
export function projectionOfPlan(plan: Relocation): ActivePlanProjection {
  const finalBatchShelf: Record<string, string> = {}
  const touched = new Set<string>()
  plan.steps.forEach((step) => {
    finalBatchShelf[step.batchId] = step.toShelfId
    touched.add(step.toShelfId)
    if (step.fromShelfId) touched.add(step.fromShelfId)
  })
  return {
    planId: plan.id,
    planTitle: plan.title,
    batchIds: plan.batchIds,
    finalBatchShelf,
    touchedShelfIds: Array.from(touched)
  }
}

interface PlannedWorld {
  /** 批次 → 当前窖位（null = 未上架） */
  location: Map<string, string | null>
  /** 窖位 → 当前占用块数 */
  occupancy: Map<string, number>
  capacity: Map<string, number>
  /** 其他在办编排单过程中会碰到的窖位 → 持有它的编排单说明 */
  touchedByOther: Map<string, Array<{ planId: string; planTitle: string }>>
}

/** 把其他在办编排单的终态投影叠加到现状上，得到规划基线世界 */
function buildWorld(input: PlannerInput): PlannedWorld {
  const location = new Map<string, string | null>()
  const occupancy = new Map<string, number>()
  const capacity = new Map<string, number>()

  input.shelves.forEach((shelf: PlannerShelf) => {
    capacity.set(shelf.id, Math.max(0, shelf.capacity))
    occupancy.set(shelf.id, 0)
  })
  input.batches.forEach((batch: PlannerBatch) => {
    location.set(batch.id, batch.shelfId)
  })
  input.batches.forEach((batch: PlannerBatch) => {
    if (batch.shelfId) {
      occupancy.set(batch.shelfId, (occupancy.get(batch.shelfId) ?? 0) + 1)
    }
  })

  const touchedByOther = new Map<string, Array<{ planId: string; planTitle: string }>>()
  input.others.forEach((other) => {
    other.touchedShelfIds.forEach((shelfId) => {
      const holders = touchedByOther.get(shelfId) ?? []
      if (!holders.some((item) => item.planId === other.planId)) {
        holders.push({ planId: other.planId, planTitle: other.planTitle })
      }
      touchedByOther.set(shelfId, holders)
    })
    Object.entries(other.finalBatchShelf).forEach(([batchId, shelfId]) => {
      if (!capacity.has(shelfId)) return
      const from = location.get(batchId) ?? null
      if (from) occupancy.set(from, Math.max(0, (occupancy.get(from) ?? 0) - 1))
      location.set(batchId, shelfId)
      occupancy.set(shelfId, (occupancy.get(shelfId) ?? 0) + 1)
    })
  })

  return { location, occupancy, capacity, touchedByOther }
}

function freeAt(world: PlannedWorld, shelfId: string): boolean {
  return (world.occupancy.get(shelfId) ?? 0) < (world.capacity.get(shelfId) ?? 0)
}

/**
 * 整批调拨转架编排规划器（纯函数）。
 *
 * 处理两类「排不满」：
 * 1. 静态容量冲突：某目标窖位在全部调拨落地后的需求超过容量（含其他在办编排单的终态投影）；
 * 2. 周转死锁：互相占满目标位，需要临时位缓冲；若全库没有空闲临时位（唯一空位还被别的
 *    在办编排单占用为中转位），则拒绝并指明冲突批次、目标窖位与持锁编排单。
 */
export function planRelocation(input: PlannerInput): PlannerResult {
  const world = buildWorld(input)
  const batchMap = new Map(input.batches.map((batch) => [batch.id, batch]))
  const moveByBatch = new Map<string, RelocationMove>()
  const structural: string[] = []

  for (const move of input.moves) {
    if (!batchMap.has(move.batchId)) {
      structural.push(`批次 ${move.batchId} 不存在或已删除`)
      continue
    }
    if (!world.capacity.has(move.toShelfId)) {
      structural.push(`目标窖位 ${move.toShelfId} 不存在或已删除`)
      continue
    }
    if (moveByBatch.has(move.batchId)) {
      structural.push(`批次 ${move.batchId} 在本单中重复指定了目标窖位`)
      continue
    }
    moveByBatch.set(move.batchId, move)
  }
  if (structural.length > 0) {
    return { ok: false, steps: [], conflicts: [], tempShelfIds: [], message: structural.join('；') }
  }

  // 批次级并发冲突：同一批次已被别的在办编排单锁定
  const conflicts: PlannerConflict[] = []
  const ourBatches = new Set(moveByBatch.keys())
  for (const other of input.others) {
    for (const batchId of other.batchIds) {
      if (ourBatches.has(batchId)) {
        conflicts.push({
          type: 'batch-busy',
          batchId,
          planId: other.planId,
          planTitle: other.planTitle,
          message: `批次 ${batchId} 已在编排单「${other.planTitle}」中办理，不能重复占位`
        })
      }
    }
  }
  if (conflicts.length > 0) {
    return {
      ok: false,
      steps: [],
      conflicts,
      tempShelfIds: [],
      message: conflicts.map((item) => item.message).join('；')
    }
  }

  // 去掉「批次本就在目标窖位」的空转意向
  for (const [batchId, move] of Array.from(moveByBatch.entries())) {
    if (world.location.get(batchId) === move.toShelfId) moveByBatch.delete(batchId)
  }
  if (moveByBatch.size === 0) {
    return {
      ok: false,
      steps: [],
      conflicts: [],
      tempShelfIds: [],
      message: '所选批次均已在目标窖位上，没有需要办理的转架'
    }
  }

  const incomingCount = new Map<string, number>()
  moveByBatch.forEach((move) => {
    incomingCount.set(move.toShelfId, (incomingCount.get(move.toShelfId) ?? 0) + 1)
  })

  // 静态终态容量校验：投影占用 - 本单要走的 + 本单要进的 ≤ 容量
  const staticConflicts: PlannerCapacityConflict[] = []
  const ourBatchIds = new Set(moveByBatch.keys())
  incomingCount.forEach((incoming, shelfId) => {
    const stayers = Array.from(world.location.entries()).filter(
      ([batchId, at]) => at === shelfId && !ourBatchIds.has(batchId)
    ).length
    const leaving = Array.from(world.location.entries()).filter(
      ([batchId, at]) => at === shelfId && ourBatchIds.has(batchId)
    ).length
    const projected = world.occupancy.get(shelfId) ?? 0
    const required = projected - leaving + incoming
    const capacity = world.capacity.get(shelfId) ?? 0
    if (required > capacity) {
      const blockingBatchIds = stayers > 0 ? stayersOf(world, shelfId, ourBatchIds) : []
      const incomingBatchIds = Array.from(moveByBatch.values())
        .filter((move) => move.toShelfId === shelfId)
        .map((move) => move.batchId)
      staticConflicts.push({
        type: 'capacity',
        shelfId,
        blockingBatchIds,
        incomingBatchIds,
        required,
        capacity,
        message:
          `目标窖位 ${shelfId} 容量不足：落地后需要 ${required} 块 / 容量 ${capacity} 块` +
          (blockingBatchIds.length > 0 ? `，占用冲突批次：${blockingBatchIds.join('、')}` : '')
      })
    }
  })
  if (staticConflicts.length > 0) {
    return {
      ok: false,
      steps: [],
      conflicts: staticConflicts,
      tempShelfIds: [],
      message: staticConflicts.map((item) => item.message).join('；')
    }
  }

  // 动态排程：能直接到位的先办；互相占满时选批次进临时位缓冲
  const finalOf = new Map<string, string>()
  moveByBatch.forEach((move, batchId) => finalOf.set(batchId, move.toShelfId))
  const remaining = new Set(moveByBatch.keys())
  const steps: RelocationStepDraft[] = []
  const tempShelfIds = new Set<string>()
  const buffered = new Set<string>()
  const lastTempShelf = new Map<string, string>()
  let seq = 0

  const pushStep = (
    batchId: string,
    fromShelfId: string | null,
    toShelfId: string,
    temporary: boolean
  ): void => {
    seq += 1
    steps.push({ seq, batchId, fromShelfId, toShelfId, temporary, note: '' })
    if (fromShelfId) world.occupancy.set(fromShelfId, Math.max(0, (world.occupancy.get(fromShelfId) ?? 0) - 1))
    world.occupancy.set(toShelfId, (world.occupancy.get(toShelfId) ?? 0) + 1)
    world.location.set(batchId, toShelfId)
  }

  const busyConflicts: PlannerConflict[] = []
  let guard = 0
  const maxSteps = stepLimit(moveByBatch.size)

  while (remaining.size > 0 && guard < maxSteps) {
    guard += 1

    // 1) 目标位当前有空位的批次，直接到位
    let directBatch: string | null = null
    for (const batchId of remaining) {
      if (freeAt(world, finalOf.get(batchId) as string)) {
        directBatch = batchId
        break
      }
    }
    if (directBatch) {
      const from = world.location.get(directBatch) ?? null
      pushStep(directBatch, from, finalOf.get(directBatch) as string, false)
      remaining.delete(directBatch)
      continue
    }

    // 2) 全部目标位都满 → 死锁，找一个批次进临时位
    const remainingFinals = new Set(Array.from(remaining).map((batchId) => finalOf.get(batchId) as string))
    const pick = chooseBufferBatch(remaining, world, finalOf, remainingFinals, buffered, lastTempShelf)
    if (!pick) {
      const conflict = deadlockConflict(world, finalOf, remaining, remainingFinals)
      if (conflict) conflicts.push(conflict)
      break
    }
    const { batchId: bufferBatch, tempShelfId } = pick
    // 唯一可用临时位属于别的在办编排单的中转范围 → 后提交方收到冲突结果
    const holders = world.touchedByOther.get(tempShelfId) ?? []
    if (holders.length > 0) {
      const holder = holders[0]
      busyConflicts.push({
        type: 'shelf-busy',
        shelfId: tempShelfId,
        planId: holder.planId,
        planTitle: holder.planTitle,
        message:
          `周转所需临时位 ${tempShelfId} 已被在办编排单「${holder.planTitle}」占用为中转窖位，` +
          `请先完成该单或改选调拨范围`
      })
      break
    }
    const from = world.location.get(bufferBatch) ?? null
    pushStep(bufferBatch, from, tempShelfId, true)
    tempShelfIds.add(tempShelfId)
    if (!buffered.has(bufferBatch)) buffered.add(bufferBatch)
    lastTempShelf.set(bufferBatch, tempShelfId)
  }

  if (busyConflicts.length > 0 || remaining.size > 0 || conflicts.some((item) => item.type === 'capacity')) {
    return {
      ok: false,
      steps: [],
      conflicts: [...conflicts, ...busyConflicts],
      tempShelfIds: [],
      message:
        busyConflicts[0]?.message ??
        conflicts[0]?.message ??
        '整库没有可用于周转的空闲临时位，目标窖位互相占满且无法缓冲，请先腾出空位'
    }
  }

  const tempSteps = steps.filter((step) => step.temporary).length
  const message =
    tempSteps > 0
      ? `已排出 ${steps.length} 步执行顺序，其中 ${tempSteps} 步临时中转（临时位：${Array.from(tempShelfIds).join('、')}）`
      : `已排出 ${steps.length} 步执行顺序，无需临时位`

  return {
    ok: true,
    steps,
    conflicts: [],
    tempShelfIds: Array.from(tempShelfIds),
    message
  }
}

function stayersOf(
  world: PlannedWorld,
  shelfId: string,
  moving: Set<string>
): string[] {
  const result: string[] = []
  world.location.forEach((at, batchId) => {
    if (at === shelfId && !moving.has(batchId)) result.push(batchId)
  })
  return result
}

/**
 * 死锁时挑选「挪到临时位」的批次与临时窖位。
 * 优先级：
 * 1. 还没中转过、且当前占着别的待办批次目标位的批次（腾位解锁）；
 * 2. 其他还没中转过、且已上架的批次；
 * 3. 已中转过的批次做临时位之间的二次腾挪（仅当它占着待办目标位）。
 * 临时窖位优先选不相关的空闲窖位，避免弹回上一个临时位或压进自己的最终位。
 */
function chooseBufferBatch(
  remaining: Set<string>,
  world: PlannedWorld,
  finalOf: Map<string, string>,
  remainingFinals: Set<string>,
  buffered: Set<string>,
  lastTempShelf: Map<string, string>
): { batchId: string; tempShelfId: string } | null {
  const ordered: string[] = []
  for (const batchId of remaining) {
    const at = world.location.get(batchId) ?? null
    if (at && !buffered.has(batchId) && remainingFinals.has(at)) ordered.push(batchId)
  }
  for (const batchId of remaining) {
    const at = world.location.get(batchId) ?? null
    if (at && !buffered.has(batchId) && !ordered.includes(batchId)) ordered.push(batchId)
  }
  for (const batchId of remaining) {
    const at = world.location.get(batchId) ?? null
    if (at && buffered.has(batchId) && remainingFinals.has(at)) ordered.push(batchId)
  }

  for (const batchId of ordered) {
    const at = world.location.get(batchId) ?? null
    const avoid = new Set<string>([finalOf.get(batchId) as string])
    if (lastTempShelf.has(batchId)) avoid.add(lastTempShelf.get(batchId) as string)
    const tempShelfId = findTempShelf(world, at, avoid, remainingFinals)
    if (tempShelfId) return { batchId, tempShelfId }
  }
  return null
}

function findTempShelf(
  world: PlannedWorld,
  fromShelfId: string | null,
  avoid: Set<string>,
  remainingFinals: Set<string>
): string | null {
  const candidates: Array<{ shelfId: string; occupancy: number; score: number }> = []
  world.capacity.forEach((_, shelfId) => {
    if (fromShelfId === shelfId || avoid.has(shelfId)) return
    if (!freeAt(world, shelfId)) return
    const occupancy = world.occupancy.get(shelfId) ?? 0
    // 优先：不属于其他待办批次的目标位、且不被别的在办编排单触碰的窖位
    let score = 0
    if (remainingFinals.has(shelfId)) score += 2
    if (world.touchedByOther.has(shelfId)) score += 4
    candidates.push({ shelfId, occupancy, score })
  })
  candidates.sort((a, b) => a.score - b.score || a.occupancy - b.occupancy)
  return candidates[0]?.shelfId ?? null
}

/** 死锁且找不到缓冲批次时，组装容量/阻塞冲突明细（指明冲突批次与目标窖位） */
function deadlockConflict(
  world: PlannedWorld,
  finalOf: Map<string, string>,
  remaining: Set<string>,
  remainingFinals: Set<string>
): PlannerCapacityConflict | null {
  const targetId = Array.from(remainingFinals)[0]
  if (!targetId) return null
  const incomingBatchIds = Array.from(remaining).filter(
    (batchId) => finalOf.get(batchId) === targetId
  )
  const blockingBatchIds: string[] = []
  world.location.forEach((at, batchId) => {
    if (at === targetId && !remaining.has(batchId)) blockingBatchIds.push(batchId)
  })
  const capacity = world.capacity.get(targetId) ?? 0
  const occupied = world.occupancy.get(targetId) ?? 0
  return {
    type: 'capacity',
    shelfId: targetId,
    blockingBatchIds,
    incomingBatchIds,
    required: occupied + incomingBatchIds.length,
    capacity,
    message:
      `目标窖位 ${targetId} 已满（${occupied}/${capacity}），冲突批次：${blockingBatchIds.join('、') || '（无在架批次）'}；` +
      `全库没有可周转的空闲临时位，无法为 ${incomingBatchIds.join('、')} 腾出位置`
  }
}

/** 把规划草稿里的 id 转成可展示文案（落库时固化，刷新后仍可读） */
export function formatStepNote(
  draft: RelocationStepDraft,
  batchLabel: (batchId: string) => string,
  shelfLabel: (shelfId: string | null) => string
): string {
  const batch = batchLabel(draft.batchId)
  if (draft.temporary) {
    return `${batch} 临时中转：${shelfLabel(draft.fromShelfId)} → ${shelfLabel(draft.toShelfId)}（腾位缓冲）`
  }
  if (!draft.fromShelfId) {
    return `${batch} 首次上架至 ${shelfLabel(draft.toShelfId)}`
  }
  return `${batch}：${shelfLabel(draft.fromShelfId)} → ${shelfLabel(draft.toShelfId)}`
}

export { dedupe }
