# 变更：设计 Runtime Control Engine

## 背景和动机 (Context And Why)
当前 `refactor-ai-runtime-control-primitives` 已经把部分 runtime 操作语义化，但多次 session 恢复现场显示，问题根源不是缺少某一个补丁，而是缺少统一管理写入、缓存、数据变更、actor 编排和异步等待边界的控制引擎。

项目吸引子要求 Vendor 原语优先。当前本地 link 的 `depa-actor@0.2.0` 已经提供 actor 循环、mailbox、selective receive、fiber 调度，以及 local execution kernel primitives：`CommandDequeGroup`、单 deque、stack/frame、instruction/operand stack、generic dispatcher 和 group-level reducer helpers。`depa-processor` 已经提供标准组件协议与多策略分发。新的控制引擎应基于这些 vendor 原语，而不是从零实现一套调度、worklist、stack 或分发基础设施。

## “要做”和“不做” (Goals / Non-Goals)
**目标:**
- 分析 `depa-actor` 与 `depa-processor` 对控制引擎的直接支撑能力和缺口。
- 设计一个 vendor-first 的可恢复控制引擎，用命令列表表达操作，并以 safepoint 管理多类持久化 head。
- 明确 vendor 层通用原语和 AI 领域层封装的边界。
- 明确 `depa-actor@0.2.0` local execution kernel 能力已经满足 actor-local command worklist / stack / dispatcher 层，后续设计聚焦更高层一致性控制。
- 在替换当前 AI runtime 前，先完成独立的引擎测试与恢复场景验证计划。

**非目标:**
- 不在本 track 直接替换 `AiAgentVm` 或现有 session runtime。
- 不把 AI 领域概念写入 vendor 层控制引擎。
- 不复刻 `depa-actor` 的 actor、mailbox、fiber 调度能力。
- 不复刻 `depa-actor@0.2.0` 的 `CommandDequeGroup`、stack/frame、instruction dispatcher 或 group reducer helpers。
- 不复刻 `depa-processor` 的组件封装和分发能力。

## 变更内容（What Changes）
- 新增 `runtime-control-engine` 能力规范，描述可恢复命令解释器、safepoint、durable cohort、effect lifecycle 和 recovery 行为。
- 新增 `vendor-runtime-control-primitives` 能力规范，约束引擎必须复用 `depa-actor@0.2.0` 与 `depa-processor`，并将待补能力收敛到 effect lifecycle、safepoint、durable cohort 和 recovery。
- 新增 `ai-runtime-control-engine-adoption` 能力规范，约束 AI runtime 只能通过领域 wrapper 采用该引擎。
- 编写设计文档，说明 `depa-actor@0.2.0` 已经满足 local execution substrate，剩余缺口是可恢复一致性控制层。

## 影响范围（Impact）
- 受影响的功能规范：`runtime-control-engine`、`vendor-runtime-control-primitives`、`ai-runtime-control-engine-adoption`
- 受影响的未来代码区域：vendor control primitive package、AI runtime control contract/logic、AI organ logic runtime orchestration
