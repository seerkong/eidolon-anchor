# 变更：在 Eidolon 采用 DEPA StepSpace 与状态 sidecar

## 背景和动机 (Context And Why)

Eidolon 已把 AI Ctrl/Data Workflow 的 Definition、Instance 与 Run 迁到 depa 的 frozen instance 和单一 `FlowRunCheckpoint` authority，也已接入完整 `AIAgentDefinition`、typed Agent Processor 与同一 run 内的 Agent instance 复用。但当前安装仍锁在旧 depa 包版本，无法使用刚完成并发布的 StepSpace、profile-aware state sidecar、runtime extension codec 与局部 Merkle 更新能力。

过去讨论中反复出现的偏差来自把“节点状态优化”误解为新建 host 私有目录或第二份状态。目标不是重造存储，而是保留 depa 已恢复的 Definition → Instance → Run 布局，在同一个 canonical checkpoint 中把定义步骤森林、运行步骤索引、核心状态与自定义扩展状态分层投影。Eidolon 只负责提供受控 support root、冻结完整 ResourcePackage closure、装配 runtime ports，并从逻辑 checkpoint 投影产品读面。

## “要做”和“不做” (Goals / Non-Goals)

**目标:**

- 把 Eidolon 直接使用的 depa 依赖升级到 2026-08-23 已发布、已独立验证的 terminal-smallest exact versions。
- 让 ResourcePackage 作者态与 instance admission 支持显式 `StepSpaceRef`、`StepRef`、`StepGroupRef`、`ExtensionRef` 及其完整冻结 closure。
- 让 Ctrl/Data runtime 使用 depa 的 profile authority、runtime-only extension codec registry 与同一个 `FilesystemFlowRunCheckpointStore`。
- 通过 runtime-first Processor 和同名 bound facade 暴露精确 step extension mutation；不暴露物理 record/tree/head 路径。
- 证明单 step extension 修改只增加有界 immutable material、leaf 与 Merkle path，同时产品 status/result/summary/replay 仍读取同一个逻辑 checkpoint。
- 更新发布后的 Flow DSL reference、Eidolon Authoring/Run system Skills、统一产品构建，并将最新本地 Eidolon 安装与 global skills 更新到生成的 exact closure。

**非目标:**

- 不在 Eidolon 创建新的 StepSpace store、extension store、checkpoint schema 或目录协议。
- 不把 codec 函数、host path、conversation/history/provider facts写入 frozen definition或 checkpoint。
- 不恢复旧 flat Ctrl/Data/AI facts双写，也不新增自然语言、标签或文件名语义路由。
- 不改变 DEPA 的物理 owner 或 sidecar 协议；若 Eidolon authored facade 暴露出真实公共 contract 缺口，只允许发布 terminal-smallest patch，并由 fresh consumer 回读后再绑定。
- 不指定 npm registry，不修改 npmrc，不提交代码。

## 变更内容（What Changes）

- 更新 `@cell/ai-organ-logic`、`@cell/ai-workflow-contract`、`@cell/ai-support` 的 direct exact depa/reference identities，并更新 lockfile。
- 扩展 component-owned `WorkflowDepaPersistence`，以 materialized instance 的 frozen definition/StepSpace closure构造 Ctrl/Data profile authority与 extension codec registry，再交给唯一 checkpoint owner。
- 让 Ctrl/Data start、wait、resume、patch、extension mutation、terminal readback与fresh reconstruction保留 `stepExtensions` 和 profile-specific Step membership。
- 扩展 authoring/publication proof，验证显式 StepSpace closure、codec registration、schema-bound extension与冻结digest；异常输入在live package/registry/receipt mutation前拒绝。
- 更新 native tool/CLI/product projection，保持logical state，不泄露 `step-space/records`、`trees`、`receipts` 或host path。
- 更新 generated Flow DSL reference 和 system Skill plan；构建最新统一 Eidolon，local install后执行global init更新exact managed skills。
- 为 authored extension facade 补齐的公共 contract 已按最小补丁发布；Eidolon 只消费该 typed surface，未复制 DEPA runtime 或物理存储实现。

## 影响范围（Impact）

- 受影响能力：`workflow-run-material-lifecycle`、`eidolon-ai-workflow-native-capability`
- 受影响代码：`cell/packages/ai-organ-logic` workflow runtime/authoring/proof/tests，`cell/packages/ai-workflow-contract` bootstrap types，`cell/packages/ai-support` generated Skills，root lock/build/install gates
