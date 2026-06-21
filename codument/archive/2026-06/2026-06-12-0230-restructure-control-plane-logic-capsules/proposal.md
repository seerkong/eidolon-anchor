# 变更：重构控制面三集群为 Capsule 形态

## 背景和动机 (Context And Why)

前置 track（runtime-control-component-boundaries，已归档）已把控制面的边界做成可执行契约：boundary declaration、sync_command/async_message 分类、coordinator/writer 分离、core logic 无 IO——且 conformance 证明当前声明的核心符号是干净的。但三个集群的代码组织仍是历史形态：OrchestratorDriver 约 2000 行单文件，RuntimeSnapshots 约 1670 行混合 writer/恢复/支撑配置，engine 虽最接近目标但无 capsule 结构。

本 track 在契约与 conformance 的保护下完整重构三集群为 capsule 形态，并把 reducer/projection 加工定义提升为 contract 中的类型化 derivation contract。这是用户确认的"契约优先、渐进重构"两步走的第二步。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**

- 三集群各自重构为 capsule：稳定 core logic 入口（`output = fn(runtime, input, config)`）、adapter registry（枚举 id 布线）、按适配轴分目录的 adapters、不可外部 import 的 internals；**类型全部留在对应 contract 包**（本项目 contract/logic 包级分离，capsule 不含 types 部分）。
- 三集群的 reducer/projection 加工定义提升为 derivation contract（必需方法集合 + 运行时断言），实现注入到基于既有 vendor/platform 原语的流转布线。
- 行为保持：前置 track 全部 conformance 持续绿色、既有失败基线不增、调用方表面经兼容导出继续工作。
- 随文件移动同步更新 boundary declaration 与 encapsulation conformance 的源码映射。

**非目标:**

- 不删除 AiRuntimeTurnSupervisor（实施中证实已接线进 live turn 主路径，删除属行为变更；移除归入 refactor-ai-turn-tool-provider-lifecycle，见 decisions.md 决策 3）。

- 不改变三集群的对外行为语义（纯结构重构）。
- 不重新实现 scheduler、mailbox、dispatch、store（必须建立在 depa-actor / depa-processor / depa-data-graph 上）。
- 不把 conversation truth、tool result truth、turn state 引入控制面。
- 不迁移 persistence backplane（checkpoint/journal backplane 归后续 track）。
- 不修复历史 session，不处理与本 track 无关的既有失败基线。

## 变更内容（What Changes）

- contract 包新增三集群的 derivation contract 类型与断言 helper。
- `ai-runtime-control-logic`：engine 重构为 capsule（coreLogic / adapterRegistry / adapters / internals）。
- `ai-runtime-control-composer` + `ai-organ-logic/persistence`：coordinator 重构为 capsule，writer 与决策按既定边界声明切分落位。
- `ai-organ-logic`：OrchestratorDriver 重构为 capsule，调度状态机与 scheduler signal 投影按 derivation contract 拆出。
- **BREAKING（包内部结构）**：集群源文件路径与内部符号组织变化；对外经兼容导出维持调用方不破坏。
- 更新 boundary declaration（coreLogicEntries/outerAdapterSurface 指向新符号）与 encapsulation conformance 的源码映射。

## 影响范围（Impact）

- 受影响的功能规范：`control-plane-logic-capsules`（新增）；`runtime-control-component-boundaries`（其 conformance 作为行为保持闸门持续生效，声明内容随符号移动更新）。
- 可能影响的代码区域：
  - `cell/packages/platform-contract`（derivation contract 通用断言 helper 候选宿主）
  - `cell/packages/ai-core-contract`（三集群 derivation contract 类型与 boundary declaration 更新）
  - `cell/packages/ai-runtime-control-contract`（engine derivation/state 类型补充）
  - `cell/packages/ai-runtime-control-logic`（engine capsule）
  - `cell/packages/ai-runtime-control-composer`（coordinator capsule）
  - `cell/packages/ai-runtime-control-support`（adapter 落位）
  - `cell/packages/ai-organ-logic`（driver capsule、RuntimeSnapshots 切分；supervisor 保留冻结、零改动）
  - 相关测试包（conformance 源码映射更新）
