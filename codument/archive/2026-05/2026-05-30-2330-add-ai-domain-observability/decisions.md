# Decisions

## Usage
- 用于记录需要用户确认的决策问题、选项、最终结论与理由
- 问题标题不用字母前缀；字母只用于选项
- 后续执行过程中出现的新决策，也继续追加到本文件，不新建分散的决策记录

---

### 1. 【P0】TraceMiddleware 的挂载粒度

- 背景：当前 eidolon-anchor 只有一个 DataGraph 实例（TuiA1StateGraph.graph），未来可能多个。TraceMiddleware 应该挂在哪个层级？
- 需要决定：Middleware 的注册位置
- 选项：
  - A) 直接在 TuiA1StateGraph 构造函数中 `this.graph.use(traceMiddleware({...}))`
  - B) 创建一个 `createObservableGraph()` 工厂函数，自动附加所有 observability middleware，TuiA1StateGraph 改用此工厂
  - C) 在 DataGraph 外层的 runtime/agent 层面注册，与 TUI graph 解耦
- 当前建议：**A** — 当前只有一个 graph 实例，直接挂载最简单且足够；如果未来有多个 graph，再提取工厂
- 用户答复：B — 创建 createObservableGraph() 工厂函数，自动附加所有 observability middleware
- 最终决策：B
- 决策理由：统一 observability 装配点，未来多 graph 场景可复用，避免每个 graph 手动注册 middleware
- 状态：confirmed

---

### 2. 【P0】Diagnostic Signal 节点的命名约定

- 背景：Provider Diagnostic Collector 需要在 DataGraph 中创建多个 signal 节点（如 `diag.modelSelection`、`diag.turnTimings`），这些节点与 TUI state 节点（`snapshot`、`messages` 等）共存于同一个 DataGraph
- 需要决定：Diagnostic signal 的命名和组织方式
- 选项：
  - A) 平铺在 graph 根级别，使用 `diag.` 前缀（如 `diag.modelSelection`、`diag.turnTimings`）
  - B) 创建一个嵌套的 diagnostic 子图/模块，通过 `mountGraph` 隔离
  - C) 不放入 DataGraph，Diagnostic 数据完全走 StreamGraph 管线，仅在最后通过 GraphBridge 回灌少量摘要 signal
- 当前建议：**A** — 平铺 + 前缀最简单，StreamGraph 可通过 GraphBridge.signalToStreamNode 按需桥接；B 引入额外复杂度，C 可能丢失 DataGraph 原生的 computed 依赖追踪
- 用户答复：B — 创建嵌套 diagnostic 子图/模块，通过 mountGraph 隔离
- 最终决策：B
- 决策理由：命名空间隔离，避免 diag 节点污染 TUI state 节点；子图内部可独立定义 computed，不影响主图重算范围
- 状态：confirmed

---

### 3. 【P1】Scene Replay 的 CLI 入口位置

- 背景：Scene Replay 需要 CLI 命令触发
- 需要决定：CLI 命令的实现位置
- 选项：
  - A) 在 `terminal/packages/organ/` 中新增 `src/cli/replay.ts`，作为独立 CLI 入口
  - B) 复用现有 terminal CLI 框架（如果已有）
  - C) 先作为纯 TypeScript 函数导出（`runSceneReplay(scene, options)`），确保可编程调用；CLI wrapper 后续添加
- 当前建议：**C** — 先实现核心函数，CLI 包装在后续 phase 完成
- 用户答复：B — 复用现有 terminal CLI 框架（@terminal/cli，基于 yargs CommandModule）
- 最终决策：B
- 决策理由：`@terminal/cli` 已使用 yargs CommandModule 模式（exec/run/thread），replay 命令遵循相同模式，保持 CLI 一致性
- 状态：confirmed

---

### 4. 【P1】Scene 文件的存储格式和位置

- 背景：录制 scene 时需要选择存储格式和默认路径
- 需要决定：Scene 的存储格式和默认目录
- 选项：
  - A) JSONL 文件，存储在 `codument/tracks/<track_id>/scenes/` 下
  - B) 单文件 JSON 数组，存储在项目根目录 `scenes/` 下
- 当前建议：**A** — JSONL 格式（每行一个事件，方便追加和流式读取）
- 用户答复：使用 xnl-core 库，xnl 语法支持类似 JSONL 的 append only 格式，写入 text node
- 最终决策：xnl-core TextElementNode + TREE_ADD mutation
- 决策理由：xnl-core 已在项目中被引用，TextElementNode + mutation append 天然支持流式追加，applyMutations 保证写入原子性，比纯 JSONL 更具结构化和可扩展性
- 状态：confirmed

---

### 5. 【P2】持久化存储的技术选型

- 背景：JSONL 导出模式下，trace 需要写入文件系统
- 需要决定：Node.js 端的文件写入方式
- 选项：
  - A) Node.js `fs.appendFileSync` — 最简单
  - B) 通过 depa-data-graph 的 `persistPlugin` + 自定义 `PersistStorage` adapter — 与现有插件体系一致
  - C) 使用 `AppendOnlyEventLog` + 定期 flush 到文件 — 利用已有 log 抽象
- 当前建议：**C** — `AppendOnlyEventLog` 已经在 TuiA1StateGraph 中使用，保持一致的编程模型；提供 `flushToFile(path)` 方法
- 用户答复：C — AppendOnlyEventLog + 定期 flush 到文件
- 最终决策：C
- 决策理由：与 TuiA1StateGraph 已有的 AppendOnlyEventLog 编程模型一致；flushToFile 方法简洁；AppendOnlyEventLog 用于运行时 trace，xnl 用于 scene 持久化，职责分离
- 状态：confirmed
