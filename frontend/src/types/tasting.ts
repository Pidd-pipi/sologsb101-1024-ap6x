/**
 * 出库品评：批次出库（或开箱试吃）时对外观 / 风味 / 质地各维度打分并给结论。
 * 同批次多次品评取均分并回写批次结论（优 / 合格 / 待改进）。
 */
export type TastingConclusion = '优' | '合格' | '待改进'

/** 外观 / 风味 / 质地三个维度的评分字段 */
export type TastingDimension = 'appearanceScore' | 'flavorScore' | 'textureScore'

export interface Tasting {
  id: string
  /** 所属批次 id（外键 → Batch.id） */
  batchId: string
  /** 出库日期（YYYY-MM-DD） */
  outAt: string
  /** 外观描述 */
  appearance: string
  /** 风味描述 */
  flavor: string
  /** 质地描述 */
  texture: string
  /** 外观评分 1-10 */
  appearanceScore: number
  /** 风味评分 1-10 */
  flavorScore: number
  /** 质地评分 1-10 */
  textureScore: number
  /** 评分 1-10，取三维度均分 */
  score: number
  /** 结论 */
  conclusion: TastingConclusion
  /** 品评人 */
  taster: string
  createdAt: number
  updatedAt: number
}

export const TASTING_CONCLUSIONS: TastingConclusion[] = ['优', '合格', '待改进']

export const SCORE_DIMENSIONS: Array<{ key: TastingDimension; label: string; hint: string }> = [
  { key: 'appearanceScore', label: '外观', hint: '表皮颜色、切面气孔与油脂分布' },
  { key: 'flavorScore', label: '风味', hint: '奶香、酸度、咸度与尾韵' },
  { key: 'textureScore', label: '质地', hint: '硬度、弹性与结晶颗粒' }
]

/** 三维度均分 → 总分（保留 1 位小数） */
export function averageScore(
  appearanceScore: number,
  flavorScore: number,
  textureScore: number
): number {
  const values = [appearanceScore, flavorScore, textureScore].map((value) =>
    Math.min(10, Math.max(1, value))
  )
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10
}

/** 评分区间 → 结论的默认换算 */
export function scoreToConclusion(score: number): TastingConclusion {
  if (score >= 8.5) return '优'
  if (score >= 6) return '合格'
  return '待改进'
}

/** 品评页筛选条件：关键字 + 批次多选 + 结论多选 */
export interface TastingFilterState {
  keyword: string
  batchIds: string[]
  conclusions: TastingConclusion[]
}

export function createEmptyTastingFilter(): TastingFilterState {
  return {
    keyword: '',
    batchIds: [],
    conclusions: []
  }
}

/** 同批次均分派生值，用于回写批次结论 */
export interface BatchScore {
  batchId: string
  count: number
  /** 均分，保留 1 位小数 */
  avgScore: number
  /** 均分换算出的结论 */
  conclusion: TastingConclusion
  /** 各维度均分 */
  avgAppearance: number
  avgFlavor: number
  avgTexture: number
  /** 最近一次出库日期 */
  lastOutAt: string
}
