import Dexie, { type Table } from 'dexie'
import type { Milk } from '@/types/milk'
import type { Batch } from '@/types/batch'
import type { Shelf } from '@/types/shelf'
import type { Turning } from '@/types/turning'
import type { Environment } from '@/types/environment'
import type { Tasting } from '@/types/tasting'
import type { TransferPlan } from '@/types/transfer'
import { addDays, diffDays } from '@/utils/temperature'

/** IndexedDB 数据库名：与项目英文短名保持一致 */
export const DB_NAME = 'gbcheeseage'

/** 本地结构版本号：新增/修改表结构时必须递增，并补充 upgrade 迁移 */
export const DB_VERSION = 3

/** localStorage 键名（仅存少量元数据，业务数据一律在 IndexedDB） */
export const LS_KEYS = {
  dbVersion: 'gbcheeseage:db-version',
  lastBackupAt: 'gbcheeseage:last-backup-at',
  uiPrefs: 'gbcheeseage:ui-prefs'
} as const

/** kv 键值仓：存放跨标签页编排锁等少量元数据 */
export interface KvRecord {
  id: string
  value: unknown
}

export interface UiPrefs {
  /** 上次查看的库房 */
  lastRoom: string | null
  /** 转架作业计划的排序方式 */
  turningSort: 'manual' | 'date'
  /** 环境曲线展示的指标 */
  envMetric: 'both' | 'temp' | 'humidity'
}

export const DEFAULT_UI_PREFS: UiPrefs = {
  lastRoom: null,
  turningSort: 'manual',
  envMetric: 'both'
}

/** 备份 / 导出文件结构，供 utils/export.ts 与品评页使用 */
export interface BackupPayload {
  app: 'gbcheeseage'
  dbVersion: number
  exportedAt: string
  milks: Milk[]
  batches: Batch[]
  shelves: Shelf[]
  turnings: Turning[]
  environments: Environment[]
  tastings: Tasting[]
  transferPlans: TransferPlan[]
}

/** 导出的批次熟成档案：含批次、奶源、窖位、全部子记录与转架编排单 */
export interface BatchArchive {
  app: 'gbcheeseage'
  dbVersion: number
  exportedAt: string
  scope: 'batch'
  batchId: string
  milks: Milk[]
  batches: Batch[]
  shelves: Shelf[]
  turnings: Turning[]
  environments: Environment[]
  tastings: Tasting[]
  /** 涉及该批次的转架编排单（含步骤状态与失败原因） */
  transferPlans: TransferPlan[]
}

export class CheeseAgeDatabase extends Dexie {
  milks!: Table<Milk, string>
  batches!: Table<Batch, string>
  shelves!: Table<Shelf, string>
  turnings!: Table<Turning, string>
  environments!: Table<Environment, string>
  tastings!: Table<Tasting, string>
  transferPlans!: Table<TransferPlan, string>
  kv!: Table<KvRecord, string>

  constructor() {
    super(DB_NAME)
    // v1：初版结构，六张业务表
    this.version(1).stores({
      milks: 'id, farm, milkKind, collectedAt, updatedAt',
      batches: 'id, milkId, cheeseType, targetDays, state, curdedAt, updatedAt',
      shelves: 'id, room, rackNo, tempZone, capacity, occupied, updatedAt',
      turnings: 'id, batchId, shelfId, doneAt, type, state, updatedAt',
      environments: 'id, batchId, recordedAt, anomaly, updatedAt',
      tastings: 'id, batchId, outAt, score, conclusion, updatedAt'
    })
    // v2：批次补 shelfId 索引与 conclusion 字段；转架表补 seq 排序索引；环境表补温区越界阈值快照
    this.version(DB_VERSION)
      .stores({
        milks: 'id, farm, milkKind, collectedAt, updatedAt',
        batches: 'id, milkId, shelfId, cheeseType, targetDays, state, curdedAt, updatedAt',
        shelves: 'id, room, rackNo, tempZone, capacity, occupied, updatedAt',
        turnings: 'id, batchId, shelfId, doneAt, type, state, seq, updatedAt',
        environments: 'id, batchId, recordedAt, anomaly, updatedAt',
        tastings: 'id, batchId, outAt, score, conclusion, updatedAt'
      })
      .upgrade(async (tx) => {
        const now = Date.now()
        // 迁移 1：补齐批次的时间戳、上架字段与结论字段
        await tx
          .table<Batch>('batches')
          .toCollection()
          .modify((batch) => {
            if (typeof batch.createdAt !== 'number') batch.createdAt = now
            if (typeof batch.updatedAt !== 'number') batch.updatedAt = batch.createdAt
            if (batch.shelfId === undefined) batch.shelfId = null
            if (typeof batch.conclusion !== 'string') batch.conclusion = ''
          })
        // 迁移 2：为历史转架作业按作业日期顺序补齐执行序号 seq
        const turnings = await tx.table<Turning>('turnings').toArray()
        const grouped = new Map<string, Turning[]>()
        turnings.forEach((turning) => {
          const bucket = grouped.get(turning.batchId) ?? []
          bucket.push(turning)
          grouped.set(turning.batchId, bucket)
        })
        for (const bucket of grouped.values()) {
          const sorted = [...bucket].sort((a, b) => a.doneAt.localeCompare(b.doneAt))
          for (let index = 0; index < sorted.length; index += 1) {
            await tx
              .table<Turning>('turnings')
              .update(sorted[index].id, { seq: index + 1, updatedAt: now })
          }
        }
        // 迁移 3：环境记录的异常标记按湿度区间重算，越界的补一条默认措施
        await tx
          .table<Environment>('environments')
          .toCollection()
          .modify((record) => {
            const humidityBad = record.humidityPct < 80 || record.humidityPct > 92
            if (humidityBad) {
              record.anomaly = true
              if (!record.action) {
                record.action = record.humidityPct < 80 ? '开启加湿器至 85%' : '开窗排湿至 88%'
              }
            }
            if (typeof record.updatedAt !== 'number') record.updatedAt = record.createdAt ?? now
          })
        // 迁移 4：窖位占用数与可放块数为负时归零，避免历史脏数据导致余量为负
        await tx
          .table<Shelf>('shelves')
          .toCollection()
          .modify((shelf) => {
            if (!Number.isFinite(shelf.capacity) || shelf.capacity < 0) shelf.capacity = 0
            if (!Number.isFinite(shelf.occupied) || shelf.occupied < 0) shelf.occupied = 0
          })
      })
    // v3：新增转架编排单表（内嵌有序步骤）与 kv 键值仓（跨标签页编排锁）
    this.version(3)
      .stores({
        milks: 'id, farm, milkKind, collectedAt, updatedAt',
        batches: 'id, milkId, shelfId, cheeseType, targetDays, state, curdedAt, updatedAt',
        shelves: 'id, room, rackNo, tempZone, capacity, occupied, updatedAt',
        turnings: 'id, batchId, shelfId, doneAt, type, state, seq, updatedAt',
        environments: 'id, batchId, recordedAt, anomaly, updatedAt',
        tastings: 'id, batchId, outAt, score, conclusion, updatedAt',
        transferPlans: 'id, code, status, createdAt, updatedAt',
        kv: 'id'
      })
      .upgrade(async (tx) => {
        // 迁移 5：编排单补齐步骤数组与状态字段（v3 新表，正常为空，此处做防御性回填）
        await tx
          .table<TransferPlan>('transferPlans')
          .toCollection()
          .modify((plan) => {
            if (!Array.isArray(plan.steps)) plan.steps = []
            if (typeof plan.status !== 'string') plan.status = '已编排'
            if (typeof plan.operator !== 'string') plan.operator = '系统编排'
            if (typeof plan.note !== 'string') plan.note = ''
            if (typeof plan.createdAt !== 'number') plan.createdAt = Date.now()
            if (typeof plan.updatedAt !== 'number') plan.updatedAt = plan.createdAt
          })
      })
  }
}

export const db = new CheeseAgeDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 清空全部业务表（导入前覆盖 / 重置数据使用） */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.milks,
      db.batches,
      db.shelves,
      db.turnings,
      db.environments,
      db.tastings,
      db.transferPlans,
      db.kv
    ],
    async () => {
      await Promise.all([
        db.milks.clear(),
        db.batches.clear(),
        db.shelves.clear(),
        db.turnings.clear(),
        db.environments.clear(),
        db.tastings.clear(),
        db.transferPlans.clear(),
        db.kv.clear()
      ])
    }
  )
}

/** 重置：清空后重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDatabase()
}

/** 各表记录数统计，供品评页与 README 中的「本地数据概览」展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [milks, batches, shelves, turnings, environments, tastings, transferPlans] =
    await Promise.all([
      db.milks.count(),
      db.batches.count(),
      db.shelves.count(),
      db.turnings.count(),
      db.environments.count(),
      db.tastings.count(),
      db.transferPlans.count()
    ])
  return { milks, batches, shelves, turnings, environments, tastings, transferPlans }
}

/** 读取 localStorage 中的 UI 偏好 */
export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs)
    if (!raw) return { ...DEFAULT_UI_PREFS }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      lastRoom: typeof parsed.lastRoom === 'string' ? parsed.lastRoom : null,
      turningSort: parsed.turningSort === 'date' ? 'date' : 'manual',
      envMetric:
        parsed.envMetric === 'temp' || parsed.envMetric === 'humidity' ? parsed.envMetric : 'both'
    }
  } catch {
    return { ...DEFAULT_UI_PREFS }
  }
}

/** 写入 localStorage 中的 UI 偏好 */
export function writeUiPrefs(prefs: UiPrefs): void {
  localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs))
}

/** 记录数据库结构版本到 localStorage，便于品评页比对 */
export function stampDbVersion(): void {
  localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
}

export function readStampedDbVersion(): number {
  const raw = localStorage.getItem(LS_KEYS.dbVersion)
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
}

export function stampBackupTime(iso: string): void {
  localStorage.setItem(LS_KEYS.lastBackupAt, iso)
}

export function readLastBackupAt(): string | null {
  return localStorage.getItem(LS_KEYS.lastBackupAt)
}

/** 组装全量导出快照 */
export async function exportSnapshot(): Promise<BackupPayload> {
  const [milks, batches, shelves, turnings, environments, tastings, transferPlans] =
    await Promise.all([
      db.milks.toArray(),
      db.batches.toArray(),
      db.shelves.toArray(),
      db.turnings.toArray(),
      db.environments.toArray(),
      db.tastings.toArray(),
      db.transferPlans.toArray()
    ])
  return {
    app: 'gbcheeseage',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    milks,
    batches,
    shelves,
    turnings,
    environments,
    tastings,
    transferPlans
  }
}

/** 导入快照：overwrite 为 true 时先清空全部表，否则按主键合并（同 id 覆盖） */
export async function importSnapshot(
  payload: BackupPayload,
  overwrite = false
): Promise<Record<string, number>> {
  if (overwrite) await clearAllTables()
  await db.transaction(
    'rw',
    [
      db.milks,
      db.batches,
      db.shelves,
      db.turnings,
      db.environments,
      db.tastings,
      db.transferPlans
    ],
    async () => {
      await db.milks.bulkPut(payload.milks)
      await db.batches.bulkPut(payload.batches)
      await db.shelves.bulkPut(payload.shelves)
      await db.turnings.bulkPut(payload.turnings)
      await db.environments.bulkPut(payload.environments)
      await db.tastings.bulkPut(payload.tastings)
      await db.transferPlans.bulkPut(payload.transferPlans)
    }
  )
  return {
    milks: payload.milks.length,
    batches: payload.batches.length,
    shelves: payload.shelves.length,
    turnings: payload.turnings.length,
    environments: payload.environments.length,
    tastings: payload.tastings.length,
    transferPlans: payload.transferPlans.length
  }
}

/** 首屏初始化：打开数据库 → 空库时播种三层演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  if ((await db.milks.count()) === 0) {
    await seedDatabase()
  }
}

const SEED_TIME = Date.UTC(2025, 2, 1, 8, 0, 0)

/**
 * 播种演示数据：3 层互相引用（奶源 → 生产批次 → 转架/环境/品评），
 * 使用固定 id + bulkPut，保证幂等（重复调用不会产生重复记录）。
 */
export async function seedDatabase(): Promise<void> {
  const now = SEED_TIME

  const milks: Milk[] = [
    {
      id: 'milk_alpine',
      farm: '清源高山牧场',
      milkKind: '牛',
      collectedAt: '2025-03-01',
      fatPct: 4.1,
      proteinPct: 3.4,
      note: '春季放牧末期，乳脂偏高，适合硬质熟成',
      createdAt: now,
      updatedAt: now
    },
    {
      id: 'milk_ewe',
      farm: '北岭奶羊合作社',
      milkKind: '羊',
      collectedAt: '2025-03-04',
      fatPct: 6.2,
      proteinPct: 4.1,
      note: '小批量收奶，用于蓝纹试作',
      createdAt: now,
      updatedAt: now
    },
    {
      id: 'milk_buffalo',
      farm: '江畔水牛场',
      milkKind: '水牛',
      collectedAt: '2025-03-08',
      fatPct: 7.4,
      proteinPct: 4.6,
      note: '乳固体高，出成率好，适合洗皮类',
      createdAt: now,
      updatedAt: now
    }
  ]

  const batchAId = 'batch_alp_01'
  const batchBId = 'batch_alp_02'
  const batchCId = 'batch_ewe_01'
  const batchDId = 'batch_buf_01'

  const batches: Batch[] = [
    {
      id: batchAId,
      milkId: 'milk_alpine',
      curdedAt: '2025-03-02',
      cheeseType: '硬质',
      targetDays: 90,
      weightKg: 12.5,
      state: '已出库',
      shelfId: 'shelf_a1',
      conclusion: '优',
      createdAt: now,
      updatedAt: now
    },
    {
      id: batchBId,
      milkId: 'milk_alpine',
      curdedAt: '2025-03-10',
      cheeseType: '洗皮',
      targetDays: 60,
      weightKg: 9.8,
      state: '熟成中',
      shelfId: 'shelf_b2',
      conclusion: '',
      createdAt: now,
      updatedAt: now
    },
    {
      id: batchCId,
      milkId: 'milk_ewe',
      curdedAt: '2025-03-06',
      cheeseType: '蓝纹',
      targetDays: 45,
      weightKg: 6.4,
      state: '熟成中',
      shelfId: 'shelf_a1',
      conclusion: '合格',
      createdAt: now,
      updatedAt: now
    },
    {
      id: batchDId,
      milkId: 'milk_buffalo',
      curdedAt: '2025-03-12',
      cheeseType: '软质',
      targetDays: 21,
      weightKg: 4.2,
      state: '凝乳',
      shelfId: null,
      conclusion: '',
      createdAt: now,
      updatedAt: now
    }
  ]

  const shelves: Shelf[] = [
    {
      id: 'shelf_a1',
      room: '一号熟成库',
      rackNo: 'A-01',
      layerNo: 1,
      tempZone: '中温区',
      capacity: 8,
      occupied: 2,
      createdAt: now,
      updatedAt: now
    },
    {
      id: 'shelf_b2',
      room: '一号熟成库',
      rackNo: 'B-02',
      layerNo: 2,
      tempZone: '冷区',
      capacity: 6,
      occupied: 1,
      createdAt: now,
      updatedAt: now
    },
    {
      id: 'shelf_c1',
      room: '二号恒温库',
      rackNo: 'C-01',
      layerNo: 1,
      tempZone: '常温区',
      capacity: 10,
      occupied: 0,
      createdAt: now,
      updatedAt: now
    }
  ]

  const turnings: Turning[] = [
    {
      id: 'turn_a1',
      batchId: batchAId,
      shelfId: 'shelf_a1',
      doneAt: '2025-03-09',
      type: '转架',
      brinePct: 18,
      operator: '陈默',
      state: '已完成',
      seq: 1,
      createdAt: now,
      updatedAt: now
    },
    {
      id: 'turn_a2',
      batchId: batchAId,
      shelfId: 'shelf_a1',
      doneAt: '2025-03-23',
      type: '翻面',
      brinePct: 18,
      operator: '陈默',
      state: '已完成',
      seq: 2,
      createdAt: now,
      updatedAt: now
    },
    {
      id: 'turn_b1',
      batchId: batchBId,
      shelfId: 'shelf_b2',
      doneAt: '2025-03-17',
      type: '转架',
      brinePct: 22,
      operator: '周雨',
      state: '待执行',
      seq: 1,
      createdAt: now,
      updatedAt: now
    },
    {
      id: 'turn_c1',
      batchId: batchCId,
      shelfId: 'shelf_a1',
      doneAt: '2025-03-13',
      type: '翻面',
      brinePct: 0,
      operator: '陈默',
      state: '已跳过',
      seq: 1,
      createdAt: now,
      updatedAt: now
    }
  ]

  const environments: Environment[] = [
    {
      id: 'env_a1',
      batchId: batchAId,
      recordedAt: '2025-03-03T09:30',
      tempC: 11.5,
      humidityPct: 85,
      anomaly: false,
      action: '',
      createdAt: now,
      updatedAt: now
    },
    {
      id: 'env_a2',
      batchId: batchAId,
      recordedAt: '2025-03-17T09:20',
      tempC: 15.8,
      humidityPct: 79,
      anomaly: true,
      action: '开窗通风 30 分钟并开启加湿器至 85%',
      createdAt: now,
      updatedAt: now
    },
    {
      id: 'env_b1',
      batchId: batchBId,
      recordedAt: '2025-03-11T10:05',
      tempC: 7.2,
      humidityPct: 88,
      anomaly: false,
      action: '',
      createdAt: now,
      updatedAt: now
    },
    {
      id: 'env_c1',
      batchId: batchCId,
      recordedAt: '2025-03-08T14:40',
      tempC: 12.1,
      humidityPct: 90,
      anomaly: false,
      action: '',
      createdAt: now,
      updatedAt: now
    }
  ]

  const tastings: Tasting[] = [
    {
      id: 'tast_a1',
      batchId: batchAId,
      outAt: '2025-05-31',
      appearance: '表皮干爽，切面乳白均匀',
      flavor: '坚果与奶油香明显，回味微咸',
      texture: '质地紧实，结晶颗粒细腻',
      appearanceScore: 9,
      flavorScore: 8.8,
      textureScore: 8.6,
      score: 8.8,
      conclusion: '优',
      taster: '林岚',
      createdAt: now,
      updatedAt: now
    },
    {
      id: 'tast_a2',
      batchId: batchAId,
      outAt: '2025-06-20',
      appearance: '表皮略干，切面有细微气孔',
      flavor: '乳酸感上升，尾韵带草本',
      texture: '口感略硬，回温后变柔',
      appearanceScore: 8,
      flavorScore: 8.4,
      textureScore: 8.2,
      score: 8.2,
      conclusion: '优',
      taster: '林岚',
      createdAt: now,
      updatedAt: now
    },
    {
      id: 'tast_c1',
      batchId: batchCId,
      outAt: '2025-04-20',
      appearance: '蓝纹分布均匀，表皮微黏',
      flavor: '辛香锋利，咸度偏高',
      texture: '膏体易碎，涂展性一般',
      appearanceScore: 7,
      flavorScore: 6.5,
      textureScore: 6.9,
      score: 6.8,
      conclusion: '合格',
      taster: '赵铭',
      createdAt: now,
      updatedAt: now
    }
  ]

  const transferPlans: TransferPlan[] = [
    {
      id: 'trplan_seed_01',
      code: 'ZB-DEMO-01',
      title: '演示：水牛批次上架恒温库',
      status: '已编排',
      steps: [
        {
          seq: 1,
          batchId: batchDId,
          fromShelfId: null,
          toShelfId: 'shelf_c1',
          kind: '落位',
          status: '待执行'
        }
      ],
      operator: '系统演示',
      note: '演示编排单：在「转架编排」页执行后，批次窖位、窖位占用与转架作业会在同一步骤内同步回写。',
      createdAt: now,
      updatedAt: now
    }
  ]

  await db.transaction(
    'rw',
    [
      db.milks,
      db.batches,
      db.shelves,
      db.turnings,
      db.environments,
      db.tastings,
      db.transferPlans
    ],
    async () => {
      await db.milks.bulkPut(milks)
      await db.batches.bulkPut(batches)
      await db.shelves.bulkPut(shelves)
      await db.turnings.bulkPut(turnings)
      await db.environments.bulkPut(environments)
      await db.tastings.bulkPut(tastings)
      await db.transferPlans.bulkPut(transferPlans)
    }
  )
}

/** 供页面展示的「批次最早可出库日期」计算，与 useAgingDays 保持同一算法 */
export function earliestOutAt(curdedAt: string, targetDays: number): string {
  return addDays(curdedAt, Math.max(0, Math.round(targetDays)))
}

/** 批次熟成进度百分比，用于徽标 */
export function agingProgress(curdedAt: string, targetDays: number, today: string): number {
  if (targetDays <= 0) return 100
  const elapsed = Math.max(0, diffDays(curdedAt, today))
  return Math.min(100, Math.round((elapsed / targetDays) * 100))
}
