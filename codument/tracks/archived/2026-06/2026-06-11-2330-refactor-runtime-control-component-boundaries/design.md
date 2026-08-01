# 设计：Runtime 控制面组件边界

## 上下文

控制面负责"如何运行、如何编排、如何调度、如何等待、如何恢复"。当前三个 logic 集群（orchestrator driver、runtime-control engine、snapshot 协调）功能完整，但缺少三件事的工程化表达：

1. 标准组件封装边界（哪里是 outer adapter、哪里是纯 core logic、副作用从哪注入）。
2. 同步 command 与异步 message 的入口分类。
3. snapshot coordinator 与 writer 的职责分离声明。

数据面的 `runtime_control` DataSubgraphContract 已声明该组件拥有什么、不拥有什么；本 track 给控制面的"行为方式"补上同等硬度的契约。

## 方案概览

### 1. Logic Component Boundary Declaration

每个控制面 logic component 声明：

- `id` 与所属层（platform / platform-domain bridge）。
- `coreLogicEntries`：纯逻辑入口清单（函数名/模块），core logic 只接受显式 runtime 注入。
- `injectedEffectContracts`：core logic 依赖的副作用 contract 清单（persistence、effect handler、clock 等）。
- `outerAdapterSurface`：outer 层负责的框架关注点（参数规整、错误包装、runtime binding）。
- `entries`：每个对外入口标注 `sync_command` 或 `async_message`。
- `forbiddenDirectIo`：core logic 禁止直接调用的 IO 形态（fs、provider、terminal、全局单例）。

声明本身是数据（可测试、可断言），与 DataSubgraphContract 的风格一致。

### 2. 封装模板：复用 depa-processor

- 不新建封装框架。outer/inner 分层使用 `depa-processor` 的 `runByFuncStyleAdapter` 与 `stdMake*` 原语（工具层已有使用先例，作为 house style 参考）。
- 本 track 只要求：boundary declaration 中列出的 coreLogicEntries 是可独立调用的纯函数（runtime 显式传入）；完整迁移到 adapter 调用链属于后续完整重构 track。

### 3. 三个集群的边界声明与最小重构

| 集群 | 声明要点 | 最小重构范围 |
|------|----------|--------------|
| OrchestratorDriverLogic（ai-organ-logic/OrchestratorDriver.ts） | 调度决策为 core logic；fiber 注册/驱动为 outer；跨 actor 唤醒入口全部 async_message（mailbox） | 仅当存在绕过 mailbox 的直接唤醒/状态修改时修复 |
| RuntimeControlEngineLogic（ai-runtime-control-logic） | command reducer 为 core logic；effect 执行经注入 contract；enqueue 为 sync_command，effect result 回投为 async_message | engine core reducer 中如有直接 IO 则抽到 effect contract |
| SnapshotCoordinatorLogic（ai-runtime-control-composer + ai-organ-logic/RuntimeSnapshots.ts） | coordinator 决策（推进/跳过）为 core logic；writer 只持久化；safepoint 评估为纯函数 | 声明 coordinator/writer 切面；如 writer 内存在调度/推进行为则上移 |

### 4. Command/Message 边界断言

- `classifyControlEntry(componentId, entry)` 返回声明的分类。
- 断言 helper：`assertSyncCommandEntersReducer`、`assertAsyncMessageUsesMailbox` 的契约级表达（以声明+conformance 测试为主，运行时强制留给后续 track）。
- mailbox 的唯一性引用既有 `AI_AGENT_MAILBOXES`（8 个优先级 mailbox），不新增通道。

### 5. Conformance Tests

- 标准封装：boundary declaration 完整性；coreLogicEntries 对应的源码不包含 forbiddenDirectIo 调用（源码级断言，沿用 surface-entry-boundary 测试的模式）。
- command/message：三个集群的入口分类齐全；跨 actor 唤醒场景走 mailbox 的正向用例 + 直接调用被声明禁止的负向用例。
- coordinator/writer：非 safepoint 时 writer 返回结构化跳过、不触碰 driver；coordinator 在 orchestration 边界做推进/跳过决定（复用现有 `skipped_non_safepoint`/`skipped_pending_effects` 结果形态）。
- engine effect：effect 经注入 handler 执行且留下证据；core reducer 无 IO。

## 影响范围与修改点（Impact）

- 受影响的文件/模块：见 proposal.md Impact 一节。
- 新增代码以 contract 类型 + 声明 + 测试为主；对三个集群源码的修改限于 conformance 暴露的违反点。

## 决策摘要

- 详见 `decisions.md`。
- 当前关键结论：
  - 范围采用"契约优先、渐进重构"；三个集群的完整 outer/inner 重写由本 track 完成后的新 track 承担（用户已确认）。
  - `adopt-ai-runtime-control-composer` 已归档为输入，本 track 不重复其 composer/persistence 范围。
  - 封装复用 depa-processor 原语，不新建封装框架。
  - 宿主包（已确认，decisions.md 问题 1 = A）：boundary declaration 通用类型放 `platform-contract`（与 DataSubgraphContract 同侧）；三个集群的具体声明放 `ai-core-contract`；engine 专属 conformance 放 `ai-runtime-control-logic/tests`。

## 风险 / 权衡

- 风险：源码级 IO 断言（grep 式）可能误报/漏报。
  - 缓解：限定 forbiddenDirectIo 为高信号模式（fs/process/fetch/全局单例），并允许声明豁免清单；运行时强制留给后续 track。
- 风险：最小重构触碰 OrchestratorDriver/RuntimeSnapshots 时引入回归。
  - 缓解：HEAD 既有失败基线已知（ai-organ-logic 12、terminal/organ 15）；每次修改前后用 stash 对照，不允许新增失败。
- 风险：与后续"完整重构三个 logic"track 的边界模糊。
  - 缓解：本 track 的修改判据唯一——conformance 不过才改；其余一律记录到后续 track 的输入。

## 待解决问题

- 无；decisions.md 三个问题均已 accepted。
