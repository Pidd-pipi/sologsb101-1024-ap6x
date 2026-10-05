/* 规划器纯逻辑断言（不依赖 IndexedDB / DOM），由 scripts 下 esbuild 打包后用 node 运行 */
import { planRelocation } from '../src/utils/relocation'
import type { PlannerBatch, PlannerInput, PlannerShelf } from '../src/types/relocation'
import type { Relocation } from '../src/types/relocation'
import { projectionOfPlan } from '../src/utils/relocation'

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

function shelf(id: string, capacity: number): PlannerShelf {
  return { id, capacity }
}
function batch(id: string, shelfId: string | null): PlannerBatch {
  return { id, shelfId }
}

function input(
  batches: PlannerBatch[],
  shelves: PlannerShelf[],
  moves: PlannerInput['moves'],
  others: Relocation[] = []
): PlannerInput {
  return {
    batches,
    shelves,
    moves,
    others: others.map(projectionOfPlan)
  }
}

/** 构造一张已确认（未落任何步骤）的在办编排单，用于跨单投影测试 */
function activePlan(id: string, title: string, steps: Relocation['steps']): Relocation {
  return {
    id,
    title,
    operator: 'tester',
    plannedAt: '2026-10-04',
    turningType: '转架',
    brinePct: 0,
    status: '待执行',
    batchIds: Array.from(new Set(steps.map((s) => s.batchId))),
    shelfIds: Array.from(
      new Set(steps.flatMap((s) => [s.toShelfId, ...(s.fromShelfId ? [s.fromShelfId] : [])]))
    ),
    steps,
    failReason: '',
    createdAt: 0,
    updatedAt: 0,
    confirmedAt: 0,
    completedAt: null
  }
}
function pstep(
  seq: number,
  batchId: string,
  fromShelfId: string | null,
  toShelfId: string,
  temporary = false
): Relocation['steps'][number] {
  return {
    seq,
    batchId,
    fromShelfId,
    toShelfId,
    temporary,
    note: '',
    state: '待执行',
    turningId: null,
    doneAt: null,
    executedAt: null,
    failReason: '',
    failedAt: null
  }
}

// 场景 1：目标位有空 → 直接调拨，无临时位
{
  console.log('场景 1：空位直调')
  const r = planRelocation(
    input(
      [batch('b1', 'S1'), batch('b2', 'S2')],
      [shelf('S1', 2), shelf('S2', 2)],
      [{ batchId: 'b1', toShelfId: 'S2' }]
    )
  )
  assert(r.ok, '应规划成功')
  assert(r.steps.length === 1, `应为 1 步，实际 ${r.steps.length}`)
  assert(r.steps[0].temporary === false, '不应使用临时位')
}

// 场景 2：两组货架满位对调（cap=1），必须先经临时位
{
  console.log('场景 2：满位对调，走临时位')
  const r = planRelocation(
    input(
      [batch('b1', 'S1'), batch('b2', 'S2'), batch('b3', 'T')],
      [shelf('S1', 1), shelf('S2', 1), shelf('T', 2)],
      [
        { batchId: 'b1', toShelfId: 'S2' },
        { batchId: 'b2', toShelfId: 'S1' }
      ]
    )
  )
  assert(r.ok, `应规划成功：${r.message}`)
  assert(r.steps.some((s) => s.temporary), '应包含临时中转步骤')
  assert(r.steps.length === 3, `对调应为 3 步（中转+两次到位），实际 ${r.steps.length}`)
  const lastB1 = [...r.steps].reverse().find((s) => s.batchId === 'b1')
  const lastB2 = [...r.steps].reverse().find((s) => s.batchId === 'b2')
  assert(lastB1?.toShelfId === 'S2', 'b1 最终落在 S2')
  assert(lastB2?.toShelfId === 'S1', 'b2 最终落在 S1')
  assert(r.tempShelfIds.includes('T'), '临时位应是空闲窖位 T')
}

// 场景 3：目标窖位终态容量不足（无空位可腾）→ 拒绝并给冲突批次/目标位
{
  console.log('场景 3：容量不足拒绝启动')
  const r = planRelocation(
    input(
      [batch('b1', 'S1'), batch('x', 'S2')],
      [shelf('S1', 1), shelf('S2', 1)],
      [{ batchId: 'b1', toShelfId: 'S2' }]
    )
  )
  assert(!r.ok, '应拒绝启动')
  assert(r.conflicts.length === 1, '应有 1 条冲突')
  assert(r.conflicts[0].type === 'capacity', '冲突类型应为 capacity')
  if (r.conflicts[0].type === 'capacity') {
    assert(r.conflicts[0].shelfId === 'S2', '冲突目标窖位应为 S2')
    assert(r.conflicts[0].blockingBatchIds.includes('x'), '应指明占用冲突批次 x')
    assert(r.conflicts[0].required === 2 && r.conflicts[0].capacity === 1, '应给出需求 2 / 容量 1')
  }
}

// 场景 4：对调但全库没有任何空闲临时位 → 周转死锁拒绝
{
  console.log('场景 4：无空闲临时位，死锁拒绝')
  const r = planRelocation(
    input(
      [batch('b1', 'S1'), batch('b2', 'S2')],
      [shelf('S1', 1), shelf('S2', 1)],
      [
        { batchId: 'b1', toShelfId: 'S2' },
        { batchId: 'b2', toShelfId: 'S1' }
      ]
    )
  )
  assert(!r.ok, '无空位应对调应被拒绝')
  assert(r.conflicts[0]?.type === 'capacity', '应报容量/周转冲突')
  assert(r.message.includes('临时位'), '提示应说明没有可周转临时位')
}

// 场景 5：批次已在目标位 → 空转意向被忽略，全部空转则拒绝
{
  console.log('场景 5：空转意向')
  const r = planRelocation(
    input([batch('b1', 'S1')], [shelf('S1', 2)], [{ batchId: 'b1', toShelfId: 'S1' }])
  )
  assert(!r.ok, '全部空转应拒绝')
  assert(r.message.includes('没有需要办理的转架'), '应提示无需办理')
}

// 场景 6：三批循环挪位（1→2→3→1，三个 cap=1 窖位全满 + 一个空位 T）
{
  console.log('场景 6：三批循环挪位')
  const r = planRelocation(
    input(
      [batch('b1', 'S1'), batch('b2', 'S2'), batch('b3', 'S3')],
      [shelf('S1', 1), shelf('S2', 1), shelf('S3', 1), shelf('T', 1)],
      [
        { batchId: 'b1', toShelfId: 'S2' },
        { batchId: 'b2', toShelfId: 'S3' },
        { batchId: 'b3', toShelfId: 'S1' }
      ]
    )
  )
  assert(r.ok, `循环挪位应可解：${r.message}`)
  assert(r.tempShelfIds.includes('T'), '应使用空位 T 周转')
  const final = new Map<string, string>()
  r.steps.forEach((s) => final.set(s.batchId, s.toShelfId))
  assert(final.get('b1') === 'S2' && final.get('b2') === 'S3' && final.get('b3') === 'S1', '终态窖位正确')
}

// 场景 7：跨编排单投影——另一在办单已锁定目标窖位容量 → 后提交方冲突
{
  console.log('场景 7：跨单容量投影冲突')
  // 其他单：bX 最终从 S1 挪到 S2（S2 当前空、cap=1）
  const other = activePlan('relo_A', '先提交的单', [pstep(1, 'bX', 'S1', 'S2')])
  const r = planRelocation(
    input(
      [batch('bX', 'S1'), batch('b1', 'S1')],
      [shelf('S1', 2), shelf('S2', 1)],
      [{ batchId: 'b1', toShelfId: 'S2' }],
      [other]
    )
  )
  assert(!r.ok, '叠加在办单终态后 S2 容量不足，应拒绝')
  assert(r.conflicts[0]?.type === 'capacity', '应报容量冲突')
}

// 场景 8：同一批次被两张单操作 → batch-busy 冲突
{
  console.log('场景 8：批次并发占用冲突')
  const other = activePlan('relo_A', '先提交的单', [pstep(1, 'b1', 'S1', 'S2')])
  const r = planRelocation(
    input(
      [batch('b1', 'S1'), batch('b2', 'S2')],
      [shelf('S1', 2), shelf('S2', 2)],
      [{ batchId: 'b1', toShelfId: 'S2' }],
      [other]
    )
  )
  assert(!r.ok, '同批次重复占位应拒绝')
  assert(r.conflicts[0]?.type === 'batch-busy', '应报 batch-busy')
}

// 场景 9：满位对调时唯一空位属于别的在办单中转范围 → shelf-busy
{
  console.log('场景 9：临时位被在办单占用，后提交方收到冲突')
  const other = activePlan(
    'relo_A',
    '先提交的对调单',
    [pstep(1, 'x1', 'S3', 'T', true), pstep(2, 'x1', 'T', 'S3')]
  )
  const r = planRelocation(
    input(
      [
        batch('b1', 'S1'),
        batch('b2', 'S2'),
        batch('x1', 'S3')
      ],
      [shelf('S1', 1), shelf('S2', 1), shelf('S3', 1), shelf('T', 1)],
      [
        { batchId: 'b1', toShelfId: 'S2' },
        { batchId: 'b2', toShelfId: 'S1' }
      ],
      [other]
    )
  )
  // 注意：x1 的终态在 S3，投影后 T 仍为空位；但 T 属于他单 touchedShelfIds → shelf-busy
  assert(!r.ok, '唯一周转位被占用应拒绝')
  assert(r.conflicts.some((c) => c.type === 'shelf-busy'), '应报 shelf-busy 冲突')
}

// 场景 10：首次上架（未上架批次 → 有空位窖位）
{
  console.log('场景 10：未上架批次首次上架')
  const r = planRelocation(
    input([batch('b0', null)], [shelf('S1', 2)], [{ batchId: 'b0', toShelfId: 'S1' }])
  )
  assert(r.ok, '未上架批次应可直接排入')
  assert(r.steps.length === 1 && r.steps[0].fromShelfId === null, '源位应为 null')
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
if (failed > 0) process.exit(1)
