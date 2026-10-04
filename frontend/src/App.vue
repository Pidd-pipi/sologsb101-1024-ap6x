<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Grid, MilkTea, Odometer, Sort, Star } from '@element-plus/icons-vue'
import { useMilkStore } from '@/stores/milkStore'
import { useShelfStore } from '@/stores/shelfStore'
import { useTastingStore } from '@/stores/tastingStore'
import { useTurningStore } from '@/stores/turningStore'

const route = useRoute()
const router = useRouter()
const milkStore = useMilkStore()
const shelfStore = useShelfStore()
const turningStore = useTurningStore()
const tastingStore = useTastingStore()

const navItems = computed(() => [
  { path: '/milk', label: '奶源与批次', icon: MilkTea, badge: String(milkStore.batches.length) },
  { path: '/shelves', label: '货架与窖位', icon: Grid, badge: `${shelfStore.occupancyPercent}%` },
  { path: '/turnings', label: '转架作业', icon: Sort, badge: String(turningStore.summary.pending) },
  { path: '/environment', label: '温湿度', icon: Odometer, badge: '' },
  { path: '/tastings', label: '出库品评', icon: Star, badge: String(tastingStore.tastings.length) }
])

const activePath = computed(() => route.path)

function go(path: string): void {
  void router.push(path)
}
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div class="app-header__brand">
        <span class="app-header__mark">酪</span>
        <div>
          <h1 class="app-header__title">奶酪熟成转架与品评档案</h1>
          <p class="app-header__sub">奶源 · 批次 · 窖位 · 转架 · 温湿度 · 品评</p>
        </div>
      </div>
      <nav class="app-nav">
        <button
          v-for="item in navItems"
          :key="item.path"
          class="app-nav__item"
          :class="{ 'is-active': activePath === item.path }"
          type="button"
          @click="go(item.path)"
        >
          <el-icon><component :is="item.icon" /></el-icon>
          <span>{{ item.label }}</span>
          <em v-if="item.badge" class="app-nav__badge">{{ item.badge }}</em>
        </button>
      </nav>
    </header>

    <main class="app-main">
      <router-view v-slot="{ Component }">
        <component :is="Component" />
      </router-view>
    </main>

    <footer class="app-footer">
      <span>数据仅存于本浏览器（IndexedDB / Dexie + localStorage），不上传任何服务器。</span>
      <span>
        在熟成批次 {{ milkStore.overview.agingBatchCount }} 个 · 窖位占用率
        {{ shelfStore.occupancyPercent }}% · 品评均分 {{ tastingStore.avgScore || 0 }} 分
      </span>
    </footer>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.app-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 24px;
  background: linear-gradient(120deg, #6b4a1f 0%, #9a6b23 55%, #c9922f 100%);
  color: #fdf6e7;
}

.app-header__brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.app-header__mark {
  display: grid;
  width: 40px;
  height: 40px;
  place-items: center;
  border: 1px solid rgba(255, 255, 255, 0.32);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.14);
  font-size: 20px;
  font-weight: 700;
}

.app-header__title {
  margin: 0;
  font-size: 18px;
  letter-spacing: 2px;
}

.app-header__sub {
  margin: 2px 0 0;
  color: rgba(253, 246, 231, 0.78);
  font-size: 12px;
  letter-spacing: 1px;
}

.app-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.app-nav__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border: 1px solid rgba(255, 255, 255, 0.24);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  color: #fdf6e7;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.18s ease;
}

.app-nav__item:hover {
  background: rgba(255, 255, 255, 0.16);
}

.app-nav__item.is-active {
  background: #fdf6e7;
  color: #8a5a1c;
  font-weight: 600;
}

.app-nav__badge {
  padding: 0 6px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.18);
  font-size: 11px;
  font-style: normal;
}

.app-main {
  flex: 1;
  width: 100%;
  max-width: 1360px;
  margin: 0 auto;
  padding: 20px 24px 32px;
}

.app-footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 24px 20px;
  color: #8c8479;
  font-size: 12px;
}
</style>
