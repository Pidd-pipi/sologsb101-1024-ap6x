# 奶酪熟成转架与品评档案（gbcheeseage）

面向手工奶酪作坊与小型乳品工坊的熟成管理工具：把每个生产批次的**奶源 → 凝乳 → 上架窖位 → 转架/翻面/擦洗 → 库房温湿度 → 出库品评**逐环留档。

核心动作：**建奶源与生产批次 → 分配熟成库货架与窖位 → 整批调拨转架编排（临时位排程、逐步办理、失败续办）→ 排转架/翻面/擦洗计划并逐次签署 → 录温湿度曲线并处置越界 → 到期出库品评打分并回写批次结论**。

纯前端单页应用（Vue 3 + TypeScript + Element Plus + Vite + Pinia + Vue Router），**无后端、无数据库服务、无 API 服务**，全部数据保存在浏览器本地（IndexedDB / Dexie + 少量 localStorage 元数据），刷新或重启浏览器后仍然存在。

---

## 一、Docker 一键启动（推荐）

```bash
# 1. 首次启动先复制环境变量模板
cp .env.example .env

# 2. 构建并启动
docker compose up -d --build
```

启动完成后访问：**http://localhost:22824**

常用命令：

```bash
docker compose ps                 # 查看服务状态（healthy 表示就绪）
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 代码改动后重新构建
```

> 端口可在 `.env` 中通过 `FRONTEND_PORT` 修改（默认 `22824`）；容器名固定为 `${COMPOSE_PROJECT_NAME:-gbcheeseage}-frontend`。
> 容器**无状态**：不连接数据库、不挂载任何命名卷，数据全部保存在浏览器本地；迁移设备请使用应用内 `/tastings` 页的「导出 JSON / 导入 JSON」。

---

## 二、技术栈

| 分类 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3（`<script setup>` + Composition API） | 全部页面与组件使用组合式 API |
| 语言 | TypeScript（`strict: true`、`noUnusedLocals: true`） | `npm run build` 内含 `vue-tsc --noEmit` 类型检查，0 错误 |
| UI 组件库 | Element Plus 2.x（含 `@element-plus/icons-vue`） | 表格、表单、对话框、进度条、滑块、标签 |
| 构建工具 | Vite 6 | 开发服务器端口 22824 |
| 状态管理 | Pinia（setup store） | `milkStore` / `shelfStore` / `turningStore` / `relocationStore` / `tastingStore` |
| 路由 | Vue Router 4（history 模式） | nginx 侧配合 `try_files` 做 SPA fallback |
| 本地存储 | Dexie 4（IndexedDB 封装）+ localStorage | 库名 `gbcheeseage`，结构版本 `DB_VERSION = 3`，含真实 `.upgrade()` 迁移 |
| 图表 | 手写 SVG 折线（无额外依赖） | 温湿度双曲线 + 越界点标记 |
| 拖拽排序 | HTML5 原生 `draggable` 事件 | 未引入 `vuedraggable` / `dnd-kit` 等任何新依赖 |
| 容器化 | Docker 多阶段构建：`node:20-alpine` → `nginx:alpine` | 构建阶段执行类型检查与打包，运行阶段仅托管静态产物 |

---

## 三、本地开发方式

```bash
cd frontend
npm install
npm run dev        # 开发服务器 http://localhost:22824
npm run build      # 类型检查 + 生产构建，产物在 frontend/dist
npm run preview    # 本地预览构建产物（http://localhost:22824）
```

要求 Node.js 20 及以上（与 Docker 构建阶段镜像 `node:20-alpine` 保持一致）。

---

## 四、目录结构与路由

```
sologsb101-1024/
├── README.md
├── docker-compose.yml            # 顶层 name、container_name、端口映射，无 version 字段
├── .env / .env.example           # COMPOSE_PROJECT_NAME、FRONTEND_PORT（内容完全一致）
├── .gitignore
├── sologsb101-1024.md            # 提示词原文（只读）
└── frontend/
    ├── Dockerfile                # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf                # try_files SPA fallback + gzip + /assets/ 长缓存
    ├── .dockerignore
    ├── package.json / package-lock.json
    ├── tsconfig.json / vite.config.ts / index.html
    ├── public/favicon.svg
    └── src/
        ├── types/                # milk.ts batch.ts shelf.ts turning.ts relocation.ts environment.ts tasting.ts
        ├── stores/               # milkStore.ts shelfStore.ts turningStore.ts relocationStore.ts tastingStore.ts
        ├── components/common/    # GradeTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
        ├── hooks/                # useAgingDays.ts useIdbTable.ts
        ├── pages/                # MilkList.vue ShelfBoard.vue TurningPlan.vue RelocationBoard.vue EnvironmentView.vue TastingBoard.vue
        ├── router/index.ts       # 路由表 + 懒加载 + document.title
        ├── utils/                # temperature.ts relocation.ts db.ts export.ts
        ├── scripts/              # 规划算法与 IndexedDB 集成的断言脚本（esbuild 打包后用 node 运行）
        ├── styles/main.css
        ├── App.vue main.ts env.d.ts
```

| 路由 | 页面 | 主要职责 | 消费模型 |
| --- | --- | --- | --- |
| `/milk` | 奶源与批次台账 | 新建奶源与批次，按乳种 / 批次状态筛选并同步 URL query；按目标熟成天数自动算最早可出库日期；状态流转「凝乳 → 熟成中 → 已出库 / 报废」；级联删除奶源与批次 | Milk、Batch |
| `/shelves` | 熟成库货架与窖位 | 库房 / 货架号 / 层号 / 温区 / 可放块数维护，占用率卡片与进度条；上架时按余量硬校验并实时更新 `occupied`；下架释放余量 | Shelf、Batch |
| `/turnings` | 转架 / 翻面 / 擦洗作业 | 按批次生成等间隔计划（起始日 + 间隔天数 × 次数）；逐条签署「待执行 → 已完成 / 已跳过」；HTML5 原生拖拽调整同批次内顺序并写回 `seq` | Turning、Batch、Shelf |
| `/relocations` | 整批调拨转架编排 | 按窖位容量排出临时中转位与执行顺序，确认后逐步办理（同步写回批次窖位、窖位占用、转架作业与编排步骤）；失败原因持久化、刷新后续办；容量不足拒绝启动并指明冲突批次/目标窖位；两个窗口并发提交时后提交方收到冲突 | Relocation 及 Batch、Shelf、Turning |
| `/environment` | 温湿度记录与曲线 | 按温区阈值自动判定越界并标异常，提示开窗 / 加湿措施；手写 SVG 温湿度双曲线 + 越界点；一键重算异常标记 | Environment、Batch、Shelf |
| `/tastings` | 出库品评与档案导出 | 外观 / 风味 / 质地三维打分，同批次均分回写批次结论；JSON 全量导出导入（覆盖 / 追加两种模式）、单批次档案导出（含转架编排单）、重置并重新播种 | Tasting 及全部模型 |

`/` 与未匹配路径均重定向到 `/milk`；页面组件全部懒加载，`router.afterEach` 统一设置 `document.title`。

---

## 五、IndexedDB 与数据存储说明

- **数据库名**：`gbcheeseage`（Dexie 实例定义在 `frontend/src/utils/db.ts`）。
- **结构版本**：`DB_VERSION = 3`。
  - `version(1)`：初版六张业务表与索引。
  - `version(2).stores(...).upgrade(async (tx) => {...})`：**真实迁移**——为 `batches` 补齐 `shelfId` / `conclusion` / 时间戳；按作业日期为历史 `turnings` 回填 `seq` 执行序号；把湿度越界的 `environments` 记录重算为异常并补默认措施；把 `shelves` 的负数容量与占用数归零。
  - `version(3).stores(...)`：新增第七张表 `relocations`（整批调拨转架编排单）；既有六表结构与数据不变，无需数据回填。
- **七张表**：

| 表 | 模型 | 关键字段 | 索引 |
| --- | --- | --- | --- |
| `milks` | Milk 奶源 | `farm` `milkKind`(牛/羊/水牛) `collectedAt` `fatPct` `proteinPct` `note` | id, farm, milkKind, collectedAt |
| `batches` | Batch 生产批次 | `milkId` `curdedAt` `cheeseType`(硬质/软质/蓝纹/洗皮) `targetDays` `weightKg` `state` `shelfId` `conclusion` | id, milkId, shelfId, cheeseType, state, curdedAt |
| `shelves` | Shelf 窖位 | `room` `rackNo` `layerNo` `tempZone`(冷区/中温区/常温区) `capacity` `occupied` | id, room, rackNo, tempZone, occupied |
| `turnings` | Turning 转架作业 | `batchId` `shelfId` `doneAt` `type`(转架/翻面/擦洗) `brinePct` `operator` `state` `seq` `relocationId?`(编排回链) | id, batchId, shelfId, doneAt, type, state, seq |
| `environments` | Environment 环境记录 | `batchId` `recordedAt` `tempC` `humidityPct` `anomaly` `action` | id, batchId, recordedAt, anomaly |
| `tastings` | Tasting 品评 | `batchId` `outAt` `appearance/flavor/texture` 描述 + 三维评分 `score` `conclusion` `taster` | id, batchId, outAt, score, conclusion |
| `relocations` | Relocation 转架编排单 | `title` `operator` `plannedAt` `turningType` `status`(待执行/执行中/已完成/已失败/已取消) `batchIds[]` `shelfIds[]` `steps[]`（每步含 from/to 窖位、`temporary` 是否临时中转、步骤状态、`turningId` 幂等键、`failReason` 失败原因） | id, status, createdAt, updatedAt |

- **整批调拨转架编排的一致性保证**（核心逻辑在 `frontend/src/utils/relocation.ts` 与 `stores/relocationStore.ts`）：
  - **先排程再办理**：`planRelocation()` 是纯函数规划器，按窖位容量模拟占用，遇到两组货架对调/整库挪位造成的目标位互相占满时，自动把批次先挪到空闲**临时位**缓冲，排出「中转 + 到位」的可执行顺序；终态容量不足或全库没有可周转空位时拒绝启动，错误里指明冲突批次与目标窖位（需求块数 / 容量 / 占用批次）。
  - **逐步原子办理**：每一步在同一个 IndexedDB readwrite 事务内同步写回「批次 `shelfId` → 窖位 `occupied`（按在架批次数重算）→ 一条已完成转架作业 → 编排步骤状态」。步骤的 `turningId` 是幂等键，已落地的步骤重复办理只会命中 `alreadyDone`，不重复占位、不再生成作业。
  - **失败可续办**：办理事务失败时业务写入随事务回滚，失败原因随后持久化到步骤与编排单（状态 `已失败`）；`resumePlan()` 从第一个「待执行 / 失败」步骤恢复未完成队列续办。全部编排单、步骤状态、失败原因只存 IndexedDB，刷新页面后接着处理。
  - **并发冲突**：创建编排单的「读取在办单 → 容量试算 → 写入」放在同一个 readwrite 事务内。IndexedDB 同源读写事务在多个浏览器窗口/标签页之间严格串行，因此两个窗口几乎同时提交不同编排单时，后提交方一定读到先提交方已落库的在办单，并收到 `RelocationConflictError`（批次被锁 / 临时位被占 / 叠加终态后容量不足）。
- **首屏自动播种**：`initDatabase()` 在 `db.open()` 后执行 `if ((await db.milks.count()) === 0) { await seedDatabase() }`，播种 3 层互相引用的演示数据（奶源 3 → 生产批次 4 → 转架 4 / 环境 4 / 品评 3 + 1 张待执行的转架编排单），使用固定 id + `bulkPut`，**幂等**（重复调用不会产生重复记录）。
- **localStorage**：仅存元数据 —— `gbcheeseage:db-version`（本地结构版本）、`gbcheeseage:last-backup-at`（最近一次导出时间）、`gbcheeseage:ui-prefs`（当前库房、作业排序方式、曲线指标）。
- **导出 / 导入**：`frontend/src/utils/export.ts` 提供 `exportSnapshotJson()`（全量，含全部编排单）、`exportBatchArchiveJson(batchId)`（单批次档案，含步骤涉及该批次的编排单及其临时位窖位）与 `parseSnapshotJson()` 校验（校验 `app` 字段、各集合数组、父子引用完整性——含编排步骤对批次的引用，失败抛出原因且不写入任何数据）；`/tastings` 页支持「覆盖导入」与「追加导入（重新分配 id）」。旧版导出文件缺少 `relocations` 字段时按空数组兼容处理。
- **隐私与无状态**：数据不上传任何服务器，容器不挂载命名卷；清理浏览器站点数据或更换浏览器会丢失档案，请定期导出备份。

---

## 六、常见问题

| 问题 | 说明 |
| --- | --- |
| 端口被占用 | 修改 `.env` 中的 `FRONTEND_PORT`（或临时 `FRONTEND_PORT=22825 docker compose up -d --build`）后重新启动 |
| favicon / 静态资源 403 | `frontend/Dockerfile` 在 `COPY --from=builder /app/dist /usr/share/nginx/html` 之后紧接 `RUN chmod -R a+rX /usr/share/nginx/html`，已规避宿主机 0600 权限被原样带入镜像后 nginx worker（uid=101）读不到文件的问题 |
| 中文目录名导致 compose 项目名为空 | `docker-compose.yml` 顶层已写 `name: gbcheeseage` 兜底，任意目录名（含中文）下 `docker compose config --quiet` 均不报错 |
| 刷新子路由 404 | `nginx.conf` 使用 `try_files $uri $uri/ /index.html;` 做 SPA fallback，`/assets/` 走带 hash 的长缓存 |
| 数据看起来是空的 | 数据只存在当前浏览器；首次打开会自动播种演示数据，也可以用 `/tastings` 页的「重置并重新播种」或导入之前的导出文件 |
| 换浏览器 / 换设备数据不同步 | 属预期行为（纯前端无后端），请用 `/tastings` 页的 JSON 导出导入迁移 |
