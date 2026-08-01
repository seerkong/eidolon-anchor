# Design: Runtime Control Engine

Implementation-ready details are captured in `engine-blueprint.md`. This design file states the architectural decision; the blueprint file gives concrete data model, queue, effect lifecycle, safepoint, durable cohort, recovery, adoption, and conformance harness guidance.

## 设计判断
`depa-actor@0.2.0` 与 `depa-processor` 可以作为控制引擎的底座，但不能直接完整满足需求。

`depa-actor@0.2.0` 已经覆盖控制循环所需的 actor、mailbox、selective receive、priority scheduling、fiber orchestration、completion binding、snapshot hook contract。它还新增了 local execution kernel primitives：`CommandDequeGroup`、单 `CommandDeque`、stack/frame、`InstructionStack`、`OperandStack`、`dispatchInstructions` 和 group-level reducer helpers。

这意味着 actor-local 执行内核这一层已经可直接复用：外部 ingress 由 mailbox 承载，内部 worklist 由 `CommandDequeGroup` 承载，局部解释执行可由 instruction/operand stack 和 dispatcher 承载。引擎不应再重建 command deque、stack 或 dispatcher。

缺口是持久化一致性。`depa-actor` 提供本地执行与调度原语，但没有表达“一个命令已经进入 durable log、相关 mailbox/conversation/snapshot/evidence head 是否一起到达 safepoint、崩溃后如何判定哪些 effect 已提交”。因此它不是完整的 recoverable runtime control engine。

`depa-processor` 已经覆盖副作用扩展的标准协议：标准组件封装、manifest、dispatch engine、route/command handler、CtrlFlow/BehaviorTree handler extension。它适合承载引擎调用外部 side effect 的 handler registry。

缺口是 effect lifecycle。`depa-processor` 可以分发 handler，但没有规定 effect request/result 的持久化身份、幂等键、long-running wait、permission-intercept wait、recovery classification、commit acknowledgement。

## 抽象定位
这个控制更接近“可恢复的 effectful command interpreter”，同时包含状态机投影和 saga/commit coordinator。

- 不是纯状态机：状态机能描述合法状态转换，但不能充分表达 side effect 请求、等待、重试、回放、提交证据。
- 不是通用语言解释器：通用解释器太大，且会稀释项目的 DEPA 分层。
- 是小型可恢复控制引擎：命令和 effect 都是数据，`depa-actor@0.2.0` 负责 mailbox ingress、actor-local command worklist、stack/dispatcher 执行原语，`depa-processor` 负责分发副作用，durable cohort 负责一致性边界。

## 分层边界
Vendor 层保持领域无关：

- 控制程序：`ControlCommand[]`
- 控制状态：`ControlState`
- 派生投影：`Projection`
- actor-local worklist：`CommandDequeGroup<ControlCommand, RuntimeState>`
- local execution frame：`InstructionStack` / `OperandStack` / dispatcher when needed
- effect 请求：`EffectRequest`
- effect 结果：`EffectResult`
- safepoint 判断：`SafepointPolicy`
- durable head commit：`DurableCohortPort`
- recovery 判定：`RecoveryClassifier`

AI 领域层只做映射：

- human input、tool call、mailbox、conversation、snapshot、diagnostics 等 AI runtime 概念映射为 vendor command/effect/head。
- AI runtime 不直接操作 vendor 持久化细节，只调用 AI 领域 wrapper 提供的语义化操作。

## 引擎运行模型
1. Ingress 进入 append-only input log，并转成 control command。
2. Engine actor 从 priority mailbox 读取外部控制消息或 tick，并把它们转成内部 command 写入 `CommandDequeGroup`。
3. `CommandDequeGroup` 的 runtime-state-aware selector 选择下一条可消费 command；selector 可表达 cancel/resume 抢占、effect-result 优先、commit safepoint gating、waiting-state gating 和 aging。
4. Command reducer 纯函数地产生 next state、projection patch、effect request、commit intent，也可以按需使用 `InstructionStack` / `OperandStack` / `dispatchInstructions` 执行局部解释步骤。
5. Effect request 通过 `depa-processor` dispatch 到 handler。
6. 长耗时或被权限拦截的 effect 进入 waiting state，不允许 snapshot 把系统保存成不可恢复中间态。
7. 所有相关 durable heads 满足 safepoint policy 后，cohort commit 一次性提交。
8. 恢复时，engine 从 durable heads 和 append-only evidence 重建 state，判定 in-flight effect 是 pending、completed、retryable、orphaned 还是 dirty。

## 细粒度 Checkpoint 调度
最新的问题现场显示：运行中已经产生大量语义消息，但 `conversation/history.xnl` 直到外层 interactive turn 结束才批量写入。根因不是文件 buffer，而是 checkpoint 目前挂在外层 `enqueue()` 结束后的回调上；一个 long-running turn 内部多次 `tickUntilForegroundSettled()` 不会触发 checkpoint。

新的 runtime control engine 必须把 checkpoint 变成内部 command 流的一部分，而不是外部生命周期回调：

- 每个语义边界 command 执行后都可以排入 `safepoint_evaluate`。
- `safepoint_evaluate` 根据 durable cohort 的 head readiness 和 effect lifecycle 判断是否排入 `cohort_commit`。
- `cohort_commit` 仍由 selector gated，只有所有 required heads 已 buffered 且没有不可恢复 pending effect 时才可消费。
- checkpoint 粒度以 command/effect 边界为准，不以 TUI turn、interactive turn、enqueue batch 为准。
- conversation、mailbox、runtime snapshot、control signal 等非日志文件仍必须通过同一个 checkpoint cohort 提交；ingress/diagnostics journal sinks 仍在 checkpoint 外。

这与 saga 的相似点是：每个外部 effect 都有 durable intent/result lifecycle，每个 checkpoint 是一个一致性 cohort commit。不同点是，AI runtime 多数 effect 不适合补偿或重放，因此 engine 侧更关注可恢复 continuation、idempotency 和 fail-closed recovery classification。

## 需要补齐的能力
`depa-actor@0.2.0` 已经补齐：

- actor-local command worklist：`CommandDequeGroup`，多 deque priority/lane metadata，selector，显式 select/pop mutation boundary。
- single deque：stable FIFO、front/back insertion、front/back pop、neighbor lookup、drain、snapshot/hydrate。
- local execution stack/frame：`StackMachine`、`InstructionStack`、`OperandStack`。
- generic instruction dispatch：caller-defined opcode、handler resolver、budget、trace、stop reason。
- serializable reducer helpers：single deque 与 group-level command mutation helpers。

最小剩余 vendor/control 扩展应包含：

- effect lifecycle：定义 request id、idempotency key、handler route、started/result/failed/cancelled states。
- safepoint coordinator：统一判断哪些 head 可以写，哪些必须缓冲。
- durable cohort commit port：抽象多 head 提交、compare sequence、commit marker、recovery scan。
- recovery classifier：把恢复时的不一致归类成可继续、可重试、需人工修复或不可加载。
- conformance harness：用可控 fake clock、`CommandDequeGroup` selectors、fake processor handlers、fake storage heads 和 crash injection 测试恢复边界。

## 与现有 track 的关系
`refactor-ai-runtime-control-primitives` 不应继续扩大为完整引擎实现。它可以作为后续采用层的准备工作。

本 track 应先设计和验证 vendor-first engine。等引擎通过独立测试后，再由 `refactor-ai-runtime-control-primitives` 或后续 adoption track 把当前 AI runtime 迁移到该引擎。

## 测试策略
- Reducer 单元测试：同一 command 输入必须产生确定性的 state/effect/commit intent。
- Actor/local worklist 调度测试：高优先级 ingress、resume、cancel、tick 不被低优先级普通工作饿死；commit command 未达 safepoint 时不可消费。
- Processor dispatch 测试：effect route 不存在、handler 抛错、handler long-running、handler permission wait 都有明确状态。
- Crash injection 测试：在 command accepted、effect requested、effect started、effect result persisted、cohort commit before/after 等位置崩溃后可恢复。
- Dirty data 测试：durable heads 不一致时不静默兼容，必须生成明确 recovery classification。

## 主要风险
- 抽象过早泛化：用真实 session 失败场景和当前 AI runtime 采用路径约束设计范围。
- vendor 层泄漏 AI 语义：通过命名和 spec 审查禁止 AI-domain term 进入 vendor primitive。
- 与现有 `depa-actor-control` 重复：本 track 先产出设计结论，再决定是演进该包还是新建更准确的 vendor package；不得重复实现 `depa-actor@0.2.0` 已经提供的 local execution kernel。
