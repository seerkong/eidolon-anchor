# 变更：Durable Actor Control Signals

## 背景和动机 (Context And Why)

近期现场暴露出一个控制面根问题：工具结果已经被持久化到对话投影中，但主 fiber 被保存为 `suspended + external`，没有可恢复 cooperative state、没有 mailbox 消息、没有 pending resume，导致系统不知道为什么停住，也不知道如何继续。

这不是单个恢复 heuristic 可以彻底解决的问题。当前系统的架构目标是 signal + stream 的数据驱动，以及 actor + mailbox + fiber 的控制驱动。因此，任何能解锁 fiber、打断 fiber、恢复 fiber 的事实都必须成为 durable control signal，而不是依赖一次易丢的 imperative `resumeFiber()` 调用或 transcript tail 猜测。

## “要做”和“不做” (Goals / Non-Goals)

**目标:**
- 将 unblock/interrupt-capable 消息建模为 durable control signals。
- 让 mailbox enqueue 成为调度信号来源：suspended fiber 被可解锁消息唤醒，running actor 不重入。
- 将 cancel/shutdown 等消息实现为高优先级 cooperative interrupt，而不是普通消息或并发 handler。
- 使用 typed waitingReason 和 cooperative exec state 表达 LLM、tool、compression、questionnaire、human、child 等等待边界。
- 在 snapshot save/recovery 阶段增加 invariant，禁止静默留下无法恢复的 `suspended + external + empty mailbox` 状态。
- 通过 TDD 和故障注入测试覆盖 crash-after-event、crash-before-resume、late tool result、cancel interruption 等场景。

**非目标:**
- 不把 conversation transcript/history 提升为控制真相源。
- 不允许 actor handler 并发重入来处理高优先级消息。
- 不通过 Actor-Team 或某个具体应用的特殊 case 修复底层调度。
- 不仅靠“最后一条 history 是 tool 就继续”的恢复猜测完成修复。
- 不改变用户可见的业务语义，除非该语义本身依赖错误的不可恢复状态。

## 变更内容（What Changes）

- 新增 durable control signal 模型，包含 event id、fiber id、actor key、mailbox kind、priority、op id、causation/correlation、idempotency key。
- 引入统一 enqueue/resume API，替代分散的 `actor.send(...)` 后手动 `resumeFiber(...)` 契约。
- 拆分 `external` 等待语义，新增 typed wait reasons 与 matching unblock predicate。
- 让 cancel/shutdown 进入 control mailbox，同时触发 abortable in-flight work 的 cooperative interrupt。
- 恢复路径从 durable control signals、actor mailboxes、cooperative exec state 重建 schedulable fiber。
- Rx data plane 增加控制事件 stream 与 scheduler readiness signal/projection 的分离表达。
- 增加 snapshot invariant 与诊断，阻止不可解释的 suspended fiber 静默保存或恢复。
- 增加故障注入测试和恢复测试，验证消息到达、resume 丢失、进程恢复、late completion、cancel 优先级。

## 影响范围（Impact）

- 受影响的功能规范：
  - `aiagent-fiber-orchestration`
  - `aiagent-persistence-recovery`
  - `ai-agent-vm-rx-data-plane`
- 受影响的关键模块：
  - `cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts`
  - `cell/packages/ai-organ-logic/src/OrchestratorDriver.ts`
  - `cell/packages/ai-organ-logic/src/persistence/RuntimeSnapshots.ts`
  - actor mailbox / VM runtime context / RxData binding 相关模块
