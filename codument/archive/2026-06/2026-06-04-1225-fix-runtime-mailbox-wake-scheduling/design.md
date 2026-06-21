## 上下文

本 track 是控制面 bug fix，沿用既有架构方向：actor mailbox 是未消费消息 payload 的真相源，durable control signal 是 bounded 调度事实，scheduler readiness 是派生状态，runtime lifecycle hook 只能在明确生命周期边界运行。

真实现场的失败形态是：

1. LLM 已返回 tool call。
2. `asyncCompletion` mailbox 有对应 `llm_done` payload。
3. 用户追问进入 `humanInput` mailbox。
4. VM control signal store 只有 consumed tombstone，没有 pending signal。
5. Fiber record 是 `ready + waitingReason=null`。
6. Cooperative exec state 是 `wait_llm + inflight`。
7. idle hook 反复报告 lifecycle stale，但没有推进 mailbox drain。

## 方案概览

1. Mailbox wake truth
  - 定义 `hasWakeMailboxWork(actor)` 或等价 helper，覆盖 `control`、`toolResult`、`asyncCompletion`、`childDone`、`memberCoordination`、`humanInput`、`memberChatInbox`、`heartbeat`。
  - Recovery、Terminal startup mailbox scan、background settle、idle hook producer、goal continuation guard 使用一致的 helper 或同构逻辑。
  - Consumed durable control signal tombstone 不阻止 actor mailbox payload 继续驱动恢复。

2. Cooperative wait normalization
  - 将 `ready + wait_llm/wait_tool/wait_questionnaire_parse + inflight` 识别为 active async work or recoverable inconsistency。
  - Save/recovery 时修复为 typed suspended wait，或保留 ready 但确保 next tick 执行 `agent_step`。
  - `hasInflightAsync` 扩展为检查 cooperative exec state，而不是只检查 suspended fiber record。

3. Scheduler settle behavior
  - Foreground/background settle 在 ready fiber、pending resumes、inflight cooperative wait、pending wake mailbox work 存在时继续 tick。
  - `resume_fiber` pending set 不是唯一恢复真相；缺失时从 actor mailbox plus cooperative exec state 重建 schedulable state。

4. Idle hook and goal continuation preemption
  - `actor.idle.before` producer 在每个 hook 前基于最新 driver state 和 actor mailbox 重检 idle。
  - 任意 wake mailbox pending 时，本轮 idle hook dispatch 停止。
  - Goal continuation hook 也用同一 preemption 条件，确保 `heartbeat` 不抢占更高优先级 work。

5. Diagnostics
  - stale lifecycle diagnostics 包含 `pendingMailboxes`、fiber status、cooperative phase。
  - 对同一 actor/point/reason/pending-mailboxes 的高频重复报告进行 throttle 或 coalesce。
  - Diagnostics 不能成为新的控制真相源，只作为观察和排障输出。

6. Tests
  - 从真实现场构造 fixtures：consumed `async_completed` tombstone、pending actor `asyncCompletion` mailbox、`ready + wait_llm + inflight` fiber。
  - 以 mailbox priority 验证 `asyncCompletion` 先于 `humanInput`，`control` interrupt 先于 late completion，`heartbeat` 不抢占其他 wake work。
  - 验证 idle hook preemption 和 diagnostics throttle。

## 影响范围与修改点（Impact）

- `AiAgentExecutor.ts`
  - 确认 cooperative step drain 顺序和 control interrupt 观察点。
  - 必要时调整 pending async completion drain 与 control signal handling 的测试覆盖。

- `OrchestratorDriver.ts`
  - 扩展 async/wake detection。
  - 调整 settle loop 对 pending wake mailbox 和 ready cooperative wait state 的处理。
  - 如需，增加 pending resume 重建或 revive 逻辑。

- `RuntimeSnapshots.ts`
  - Recovery 从 actor mailbox plus cooperative exec state 标记 fiber schedulable。
  - Guard `ready + cooperative wait_* + inflight` snapshot。

- `RuntimeHookProducer.ts` / `ThreadGoalRuntime.ts`
  - 扩展 idle and goal continuation preemption 条件。
  - 诊断输出 pending mailbox details。

- `AiAgentRuntimeCoordinator.ts` / `tickAiAgentRuntimeBackground.ts`
  - 背景 watchdog 优先 drain scheduler work，再触发低优先级 idle continuation。

- Tests
  - `runtime_recovery.test.ts`
  - `durable_control_signal.test.ts`
  - `runtime_hook_producer.test.ts`
  - `thread_goal_runtime.test.ts`
  - `cooperative_interleave.test.ts`

## 决策摘要

- 本 track 不需要新的用户决策；使用既有 archived decisions：
  - Durable control signal 是调度事实。
  - Actor mailbox 是 unconsumed payload truth。
  - Hook effects 通过 actor mailbox/driver 应用。
  - Goal continuation 使用 heartbeat mailbox 且不能抢占更高优先级输入。

## 风险 / 权衡

- 风险：把所有 mailbox pending 都视为 non-idle 可能减少 goal continuation 触发频率。
  - 缓解措施：这是符合 actor mailbox priority 的行为；heartbeat continuation 本就是最低优先级。
- 风险：扩展 settle 条件可能导致 background loop 更频繁。
  - 缓解措施：保持 max ticks/wall budget，并通过 tests 验证不会无限循环。
- 风险：诊断 coalesce 可能隐藏少量细节。
  - 缓解措施：保留首条和周期性摘要，摘要包含 pending mailbox details。
- 风险：save/recovery guard 可能影响旧 session。
  - 缓解措施：对旧形态执行 deterministic repair，并输出诊断，而不是直接失败。

## 兼容性设计

- Legacy snapshot 中 consumed control-signal tombstones 保持可读。
- 未消费 actor mailbox payload 保持 actor-owned durability。
- 对缺失 pending resume 的 snapshot 进行恢复时重建 schedulable fiber，不要求历史 session 拥有新增字段。
- 不改变用户可见的 goal、hook、mailbox 或 provider contract，只修复内部调度。

## 迁移计划

1. 添加 focused failing tests，锁定真实现场与 priority case。
2. 实现共享 wake mailbox helper 和 idle preemption 修复。
3. 实现 scheduler/recovery 对 `ready + wait_* + inflight` 的修复。
4. 实现 diagnostics throttle/coalesce。
5. 运行 focused tests 和相关 runtime suites。
6. 根据 knowledgeSync 配置同步或记录 docs 知识更新。

## 待解决问题

- 是否需要把 `pendingResumes` 写入 snapshot，还是仅依赖 mailbox plus cooperative exec state 重建。
- Diagnostics throttle 的具体时间窗口和摘要格式。
