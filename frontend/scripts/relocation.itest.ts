/* Dexie + Pinia 集成断言（fake-indexeddb），esbuild 打包后由 node 运行 */
import { IDBKeyRange, IDBFactory } from 'fake-indexeddb'

// 必须在导入任何 src 模块前把 IndexedDB 垫片挂到全局
;(globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory()
;(globalThis as unknown as { IDBKeyRange: typeof IDBKeyRange }).IDBKeyRange = IDBKeyRange

const { db, clearAllTables } = await import('../src/utils/db')
const { createPinia, setActivePinia } = await import('pinia')
const { useRelocationStore, RelocationConflictError } = await import('../src/stores/relocationStore')
const { useMilkStore } = await import('../src/stores/milkStore')
const { useShelfStore } = await import('../src/stores/shelfStore')
const { exportSnapshot } = await import('../src/utils/db')
const batchType = await import('../src/types/batch')
const shelfType = await import('../src/types/shelf')

let passed = 0
let failed = 0
function assert(cond: boolean, message: string): void {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${message}`)
  } else {
    failed += 1
    console.error(`  ✗ ${message}`)
  }
}

await db.open()
await clearAllTables()

const now = Date.now()
// S1、S2 各容量 1 且各放一批；T 容量 2 且空；S4 容量 1 空（用于冲突单）
await db.shelves.bulkPut([
  { id: 'S1', room: '一号库', rackNo: 'S1', layerNo: 1, tempZone: '冷区', capacity: 1, occupied: 1, createdAt: now, updatedAt: now },
  { id: 'S2', room: '一号库', rackNo: 'S2', layerNo: 1, tempZone: '冷区', capacity: 1, occupied: 1, createdAt: now, updatedAt: now },
  { id: 'T', room: '二号库', rackNo: 'T', layerNo: 1, tempZone: '常温区', capacity: 2, occupied: 0, createdAt: now, updatedAt: now },
  { id: 'S4', room: '三号库', rackNo: 'S4', layerNo: 1, tempZone: '中温区', capacity: 1, occupied: 0, createdAt: now, updatedAt: now }
])
const b = (id: string, shelfId: string | null, state: batchType.BatchState = '熟成中') => ({
  id,
  milkId: 'milk_x',
  curdedAt: '2026-09-01',
  cheeseType: '硬质' as const,
  targetDays: 60,
  weightKg: 5,
  state,
  shelfId,
  conclusion: '',
  createdAt: now,
  updatedAt: now
})
await db.milks.put({
  id: 'milk_x',
  farm: '测试牧场',
  milkKind: '牛' as const,
  collectedAt: '2026-08-30',
  fatPct: 4,
  proteinPct: 3,
  note: '',
  createdAt: now,
  updatedAt: now
})
await db.batches.bulkPut([b('b1', 'S1'), b('b2', 'S2'), b('b3', null, '凝乳')])

setActivePinia(createPinia())
const milkStore = useMilkStore()
const shelfStore = useShelfStore()
const store = useRelocationStore()

// 等 liveQuery 首次载入完成
for (let i = 0; i < 50; i += 1) {
  if (milkStore.ready && shelfStore.ready && store.ready) break
  await new Promise((resolve) => setTimeout(resolve, 20))
}
assert(milkStore.ready && shelfStore.ready && store.ready, '三个 store 首次载入就绪')

// ---- 1. 容量不足直接拒绝（b1 → S2，满位且本单不挪走 b2，也没有周转关系）----
console.log('1. 容量不足拒绝启动')
{
  let caught: unknown = null
  try {
    await store.createPlan({
      title: '放不下的单',
      operator: '测试',
      plannedAt: '2026-10-04',
      turningType: '转架',
      brinePct: 0,
      moves: [{ batchId: 'b1', toShelfId: 'S2' }]
    })
  } catch (err) {
    caught = err
  }
  assert(caught instanceof RelocationConflictError, '应抛出 RelocationConflictError')
  if (caught instanceof RelocationConflictError) {
    assert(caught.conflicts[0].type === 'capacity', '冲突类型为 capacity')
    assert(caught.message.includes('S2'), '消息应指明目标窖位 S2')
  }
  const count = await db.relocations.count()
  assert(count === 0, '被拒绝时不应落库任何编排单')
}

// ---- 2. 满位对调单（b1→S2、b2→S1），走临时位 T，3 步 ----
console.log('2. 满位对调编排')
let planId = ''
{
  const plan = await store.createPlan({
    title: 'S1/S2 对调',
    operator: '周雨',
    plannedAt: '2026-10-04',
    turningType: '转架',
    brinePct: 20,
    moves: [
      { batchId: 'b1', toShelfId: 'S2' },
      { batchId: 'b2', toShelfId: 'S1' }
    ]
  })
  planId = plan.id
  assert(plan.status === '待执行', '新单状态为待执行')
  assert(plan.steps.length === 3, `应有 3 步（含临时中转），实际 ${plan.steps.length}`)
  assert(plan.steps.some((s) => s.temporary), '应含临时位步骤')
  assert(plan.steps.every((s) => s.state === '待执行'), '全部步骤待执行')
}

// ---- 3. 两个窗口先后提交、互相竞争窖位/批次资源 → 后提交方收到冲突 ----
console.log('3. 并发提交冲突（事务串行）')
{
  // 背景：S1/S2 对调单已存在并锁定 b1、b2。
  // 窗口甲先提交：b3（未上架）→ T（容量 2，当前空），成功。
  // 窗口乙后提交：另一批也 → T，叠加在办单终态后 T 容量不足 / 或重复批次，应被拒。
  const before = await db.relocations.count()
  const planA = await store.createPlan({
    title: '窗口甲：b3 入 T',
    operator: '窗口甲',
    plannedAt: '2026-10-05',
    turningType: '转架',
    brinePct: 0,
    moves: [{ batchId: 'b3', toShelfId: 'T' }]
  })
  assert(planA.status === '待执行', '窗口甲先提交成功')

  // 乙想重复操作甲刚锁定的批次 b3 → batch-busy
  let caught: unknown = null
  try {
    await store.createPlan({
      title: '窗口乙：重复 b3',
      operator: '窗口乙',
      plannedAt: '2026-10-05',
      turningType: '转架',
      brinePct: 0,
      moves: [{ batchId: 'b3', toShelfId: 'T' }]
    })
  } catch (err) {
    caught = err
  }
  assert(caught instanceof RelocationConflictError, '窗口乙后提交：收到 RelocationConflictError')
  if (caught instanceof RelocationConflictError) {
    assert(caught.conflicts.some((c) => c.type === 'batch-busy'), '重复批次冲突类型为 batch-busy')
    assert(caught.message.includes('窗口甲'), '消息应指明先提交的编排单「窗口甲」')
  }
  assert((await db.relocations.count()) === before + 1, '被拒的冲突编排单不落库')

  // 取消窗口甲的单（释放锁定），保证不影响后续对调单办理
  await store.cancelPlan(planA.id)
}

// ---- 4. 逐步办理 + 幂等 ----
console.log('4. 逐步办理与幂等')
{
  // 第一步（临时中转）
  let r = await store.executeStep(planId, 1)
  assert(r.ok, '第 1 步办理成功')
  const planAfter1 = await db.relocations.get(planId)
  const step1Draft = planAfter1!.steps[0]
  const tempId = step1Draft.toShelfId
  assert(step1Draft.temporary, '第 1 步是临时中转步骤')
  assert(step1Draft.state === '已完成', '第 1 步状态为已完成')
  const b1 = await db.batches.get('b1')
  assert(b1?.shelfId === tempId && tempId !== 'S2', `第 1 步后 b1 在临时位（${tempId}）而非目标位 S2`)
  const tempShelf = await db.shelves.get(tempId)
  assert(tempShelf?.occupied === 1, `临时位占用应为 1，实际 ${tempShelf?.occupied}`)

  // 幂等：重复办理第 1 步
  r = await store.executeStep(planId, 1)
  assert(r.ok && r.alreadyDone === true, '重复办理已落地步骤返回 alreadyDone')
  const turnsAfterReplay = await db.turnings.where('batchId').equals('b1').toArray()
  assert(turnsAfterReplay.length === 1, '已落地步骤不重复生成转架作业')
  assert(turnsAfterReplay[0].relocationId === planId, '作业回链编排单 id')

  // 跳步办理第 3 步应被拒绝（第 2 步未完成）
  r = await store.executeStep(planId, 3)
  assert(!r.ok && r.message.includes('先办理第 2 步'), '必须按顺序办理，跳步被拒绝')

  // 续办剩余步骤
  const resume = await store.resumePlan(planId)
  assert(resume.result === null, '续办应跑完剩余步骤')
  const plan = await db.relocations.get(planId)
  assert(plan?.status === '已完成', '编排单最终状态为已完成')
  const finalB1 = await db.batches.get('b1')
  const finalB2 = await db.batches.get('b2')
  assert(finalB1?.shelfId === 'S2', 'b1 最终在 S2')
  assert(finalB2?.shelfId === 'S1', 'b2 最终在 S1')
  const s1 = await db.shelves.get('S1')
  const s2 = await db.shelves.get('S2')
  const t = await db.shelves.get('T')
  assert(s1?.occupied === 1 && s2?.occupied === 1, `对调后 S1/S2 各占 1（${s1?.occupied}/${s2?.occupied}）`)
  assert(t?.occupied === 0, `临时位 T 已腾空（${t?.occupied}）`)
  const turns = await db.turnings.toArray()
  assert(turns.length === 3, `每步恰好一条转架作业，共 ${turns.length} 条`)
  assert(turns.every((x) => x.state === '已完成'), '编排生成的作业均为已完成')
}

// ---- 5. 办理失败 → 失败原因持久化 → 排除故障后续办成功 ----
console.log('5. 失败恢复与续办')
{
  // 新单：b3（未上架）→ S4（空位），仅 1 步
  const plan = await store.createPlan({
    title: '首上架单',
    operator: '陈默',
    plannedAt: '2026-10-04',
    turningType: '翻面',
    brinePct: 0,
    moves: [{ batchId: 'b3', toShelfId: 'S4' }]
  })
  // 人为把目标窖位塞满，制造办理时容量冲突
  await db.shelves.update('S4', { occupied: 1 })
  await db.batches.put(b('b9', 'S4'))
  const r = await store.executeStep(plan.id, 1)
  assert(!r.ok, '目标位被外部占满时办理失败')
  let failedPlan = await db.relocations.get(plan.id)
  assert(failedPlan?.status === '已失败', '编排单状态持久化为已失败')
  assert(Boolean(failedPlan?.steps[0].failReason), '失败步骤写入了失败原因')

  // 模拟“刷新页面”：新建 store 实例视角（数据都在 IndexedDB 里）
  setActivePinia(createPinia())
  const freshStore = useRelocationStore()
  for (let i = 0; i < 50; i += 1) {
    if (freshStore.ready) break
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const reloaded = freshStore.planOf(plan.id)
  assert(reloaded?.status === '已失败', '刷新后仍能读到失败编排单与原因')

  // 排除故障：把占位批次撤下
  await db.batches.update('b9', { shelfId: null })
  await db.shelves.update('S4', { occupied: 0 })
  const resume = await freshStore.resumePlan(plan.id)
  assert(resume.result === null, '恢复后从失败步骤续办成功')
  failedPlan = await db.relocations.get(plan.id)
  assert(failedPlan?.status === '已完成', '续办后编排单为已完成')
  assert(failedPlan?.steps[0].failReason === '', '重试成功后清空失败原因')
  const b3 = await db.batches.get('b3')
  assert(b3?.shelfId === 'S4' && b3.state === '熟成中', 'b3 已上架 S4 且状态推进为熟成中')
}

// ---- 6. 全量导出带上编排单 ----
console.log('6. 导出包含编排单')
{
  const snapshot = await exportSnapshot()
  assert((snapshot.relocations?.length ?? 0) >= 2, `快照含编排单 ${snapshot.relocations?.length} 张`)
  assert(
    snapshot.relocations?.every((p) => Array.isArray(p.steps)) ?? false,
    '导出的编排单带完整步骤状态'
  )
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)
