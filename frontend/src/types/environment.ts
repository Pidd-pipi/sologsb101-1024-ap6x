/**
 * 环境记录：某批次所在窖位的一次温湿度登记。
 * 温湿度越界自动标异常并给出开窗 / 加湿等调整措施。
 */
export interface Environment {
  id: string
  /** 所属批次 id（外键 → Batch.id） */
  batchId: string
  /** 记录时间（YYYY-MM-DDTHH:mm） */
  recordedAt: string
  /** 温度 ℃ */
  tempC: number
  /** 湿度 % */
  humidityPct: number
  /** 是否异常（越界自动判定，也可人工修正） */
  anomaly: boolean
  /** 调整措施，如「开窗通风 30 分钟」「加湿至 88%」 */
  action: string
  createdAt: number
  updatedAt: number
}

/** 环境页筛选条件：关键字 + 异常标记 + 批次多选 */
export interface EnvironmentFilterState {
  keyword: string
  anomalies: Array<'异常' | '正常'>
  batchIds: string[]
}

export function createEmptyEnvironmentFilter(): EnvironmentFilterState {
  return {
    keyword: '',
    anomalies: [],
    batchIds: []
  }
}

/** 温湿度曲线上的一个采样点（绘制 SVG 折线用） */
export interface EnvSeriesPoint {
  id: string
  /** 记录时间的可读标签 */
  label: string
  tempC: number
  humidityPct: number
  anomaly: boolean
  /** 温度在曲线区域内的百分比坐标 0-100（0 为顶部） */
  tempRatio: number
  /** 湿度在曲线区域内的百分比坐标 0-100 */
  humidityRatio: number
}

/** 环境页统计徽标派生值 */
export interface EnvironmentSummary {
  total: number
  anomalyCount: number
  avgTempC: number
  avgHumidityPct: number
  /** 异常占比百分比 0-100 */
  anomalyPercent: number
}
