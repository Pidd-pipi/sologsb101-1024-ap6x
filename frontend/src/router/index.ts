import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

const APP_TITLE = '奶酪熟成转架与品评档案'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    redirect: '/milk'
  },
  {
    path: '/milk',
    name: 'milk-list',
    component: () => import('@/pages/MilkList.vue'),
    meta: { title: '奶源与批次台账', icon: 'MilkTea' }
  },
  {
    path: '/shelves',
    name: 'shelf-board',
    component: () => import('@/pages/ShelfBoard.vue'),
    meta: { title: '货架与窖位', icon: 'Grid' }
  },
  {
    path: '/turnings',
    name: 'turning-plan',
    component: () => import('@/pages/TurningPlan.vue'),
    meta: { title: '转架作业计划', icon: 'Sort' }
  },
  {
    path: '/relocations',
    name: 'relocation-board',
    component: () => import('@/pages/RelocationBoard.vue'),
    meta: { title: '整批调拨转架编排', icon: 'Switch' }
  },
  {
    path: '/environment',
    name: 'environment-view',
    component: () => import('@/pages/EnvironmentView.vue'),
    meta: { title: '温湿度记录', icon: 'Odometer' }
  },
  {
    path: '/tastings',
    name: 'tasting-board',
    component: () => import('@/pages/TastingBoard.vue'),
    meta: { title: '出库品评档案', icon: 'Star' }
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/milk'
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 })
})

router.afterEach((to) => {
  const title = typeof to.meta.title === 'string' ? to.meta.title : APP_TITLE
  document.title = `${title} · ${APP_TITLE}`
})

export default router
