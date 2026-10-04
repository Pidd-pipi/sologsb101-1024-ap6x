/**
 * 奶源：一次收奶记录，作为生产批次的奶源依据。
 * 一个奶源可挂接多个生产批次（父 → 子）。
 */
export type MilkKind = '牛' | '羊' | '水牛'

export interface Milk {
  id: string
  /** 牧场名称 */
  farm: string
  /** 乳种：牛 / 羊 / 水牛 */
  milkKind: MilkKind
  /** 收奶日期（YYYY-MM-DD） */
  collectedAt: string
  /** 脂肪率 % */
  fatPct: number
  /** 蛋白率 % */
  proteinPct: number
  /** 备注（饲料、体细胞数、异常情况等） */
  note: string
  createdAt: number
  updatedAt: number
}

export const MILK_KINDS: MilkKind[] = ['牛', '羊', '水牛']

/** 奶源卡片回显的聚合值：已用批次数与累计入窖重量 */
export interface MilkStat {
  milkId: string
  batchCount: number
  totalWeightKg: number
  agingCount: number
}

/** 奶源页的筛选条件（关键字 + 乳种多选 + 批次状态多选） */
export interface MilkFilterState {
  keyword: string
  milkKinds: MilkKind[]
  batchStates: string[]
}

export function createEmptyMilkFilter(): MilkFilterState {
  return {
    keyword: '',
    milkKinds: [],
    batchStates: []
  }
}

/** 奶源页顶部统计徽标派生值 */
export interface MilkOverview {
  milkCount: number
  batchCount: number
  agingBatchCount: number
  totalWeightKg: number
  releasedCount: number
}
