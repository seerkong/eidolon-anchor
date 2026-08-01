# 变更：添加 Runtime Data Subgraph Contracts

## 背景和动机 (Context And Why)

Runtime 中的 provider context、formal history、tool result、turn state、checkpoint、journal、projection 和 TUI surface 目前由多条代码路径共同维护。历史事故显示，重复工具调用、history 写入滞后、pending effect、TUI/CLI 表现差异等现象，不适合继续用单点补丁处理。

本 track 的目标是先建立数据面硬边界：用 DataSubgraphContract 明确哪些数据节点是事实、哪些是衍生、谁拥有写入、哪些文件/对象不能作为 live truth。后续控制面、conversation spine、persistence backplane 和 surface isolation 都应依赖这些 contract。

## “要做”和“不做” (Goals / Non-Goals)

目标：

- 定义 Runtime DataSubgraphContract 的通用形态。
- 定义 runtime fact grade 枚举和判定规则。
- 定义首批 AI runtime data components：
  - ActorRuntimeDataComponent
  - AiTurnStateDataComponent
  - HistoryDomainDataComponent
  - LlmContextDomainDataComponent
  - SessionDomainDataComponent
  - ToolCallDomainDataComponent
  - ProviderCallDomainDataComponent
  - RuntimeControlDataComponent
  - CheckpointSnapshotDataComponent（最小 owner contract）
  - SurfaceProjectionComponent
- 为每个 component 声明 owned fact nodes、derived nodes、write commands、read views、fact streams、projection sinks、Not Owned Here。
- 添加 conformance tests，防止 journal、checkpoint snapshot、projection、surface view 成为 live truth。

非目标：

- 不迁移真实写入路径。
- 不重构 executor 主流程。
- 不修改 TUI/CLI 行为。
- 不修复或升级任何历史 session。
- 不拆分现有包的大规模文件结构。

## 变更内容（What Changes）

- 新增或收敛 runtime data subgraph contract 类型。
- 新增 fact grade 定义与分类 helper。
- 新增首批 data component contract registry。
- 新增 Not Owned Here 断言能力。
- 新增 conformance tests：
  - pending effect 不等于 tool result truth。
  - checkpoint snapshot 不拥有 formal history。
  - TUI projection 不能写 domain truth。
  - history persistence 滞后不影响 live provider context。

## 影响范围（Impact）

- 受影响的功能规范：`runtime-data-subgraph-contracts`。
- 可能影响的代码区域：
  - `cell/packages/platform-contract`（通用 contract shape 与 fact grade 宿主）
  - `cell/packages/ai-core-contract`
  - `cell/packages/ai-core-logic`
  - `cell/packages/ai-organ-logic`
  - `cell/packages/ai-runtime-control-*`
  - `cell/packages/ai-support`
  - `terminal/packages/*`
- 本 track 首阶段应以 contract 和 tests 为主，避免直接迁移运行路径。
