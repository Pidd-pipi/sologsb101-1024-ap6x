/**
 * 转架编排单：整批调拨（两组货架对调 / 整库挪位）时，
 * 先按窖位容量排出「临时周转位 + 执行顺序」，确认后逐步办理。
 * 每一步落地都在同一事务内同步回写：批次窖位、窖位占用与一条转架作业（Turning）。
 * 办理失败后未完成队列保留在本地，可续办；已落地步骤不重复占位、不再生成作业。
 */
export type TransferStepKind = '临时周转' | '落位'

export type TransferStepStatus = '待执行' | '已落地' | '失败'

export type TransferPlanStatus = '已编排' | '执行中' | '已完成' | '已失败' | '已取消'

export interface TransferStep {
  /** 执行顺序，从 1 开始 */
  seq: number
  /** 调拨批次 id（外键 → Batch.id） */
  batchId: string
  /** 移出窖位 id（null 表示批次原未上架） */
  fromShelfId: string | null
  /** 移入窖位 id（外键 → Shelf.id） */
  toShelfId: string
  /** 步骤类型：临时周转位 / 正式落位 */
  kind: TransferStepKind
  /** 当前状态 */
  status: TransferStepStatus
  /** 落地后生成的转架作业 id（确定性 id，崩溃重试也不会重复生成） */
  turningId?: string
  landedAt?: number
  /** 失败原因（容量不足 / 目标窖位被占等），随编排单持久化 */
  failReason?: string
}

export interface TransferPlan {
  id: string
  /** 编排单号，如 ZBxxxx */
  code: string
  title: string
  status: TransferPlanStatus
  /** 排好的步骤队列（含临时周转步） */
  steps: TransferStep[]
  operator: string
  note: string
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
}

/** 编排入参：某批次的目标窖位 */
export interface TransferTargetInput {
  batchId: string
  targetShelfId: string
}

/** 编排预览结果：ok=false 时 error 指明冲突批次与目标窖位 */
export interface TransferPlanPreview {
  ok: boolean
  steps: TransferStep[]
  error?: string
  /** 冲突批次 id（被卡住的批次或占用目标窖位的批次） */
  conflictBatchId?: string
  /** 冲突目标窖位 id */
  conflictShelfId?: string
}

export const TRANSFER_PLAN_STATUSES: TransferPlanStatus[] = [
  '已编排',
  '执行中',
  '已完成',
  '已失败',
  '已取消'
]
