import { db, type KvRecord } from '@/utils/db'

/**
 * 跨标签页互斥与同步：
 * - 编排锁存放在 IndexedDB 的 kv 表，借助 Dexie 读写事务在同一对象仓上的
 *   原子性（IndexedDB 对同一对象仓的 readwrite 事务天然跨标签页串行），
 *   实现「后提交一方收到冲突结果」；
 * - BroadcastChannel 用于编排单落地后通知其他标签页刷新列表；
 * - 锁带 TTL，标签页崩溃后自动释放；页面隐藏时主动释放。
 */

const TAB_ID = `tab_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const LOCK_KEY = 'orchestration:lock'
const LOCK_TTL_MS = 60_000

interface OrchestrationLockValue {
  ownerId: string
  planId: string
  acquiredAt: number
  expiresAt: number
}

function isLiveLock(record: KvRecord | undefined): record is KvRecord & { value: OrchestrationLockValue } {
  if (!record || typeof record.value !== 'object' || record.value === null) return false
  const value = record.value as Partial<OrchestrationLockValue>
  return (
    typeof value.ownerId === 'string' &&
    typeof value.expiresAt === 'number' &&
    value.expiresAt > Date.now()
  )
}

/** 尝试获取全局编排锁：已被其他标签页持有时返回 ok=false（冲突结果） */
export async function acquireOrchestrationLock(
  planId: string
): Promise<{ ok: boolean; heldBy?: string }> {
  return db.transaction('rw', db.kv, async () => {
    const current = await db.kv.get(LOCK_KEY)
    if (isLiveLock(current) && current.value.ownerId !== TAB_ID) {
      return { ok: false, heldBy: current.value.ownerId }
    }
    await db.kv.put({
      id: LOCK_KEY,
      value: {
        ownerId: TAB_ID,
        planId,
        acquiredAt: Date.now(),
        expiresAt: Date.now() + LOCK_TTL_MS
      } satisfies OrchestrationLockValue
    })
    return { ok: true }
  })
}

/** 释放本标签页持有的编排锁 */
export async function releaseOrchestrationLock(): Promise<void> {
  await db.transaction('rw', db.kv, async () => {
    const current = await db.kv.get(LOCK_KEY)
    if (isLiveLock(current) && current.value.ownerId === TAB_ID) {
      await db.kv.delete(LOCK_KEY)
    }
  })
}

/** 心跳续期：执行期间每 15s 刷新一次 TTL */
export async function heartbeatOrchestrationLock(): Promise<void> {
  await db.transaction('rw', db.kv, async () => {
    const current = await db.kv.get(LOCK_KEY)
    if (isLiveLock(current) && current.value.ownerId === TAB_ID) {
      current.value.expiresAt = Date.now() + LOCK_TTL_MS
      await db.kv.put(current)
    }
  })
}

/** 查询锁状态：供页面提示「另一窗口正在执行」 */
export async function refreshOrchestrationLock(): Promise<{
  heldByOther: boolean
  planId?: string
}> {
  const current = await db.kv.get(LOCK_KEY)
  if (isLiveLock(current) && current.value.ownerId !== TAB_ID) {
    return { heldByOther: true, planId: current.value.planId }
  }
  return { heldByOther: false }
}

const CHANNEL_NAME = 'gbcheeseage-sync'

type ChangeListener = () => void

/** 广播编排单变更（创建 / 落地 / 完成 / 取消） */
export function notifyTransfersChanged(): void {
  try {
    const channel = new BroadcastChannel(CHANNEL_NAME)
    channel.postMessage({ type: 'transfer-changed', at: Date.now() })
    channel.close()
  } catch {
    /* BroadcastChannel 不可用时忽略，liveQuery 仍会更新本标签页 */
  }
}

/** 订阅其他标签页的编排单变更，返回退订函数 */
export function onTransfersChanged(listener: ChangeListener): () => void {
  try {
    const channel = new BroadcastChannel(CHANNEL_NAME)
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'transfer-changed') listener()
    }
    channel.addEventListener('message', handler)
    return () => channel.removeEventListener('message', handler)
  } catch {
    return () => undefined
  }
}
