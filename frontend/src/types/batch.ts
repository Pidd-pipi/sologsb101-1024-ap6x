/**
 * 生产批次：由奶源凝乳而来的一批奶酪，是转架、环境与品评记录的主体（子 → 孙）。
 * 状态流转：凝乳 → 熟成中 → 已出库 / 报废。
 */
export type CheeseType = '硬质' | '软质' | '蓝纹' | '洗皮'

export type BatchState = '凝乳' | '熟成中' | '已出库' | '报废'

export interface Batch {
  id: string
  /** 所属奶源 id（外键 → Milk.id） */
  milkId: string
  /** 凝乳日期（YYYY-MM-DD） */
  curdedAt: string
  /** 奶酪类型 */
  cheeseType: CheeseType
  /** 目标熟成天数 */
  targetDays: number
  /** 入窖重量 kg */
  weightKg: number
  /** 当前状态 */
  state: BatchState
  /** 已绑定的熟成窖位 id（上架后回写，null 表示尚未上架） */
  shelfId: string | null
  /** 品评均分回写的结论：优 / 合格 / 待改进（未品评时为空字符串） */
  conclusion: string
  createdAt: number
  updatedAt: number
}

/** 允许的状态流转关系：凝乳 → 熟成中 → 已出库 / 报废 */
export const BATCH_STATE_FLOW: Record<BatchState, BatchState[]> = {
  凝乳: ['熟成中', '报废'],
  熟成中: ['已出库', '报废'],
  已出库: [],
  报废: []
}

export const CHEESE_TYPES: CheeseType[] = ['硬质', '软质', '蓝纹', '洗皮']
export const BATCH_STATES: BatchState[] = ['凝乳', '熟成中', '已出库', '报废']

/** 熟成进度派生值：最早可出库日期、已熟成天数、剩余天数、出库预警 */
export interface BatchAging {
  batchId: string
  /** 最早可出库日期（YYYY-MM-DD） */
  earliestOutAt: string
  /** 已熟成天数（凝乳日至今，负值按 0 计） */
  agedDays: number
  /** 剩余天数（可为负，表示已超期） */
  remainDays: number
  /** 熟成进度百分比 0-100 */
  progress: number
  /** 是否已到可出库日期 */
  due: boolean
  /** 预警文案，空串表示正常 */
  warning: string
}
