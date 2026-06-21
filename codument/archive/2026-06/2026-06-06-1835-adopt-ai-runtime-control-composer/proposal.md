# 变更：落地 ai-runtime-control-composer 替换路径

## 背景和动机 (Context And Why)
`ai-runtime-control-composer` 已经能通过 file-store 模式写 runtime-control durable heads 和 cohort commit marker，但它还不能替换旧 runtime 实现。旧实现仍由 `RuntimeSnapshots`、conversation repository、transcript store、mailbox serialization、ingress/diagnostics logs、`AiAgentRuntimeCoordinator` 和 `OrchestratorDriver` 共同承担。

本 track 的目标是补齐真实 adapter、effect lifecycle、recovery classification 和替换就绪 gap loop，使 composer 从测试骨架演进为可落地替换旧 runtime 持久化与控制编排的引擎。

## “要做”和“不做” (Goals / Non-Goals)
**目标:**
- 将真实 session 文件体系映射为 composer durable heads。
- 将真实 tool/MCP/bash/permission/questionnaire/provider completion 生命周期映射为 composer effect request/result。
- 为真实 session 目录实现 recovery classifier，不静默接受 dirty 状态。
- 让 RuntimeSnapshots / coordinator 进入 shadow adoption，再按 readiness gate 切到 composer-owned cohort commit。
- 将历史问题转成真实 session replay 测试。
- 在实现后反复扫描“距离替换旧实现还差什么”，并把新 gap 追加回本 track。

**非目标:**
- 不在本 track 中删除旧 runtime 文件格式，除非替换就绪扫描确认无 blocker。
- 不加入兼容旧脏数据的静默修复逻辑。
- 不绕过 actor/mailbox 或 depa-actor/depa-processor 原语重建一套控制内核。
- 不把 AI 语义放入 vendor 层。

## 变更内容（What Changes）
- 新增真实 session durable head adapter。
- 扩展 file-store support，使其能读写并扫描真实 runtime-control evidence。
- 新增 effect lifecycle adapter，覆盖工具调用、MCP、bash、permission、questionnaire 和 provider completion。
- 新增 recovery scanner 和真实历史 incident replay tests。
- 将旧 runtime save/load/coordinator 路径接入 composer shadow mode。
- 引入 replacement-readiness gap loop，将剩余 blocker 追加为计划任务，直到可替换。

## 影响范围（Impact）
- 受影响的功能规范：`ai-runtime-control-engine-adoption`、`aiagent-persistence-recovery`、`aiagent-fiber-orchestration`
- 受影响的代码：`ai-runtime-control-*` packages、`ai-file-store-logic`、`ai-organ-logic` runtime persistence/coordinator/orchestrator、AI support local file stores、相关 runtime tests。
