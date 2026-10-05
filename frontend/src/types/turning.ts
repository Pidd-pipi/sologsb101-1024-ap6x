/**
 * 转架 / 翻面 / 擦洗作业：针对某个批次在某个窖位上的一次操作，
 * 由「按批次生成等间隔作业计划」批量产出，随后逐条签署。
 * 状态流转：待执行 → 已完成 / 已跳过。
 */
export type TurningType = '转架' | '翻面' | '擦洗'

export type TurningState = '待执行' | '已完成' | '已跳过'

export interface Turning {
  id: string
  /** 所属批次 id（外键 → Batch.id） */
  batchId: string
  /** 作业窖位 id（外键 → Shelf.id） */
  shelfId: string
  /** 作业日期（YYYY-MM-DD） */
  doneAt: string
  /** 作业类型 */
  type: TurningType
  /** 盐水浓度 % */
  brinePct: number
  /** 操作人 */
  operator: string
  /** 当前状态 */
  state: TurningState
  /** 作业计划内的执行顺序，由拖拽排序写回，从 1 开始 */
  seq: number
  /** 由转架编排单办理生成时，记录来源编排单 id（幂等防重的回链） */
  relocationId?: string
  /** 由转架编排单办理生成时，记录对应步骤序号 */
  relocationStepSeq?: number
  createdAt: number
  updatedAt: number
}

export const TURNING_TYPES: TurningType[] = ['转架', '翻面', '擦洗']
export const TURNING_STATES: TurningState[] = ['待执行', '已完成', '已跳过']

/** 转架页筛选条件：关键字 + 作业类型多选 + 作业状态多选 */
export interface TurningFilterState {
  keyword: string
  types: TurningType[]
  states: TurningState[]
}

export function createEmptyTurningFilter(): TurningFilterState {
  return {
    keyword: '',
    types: [],
    states: []
  }
}

/** 等间隔计划的生成入参 */
export interface TurningPlanInput {
  batchId: string
  shelfId: string
  /** 首次作业日期（YYYY-MM-DD） */
  startAt: string
  /** 作业次数 */
  times: number
  /** 间隔天数 */
  intervalDays: number
  /** 作业类型 */
  type: TurningType
  /** 盐水浓度 % */
  brinePct: number
  /** 操作人 */
  operator: string
}

/** 作业计划统计派生值 */
export interface TurningSummary {
  total: number
  pending: number
  done: number
  skipped: number
  /** 完成率百分比 0-100 */
  donePercent: number
  /** 平均盐水浓度 % */
  avgBrinePct: number
}
