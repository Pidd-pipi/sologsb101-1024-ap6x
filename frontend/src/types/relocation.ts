/**
 * 整批调拨转架编排：把多个批次「整批」从当前窖位挪到目标窖位。
 * 两组货架对调或整库挪位时，目标窖位可能互相占满，规划器会先安排
 * 「临时位」缓冲批次，再排出可执行顺序；办理时逐步写回批次窖位、
 * 窖位占用与转架作业，失败后可从未完成队列续办。
 */
import type { TurningType } from '@/types/turning'

/** 编排单状态 */
export type RelocationStatus = '待执行' | '执行中' | '已完成' | '已失败' | '已取消'

/** 单个步骤状态 */
export type RelocationStepState = '待执行' | '已完成' | '失败' | '已取消'

/** 规划中的一步（尚未落库的草稿） */
export interface RelocationStepDraft {
  /** 步骤序号，从 1 开始 */
  seq: number
  batchId: string
  /** 源窖位 id；null 表示批次尚未上架（本次为首次上架） */
  fromShelfId: string | null
  /** 目标窖位 id（临时位或最终位） */
  toShelfId: string
  /** true 表示这是排入临时窖位缓冲的过渡步骤 */
  temporary: boolean
  /** 步骤说明（规划阶段写死，便于断网/刷新后回显） */
  note: string
}

/** 已落库的编排步骤 */
export interface RelocationStep {
  seq: number
  batchId: string
  fromShelfId: string | null
  toShelfId: string
  temporary: boolean
  note: string
  state: RelocationStepState
  /** 该步办理时生成的转架作业 id（幂等键：已落地的步骤不再生成作业） */
  turningId: string | null
  /** 办理时间（YYYY-MM-DD） */
  doneAt: string | null
  /** 实际办理时间戳 */
  executedAt: number | null
  /** 最近一次失败原因（重试成功后清空） */
  failReason: string
  failedAt: number | null
}

/** 转架编排单 */
export interface Relocation {
  id: string
  /** 编排单标题，如「一号库两组货架对调」 */
  title: string
  /** 办理人（同步写入转架作业 operator） */
  operator: string
  /** 作业日期（YYYY-MM-DD，同步写入转架作业 doneAt） */
  plannedAt: string
  /** 生成的转架作业类型 */
  turningType: TurningType
  /** 盐水浓度 %，同步写入转架作业 */
  brinePct: number
  status: RelocationStatus
  /** 编排时锁定的全部批次（含临时位涉及的批次），用于跨编排单冲突判定 */
  batchIds: string[]
  /** 编排时涉及的全部窖位（源、目标、临时位） */
  shelfIds: string[]
  steps: RelocationStep[]
  /** 编排单级别的失败原因（如冲突作废） */
  failReason: string
  createdAt: number
  updatedAt: number
  confirmedAt: number | null
  completedAt: number | null
}

export const RELOCATION_STATUSES: RelocationStatus[] = [
  '待执行',
  '执行中',
  '已完成',
  '已失败',
  '已取消'
]

export const RELOCATION_STEP_STATES: RelocationStepState[] = [
  '待执行',
  '已完成',
  '失败',
  '已取消'
]

/** 仍占用批次 / 窖位资源、参与并发冲突判定的编排单状态 */
export const ACTIVE_RELOCATION_STATUSES: RelocationStatus[] = ['待执行', '执行中', '已失败']

/** 一条「批次 → 目标窖位」的调拨意向 */
export interface RelocationMove {
  batchId: string
  toShelfId: string
}

/** 规划器看到的批次视图 */
export interface PlannerBatch {
  id: string
  /** 当前所在窖位；null 表示尚未上架 */
  shelfId: string | null
}

/** 规划器看到的窖位视图 */
export interface PlannerShelf {
  id: string
  capacity: number
}

/** 容量不足导致的冲突明细 */
export interface PlannerCapacityConflict {
  type: 'capacity'
  /** 放不下的目标窖位 */
  shelfId: string
  /** 仍占着该窖位、导致阻塞的批次（含批次名解析后的可展示文案） */
  blockingBatchIds: string[]
  /** 需要进入该窖位的批次 */
  incomingBatchIds: string[]
  /** 该窖位在编排全部落地后所需的块数 */
  required: number
  /** 该窖位容量 */
  capacity: number
  message: string
}

/** 与其他在办编排单的批次冲突 */
export interface PlannerBatchBusyConflict {
  type: 'batch-busy'
  batchId: string
  /** 先提交、持有该批次的编排单 id */
  planId: string
  planTitle: string
  message: string
}

/** 与其他在办编排单的窖位冲突（目标位 / 临时位被锁） */
export interface PlannerShelfBusyConflict {
  type: 'shelf-busy'
  shelfId: string
  planId: string
  planTitle: string
  message: string
}

export type PlannerConflict =
  | PlannerCapacityConflict
  | PlannerBatchBusyConflict
  | PlannerShelfBusyConflict

/** 规划结果：ok 为 true 时 steps 即执行顺序草稿 */
export interface PlannerResult {
  ok: boolean
  steps: RelocationStepDraft[]
  conflicts: PlannerConflict[]
  /** 规划过程中用到的临时窖位 id（去重，有序） */
  tempShelfIds: string[]
  /** 汇总说明（可直接展示给用户） */
  message: string
}

/** 规划入参：当前批次、窖位、其他在办编排单（投影）与本次调拨意向 */
export interface PlannerInput {
  batches: PlannerBatch[]
  shelves: PlannerShelf[]
  /** 其他在办编排单全部落地后对批次/窖位的占用投影 */
  others: ActivePlanProjection[]
  moves: RelocationMove[]
}

/** 其他在办编排单的资源占用投影，用于并发冲突判定与容量试算 */
export interface ActivePlanProjection {
  planId: string
  planTitle: string
  /** 锁定的批次 */
  batchIds: string[]
  /** 该单全部落地后每个批次所在窖位 */
  finalBatchShelf: Record<string, string>
  /** 该单过程中会用到的全部窖位（含临时位） */
  touchedShelfIds: string[]
}

/** 编排单页筛选条件：关键字 + 状态多选 */
export interface RelocationFilterState {
  keyword: string
  statuses: RelocationStatus[]
}

export function createEmptyRelocationFilter(): RelocationFilterState {
  return {
    keyword: '',
    statuses: []
  }
}

/** 新建编排单入参（确认后落库） */
export interface NewRelocationInput {
  title: string
  operator: string
  plannedAt: string
  turningType: TurningType
  brinePct: number
  moves: RelocationMove[]
}
