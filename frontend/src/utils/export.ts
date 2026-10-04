import {
  db,
  DB_VERSION,
  createId,
  clearAllTables,
  stampBackupTime,
  type BackupPayload,
  type BatchArchive
} from '@/utils/db'

/** 导入 / 校验结果：校验失败时 errors 非空、payload 为 null */
export interface ParseResult {
  ok: boolean
  errors: string[]
  payload: BackupPayload | null
}

const COLLECTIONS: Array<keyof Pick<BackupPayload, 'milks' | 'batches' | 'shelves' | 'turnings' | 'environments' | 'tastings'>> = [
  'milks',
  'batches',
  'shelves',
  'turnings',
  'environments',
  'tastings'
]

function isPlainObject(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
}

/**
 * 校验批次熟成档案 JSON 的必备字段，返回错误信息数组（为空表示通过）。
 * 同时剔除非法条目，保证导入的数据结构完整。
 */
export function validatePayload(input: unknown): ParseResult {
  const errors: string[] = []
  if (!isPlainObject(input)) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  if (input.app !== 'gbcheeseage') {
    errors.push('app 字段应为 gbcheeseage，文件来源不明')
  }
  COLLECTIONS.forEach((key) => {
    if (!Array.isArray(input[key])) errors.push(`${key} 字段缺失或不是数组`)
  })
  if (errors.length > 0) return { ok: false, errors, payload: null }

  const obj = input as Partial<BackupPayload>
  const payload: BackupPayload = {
    app: 'gbcheeseage',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    milks: (obj.milks ?? []).filter((item) => typeof item?.id === 'string'),
    batches: (obj.batches ?? []).filter((item) => typeof item?.id === 'string'),
    shelves: (obj.shelves ?? []).filter((item) => typeof item?.id === 'string'),
    turnings: (obj.turnings ?? []).filter((item) => typeof item?.id === 'string'),
    environments: (obj.environments ?? []).filter((item) => typeof item?.id === 'string'),
    tastings: (obj.tastings ?? []).filter((item) => typeof item?.id === 'string')
  }
  if (payload.batches.length === 0 && payload.milks.length === 0) {
    errors.push('文件中没有任何奶源或批次记录')
    return { ok: false, errors, payload: null }
  }
  // 引用完整性校验：批次的奶源、转架/环境/品评的批次必须能在文件内找到
  const milkIds = new Set(payload.milks.map((item) => item.id))
  const batchIds = new Set(payload.batches.map((item) => item.id))
  payload.batches.forEach((batch) => {
    if (!milkIds.has(batch.milkId)) {
      errors.push(`批次 ${batch.id} 引用了不存在的奶源 ${batch.milkId}`)
    }
  })
  payload.turnings.forEach((turning) => {
    if (!batchIds.has(turning.batchId)) {
      errors.push(`转架作业 ${turning.id} 引用了不存在的批次 ${turning.batchId}`)
    }
  })
  payload.environments.forEach((record) => {
    if (!batchIds.has(record.batchId)) {
      errors.push(`环境记录 ${record.id} 引用了不存在的批次 ${record.batchId}`)
    }
  })
  payload.tastings.forEach((tasting) => {
    if (!batchIds.has(tasting.batchId)) {
      errors.push(`品评记录 ${tasting.id} 引用了不存在的批次 ${tasting.batchId}`)
    }
  })
  if (errors.length > 0) return { ok: false, errors, payload: null }
  return { ok: true, errors, payload }
}

/** 从文本解析并校验 JSON */
export function parseSnapshotJson(text: string): ParseResult {
  try {
    const parsed: unknown = JSON.parse(text)
    return validatePayload(parsed)
  } catch {
    return { ok: false, errors: ['JSON 解析失败，请确认文件未损坏'], payload: null }
  }
}

/** 读取用户选择的文件文本 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}

function downloadJson(fileName: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function stamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')
}

/** 导出全量档案 JSON */
export async function exportSnapshotJson(): Promise<{ fileName: string; counts: Record<string, number> }> {
  const [milks, batches, shelves, turnings, environments, tastings] = await Promise.all([
    db.milks.toArray(),
    db.batches.toArray(),
    db.shelves.toArray(),
    db.turnings.toArray(),
    db.environments.toArray(),
    db.tastings.toArray()
  ])
  const payload: BackupPayload = {
    app: 'gbcheeseage',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    milks,
    batches,
    shelves,
    turnings,
    environments,
    tastings
  }
  const fileName = `gbcheeseage-archive-v${DB_VERSION}-${stamp()}.json`
  downloadJson(fileName, payload)
  stampBackupTime(payload.exportedAt)
  return {
    fileName,
    counts: {
      milks: milks.length,
      batches: batches.length,
      shelves: shelves.length,
      turnings: turnings.length,
      environments: environments.length,
      tastings: tastings.length
    }
  }
}

/** 导出单个批次的熟成档案（含奶源、窖位、转架、环境与品评） */
export async function exportBatchArchiveJson(
  batchId: string
): Promise<{ fileName: string; counts: Record<string, number> }> {
  const batch = await db.batches.get(batchId)
  if (!batch) throw new Error('批次不存在，无法导出')
  const [milks, shelves, turnings, environments, tastings] = await Promise.all([
    db.milks.toArray(),
    db.shelves.toArray(),
    db.turnings.where('batchId').equals(batchId).toArray(),
    db.environments.where('batchId').equals(batchId).toArray(),
    db.tastings.where('batchId').equals(batchId).toArray()
  ])
  const archive: BatchArchive = {
    app: 'gbcheeseage',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    scope: 'batch',
    batchId,
    milks: milks.filter((milk) => milk.id === batch.milkId),
    batches: [batch],
    shelves: shelves.filter((shelf) => shelf.id === batch.shelfId),
    turnings,
    environments,
    tastings
  }
  const fileName = `gbcheeseage-batch-${batchId}-${stamp()}.json`
  downloadJson(fileName, archive)
  return {
    fileName,
    counts: {
      milks: archive.milks.length,
      batches: 1,
      shelves: archive.shelves.length,
      turnings: turnings.length,
      environments: environments.length,
      tastings: tastings.length
    }
  }
}

/** 导入档案：overwrite 为 true 时先清空全部表，否则按 id 合并覆盖 */
export async function importSnapshotJson(
  payload: BackupPayload,
  overwrite = false
): Promise<Record<string, number>> {
  if (overwrite) await clearAllTables()
  await db.transaction(
    'rw',
    [db.milks, db.batches, db.shelves, db.turnings, db.environments, db.tastings],
    async () => {
      await db.milks.bulkPut(payload.milks)
      await db.batches.bulkPut(payload.batches)
      await db.shelves.bulkPut(payload.shelves)
      await db.turnings.bulkPut(payload.turnings)
      await db.environments.bulkPut(payload.environments)
      await db.tastings.bulkPut(payload.tastings)
    }
  )
  return {
    milks: payload.milks.length,
    batches: payload.batches.length,
    shelves: payload.shelves.length,
    turnings: payload.turnings.length,
    environments: payload.environments.length,
    tastings: payload.tastings.length
  }
}

/** 追加式导入：为导入数据重新分配 id，避免覆盖现有档案 */
export function remapPayloadIds(payload: BackupPayload): BackupPayload {
  const milkIdMap = new Map<string, string>()
  const batchIdMap = new Map<string, string>()
  const shelfIdMap = new Map<string, string>()

  const milks = payload.milks.map((milk) => {
    const id = createId('milk')
    milkIdMap.set(milk.id, id)
    return { ...milk, id }
  })
  const shelves = payload.shelves.map((shelf) => {
    const id = createId('shelf')
    shelfIdMap.set(shelf.id, id)
    return { ...shelf, id }
  })
  const batches = payload.batches.map((batch) => {
    const id = createId('batch')
    batchIdMap.set(batch.id, id)
    return {
      ...batch,
      id,
      milkId: milkIdMap.get(batch.milkId) ?? batch.milkId,
      shelfId: batch.shelfId ? shelfIdMap.get(batch.shelfId) ?? null : null
    }
  })
  const turnings = payload.turnings.map((turning) => ({
    ...turning,
    id: createId('turn'),
    batchId: batchIdMap.get(turning.batchId) ?? turning.batchId,
    shelfId: shelfIdMap.get(turning.shelfId) ?? turning.shelfId
  }))
  const environments = payload.environments.map((record) => ({
    ...record,
    id: createId('env'),
    batchId: batchIdMap.get(record.batchId) ?? record.batchId
  }))
  const tastings = payload.tastings.map((tasting) => ({
    ...tasting,
    id: createId('tast'),
    batchId: batchIdMap.get(tasting.batchId) ?? tasting.batchId
  }))

  return { ...payload, milks, batches, shelves, turnings, environments, tastings }
}
