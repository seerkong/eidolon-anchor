# 变更：重构 Runtime 控制面组件边界

## 背景和动机 (Context And Why)

数据面已经建立 DataSubgraphContract（含 `runtime_control` 组件的 owner 与反边界），扩展面已经统一 profile composition path。控制面是下一个边界：orchestrator driver、runtime-control engine、snapshot 协调三个 logic 集群目前没有工程化的封装与 command/message 边界声明——历史事故（fiber 既闲又等、半步状态落盘、恢复元数据反向驱动 live loop）都与此相关。

本 track 把控制面的边界做成可执行契约：标准组件封装声明（复用 depa-processor 既有 adapter 原语）、同步 command / 异步 message 分类、snapshot coordinator/writer 分离，并对三个 logic 集群做通过 conformance 所需的最小重构。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**

- 定义控制面 Logic Component boundary declaration contract（core logic 入口、注入 effect contracts、outer adapter 表面、sync_command/async_message 入口分类）。
- 为 OrchestratorDriverLogic、RuntimeControlEngineLogic、SnapshotCoordinatorLogic 三个集群声明边界。
- 添加 command/message boundary conformance cases（同步走公开 reducer、跨 actor 走 mailbox、不绕过 owner）。
- 添加 snapshot coordinator/writer 分离 conformance（writer 不调度、coordinator 在边界决定推进或跳过）。
- 对三个集群做通过上述 conformance 所需的最小分层重构。

**非目标:**

- 不完整重写三个 logic 集群的 outer/inner 结构（由后续独立 track 承担）。
- 不重新实现 scheduler、mailbox 或 dispatch（必须建立在 depa-actor / depa-actor-control / depa-processor 上）。
- 不把 conversation truth、tool result truth、turn state 放进 runtime-control。
- 不迁移 persistence backplane（checkpoint/journal/derived index 的 backplane 归后续 track）。
- 不修复或升级历史 session。

## 变更内容（What Changes）

- 新增控制面 logic component boundary declaration 类型与注册。
- 新增 sync_command / async_message 入口分类与断言 helper。
- 为三个控制面集群补 boundary declaration。
- 新增 conformance tests：标准封装（core logic 无直接 IO、复用 vendor adapter）、command/message 边界、snapshot coordinator/writer 分离、engine effect 经 contract 执行。
- 最小重构：仅修复 conformance 暴露的违反点。

## 影响范围（Impact）

- 受影响的功能规范：`runtime-control-component-boundaries`。
- 可能影响的代码区域：
  - `cell/packages/platform-contract`（boundary declaration 通用类型候选宿主）
  - `cell/packages/ai-runtime-control-contract` / `ai-runtime-control-logic`（engine 边界与 conformance）
  - `cell/packages/ai-core-contract`（控制面组件声明与 DataSubgraphContract 对齐）
  - `cell/packages/ai-organ-logic`（OrchestratorDriver、RuntimeSnapshots 的最小重构）
  - `cell/packages/ai-runtime-control-composer`（coordinator/writer 分离的 conformance）
- 本 track 契约与测试优先，代码重构限于 conformance 所需的最小范围。
