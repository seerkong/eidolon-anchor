# Design: add-tui-input-and-material-state-foundations

## 目标

把 prototype TUI 当前仍然分散的三条底座能力一次收拢到可持续形态：

- 结构化 composer 输入链
- materials/shared selection 的 graph 化状态底座
- file picker 与 frecency 驱动的文件注入

完成后，后续 system management surfaces、approval/history 和更完整的 command/material surfaces 可以建立在统一输入与状态真相之上，而不是继续依赖临时 bridge。

## 当前现状

### 1. composer 仍主要是纯 textarea

当前主输入组件是 [composer.tsx](terminal/packages/tui/src/cli/cmd/tui/prototype/features/composer/composer.tsx)。

它已经具备：

- `enter` / `alt+enter` 的基础提交与换行
- focus 切换
- 最小预览与字符计数

但它尚未真正接入：

- slash / mention / file / image 的结构化 prompt part
- extmark 驱动的虚拟文本占位
- prompt history 的结构化恢复

结论：composer 本体可复用，但其上层 prompt-part orchestration 尚未回到 prototype 主链。

### 2. 结构化输入素材存在，但未进入当前主链

已存在的素材包括：

- [extmarks.ts](terminal/packages/tui/src/cli/cmd/tui/prototype/features/composer/materials/extmarks.ts)
- [prompt-history.tsx](terminal/packages/tui/src/cli/cmd/tui/prototype/features/composer/materials/prompt-history.tsx)
- `prompt-info.ts`
- `paste.ts`

这些文件说明仓库里已经有：

- prompt part 的 source range 约定
- extmark 与 part index 的同步机制
- prompt history 的 JSONL 持久化

但当前 prototype 的提交链并没有把这些素材接回 `PrototypeView -> Composer -> runtime submit` 主链。

结论：本 track 不是从零设计协议，而是要把已有素材重新挂回真实输入路径。

### 3. shared/material state 仍依赖 bridge context

当前 prototype 中与 system/materials 相关的状态，主要分散在：

- [sync-context.tsx](terminal/packages/tui/src/cli/cmd/tui/prototype/materials/state/sync-context.tsx)
- [sync-store.ts](terminal/packages/tui/src/cli/cmd/tui/prototype/materials/state/sync-store.ts)
- [route-context.tsx](terminal/packages/tui/src/cli/cmd/tui/prototype/materials/navigation/route-context.tsx)
- [local-context.tsx](terminal/packages/tui/src/cli/cmd/tui/prototype/materials/state/local-context.tsx)

其中：

- `sync-context/sync-store` 保存 runtime 同步数据
- `route-context` 保存 prototype route
- `local-context` 保存当前 agent/model 选择与本地偏好

这些能力当前能工作，但它们仍然是并行状态真相。继续在这些 context 上叠加 session/provider/model/agent/MCP surfaces，会放大选择态与展示态的漂移。

结论：要把“当前选择态 + materials 读取态”收敛到 graph projection，上述 context 只保留 adapter 或 host 职责。

### 4. frecency 已存在，但没有 file picker 消费它

当前已有 [frecency.tsx](terminal/packages/tui/src/cli/cmd/tui/prototype/infra/perf/frecency.tsx)，能：

- 持久化文件使用记录
- 计算 frecency 分数
- 更新最近打开文件

但 prototype 里还没有真正的文件选择器来：

- 发现候选文件
- 结合 frecency 排序
- 把文件插入到 composer 作为结构化 prompt part

结论：frecency 已经是底件，当前缺口是“picker surface + insertion bridge”。

## 设计原则

### 1. 输入链与状态底座一次收敛

这个 merged track 的价值不在于堆功能数，而在于避免：

- 先接一版 slash/mention
- 再改一版 graph state
- 再补一版 file picker

导致三次打断同一条 composer 主链。

### 2. graph 只接管当前真相，不吞掉所有本地持久化

要进入 graph 的是：

- 当前 route / current selection / active material read model
- system surfaces 与 composer 需要共同读取的当前态

不必强行 graph 化的是：

- prompt history JSONL
- frecency JSONL
- favorite/recent 这类本地偏好文件

这些保持 adapter 即可，但对外暴露的“当前选择结果”应收敛到 graph。

### 3. 结构化输入必须与 plain textarea 共存

本 track 不能把 prototype 改成“只有结构化 part 才能提交”的形态。目标应为：

- 纯文本继续正常工作
- slash/mention/file/image 进入结构化 part
- extmark 只承担可视占位和 part range 对齐

### 4. file picker 是输入能力，不是独立系统面

它的主要职责是为 composer 生产结构化 file part，并用 frecency 优化候选排序，不应演变成与系统管理 surfaces 并列的独立产品形态。

## 目标方案

### 1. 为 prototype 建立 graph-backed input/material snapshot

建议在现有 [graph.ts](terminal/packages/tui/src/cli/cmd/tui/prototype/graph.ts) 基础上扩展，至少容纳：

- 当前 route / session scope
- 当前 agent/provider/model selection
- composer 所需的 prompt info snapshot
- system/material surfaces 所需的只读 selection/material snapshot

约束：

- `sync-context` 继续负责 runtime bootstrap 和 event ingest
- `local-context` 中的偏好存储继续作为 adapter
- 组件消费优先从 graph 读取“当前态”

### 2. 恢复 prompt part orchestration

建议把 composer 上层分为两层：

- `textarea` 自身文本交互
- prompt part orchestration

后者负责：

- slash / mention / file / image part 的插入
- extmark range 恢复与同步
- prompt history 读写
- 提交前把 plain text + structured parts 组装成 runtime input

### 3. 用 file picker 接入 frecency

建议新增一个轻量 file picker surface，支持：

- 基于 workspace 路径枚举候选文件
- 对候选项应用 frecency 排序
- 用户确认后插入结构化 file part
- 插入成功后更新 frecency

优先做 keyboard-first 方案；如果已有 dialog host 可复用，则优先复用现有 dialog/select 基础件。

### 4. prompt history 与 extmark 一起恢复

恢复历史输入时，不仅要恢复原始文本，还要恢复：

- part 列表
- extmark 位置
- file/agent/text virtual placeholder

否则历史里只留下文本快照，无法支撑结构化输入链的真正复用。

## Phase 分解

### Phase 1: Contract Freeze

- 冻结 prompt part、graph state、file picker 的职责边界
- 明确哪些状态进 graph，哪些保持 adapter

### Phase 2: Graph Foundations

- 让当前 selection/material current state 有统一 graph snapshot
- 让 composer / system surfaces 开始读同一份当前态

### Phase 3: Structured Composer

- 接回 extmark、prompt part、prompt history
- 让 slash/mention/file/image 能进入统一提交链

### Phase 4: File Picker And Frecency

- 落地 file picker
- 结合 frecency 排序
- 把选中文件插入为 file part，并更新历史/占位

### Phase 5: Verification

- focused tests 锁住 graph/composer/file picker 行为
- 跑 terminal TUI tests
- 手工点验结构化输入与历史恢复

## 风险与取舍

### 风险 1：graph 收敛过度，打断现有 local/sync 行为

缓解：

- 只把当前共享真相并入 graph
- bootstrap、持久化和 runtime ingest 仍先保留 adapter/context

### 风险 2：extmark 恢复与 textarea 编辑冲突

缓解：

- 先锁定 prompt part source range 规则
- 用 focused tests 覆盖插入、编辑、恢复和提交

### 风险 3：file picker 变成大而散的子系统

缓解：

- 只交付最小可用的 workspace file picker
- 不在本 track 内同时引入复杂预览、多根目录索引或远程资源浏览

## 交付结果

本 track 完成后，新的 prototype TUI 应满足：

- 纯文本与结构化输入共存
- 当前 selection/material state 有统一 graph 真相
- file picker 可基于 frecency 选择并插入文件
- prompt history 可恢复结构化 prompt part
- 后续 system management surfaces 可直接建立在这一底座之上
