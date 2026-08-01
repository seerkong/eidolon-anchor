# 变更：修复 runtime mailbox wake 调度停滞

## 背景和动机 (Context And Why)

一次真实 coding-agent session 停在 assistant 已发出 tool call 但 tool result 未出现的位置。现场显示 LLM completion 已经进入 actor `asyncCompletion` mailbox，用户追问也进入 `humanInput` mailbox，但 fiber snapshot 被保存为 `ready + waitingReason=null`，cooperative exec state 仍是 `wait_llm`。

这暴露出 durable control signal、actor mailbox、scheduler resume 与 idle lifecycle hook 之间的边界未完全闭合。既有归档 track 已经确立：control signal 是调度事实，actor mailbox 是未消费 payload 的真相源，idle hook 只能在确实空闲时运行。本 track 用 focused bug fix 补齐这些边界。

## “要做”和“不做” (Goals / Non-Goals)

**目标:**
- 让所有 wake-capable actor mailbox pending work 都阻止 `actor.idle.before` 被当作 idle continuation 执行。
- 让恢复和 background/foreground settle 把 pending actor mailbox payload 视为 wake truth，即使对应 durable control signal 已经 consumed。
- 修复 `ready + cooperative wait_llm/wait_tool + inflight` 这类不一致状态，确保它被规范化或主动调度。
- 确保 `asyncCompletion + humanInput` 同时 pending 时，按 actor mailbox priority 先处理 async completion，再处理 human input。
- 避免 `heartbeat` goal continuation 抢占更高优先级 mailbox work。
- 为重复 idle hook stale diagnostics 增加节流、合并或更清晰的 pending mailbox 诊断。
- 增加 focused regression tests 覆盖真实现场形态。

**非目标:**
- 不改变 durable control signal 的 bounded snapshot 边界。
- 不把 transcript tail 或 conversation history 提升为控制真相源。
- 不引入新的消息总线、外部 scheduler 或绕过 actor mailbox 的直接状态修改。
- 不重写整个 hook runtime、conversation persistence 或 actor runtime。
- 不处理目标 workspace 中 `scripts/build_tui_release.sh` 的业务修复质量。

## 变更内容（What Changes）

- 扩展 idle 判断和 goal continuation guard，覆盖所有 wake-capable actor mailboxes。
- 扩展 scheduler async/wake 检测，覆盖 `ready + cooperative wait_* + inflight` 和 pending mailbox work。
- 在 runtime recovery 中从 actor mailbox plus cooperative exec state 重建 schedulable state，不依赖 pending durable signal event。
- 在 snapshot save/recovery 处增加 cooperative wait state guard，禁止静默接受 apparently-idle ready fiber。
- 调整 background watchdog 顺序，优先 drain scheduler/mailbox work，再触发低优先级 idle continuation。
- 对 repeated lifecycle stale hook diagnostics 做节流或合并，并输出 pending mailbox kinds。
- 增加 focused tests：mailbox priority、consumed signal with pending mailbox、ready wait_llm recovery、idle hook preemption、goal continuation preemption、control interrupt priority。

## 影响范围（Impact）

- 受影响的功能规范：
  - `aiagent-fiber-orchestration`
  - `aiagent-persistence-recovery`
  - `ai-runtime-lifecycle-hooks`
  - `aiagent-thread-goal-runtime`
- 受影响的关键模块：
  - `cell/packages/ai-core-logic/src/runtime/actor.ts`
  - `cell/packages/ai-core-logic/src/runtime/DurableControlSignals.ts`
  - `cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts`
  - `cell/packages/ai-organ-logic/src/OrchestratorDriver.ts`
  - `cell/packages/ai-organ-logic/src/persistence/RuntimeSnapshots.ts`
  - `cell/packages/ai-organ-logic/src/runtime/AiAgentRuntimeCoordinator.ts`
  - `cell/packages/ai-organ-logic/src/runtime/tickAiAgentRuntimeBackground.ts`
  - `cell/packages/ai-organ-logic/src/hooks/RuntimeHookProducer.ts`
  - `cell/packages/ai-organ-logic/src/goals/ThreadGoalRuntime.ts`
  - `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts`
  - focused runtime recovery, durable control signal, hook producer, goal runtime, and cooperative interleave tests
