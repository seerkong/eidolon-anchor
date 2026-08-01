# Durable Actor Control Signals Design

## 上下文

系统的长期架构方向是：用 stream + signal 作为数据面治理，用 actor + mailbox + fiber orchestration 作为控制面治理。当前故障说明控制面存在 split-brain：工具结果可以进入 transcript/history，但对应的 fiber resume 意图没有 durable 化，恢复后只剩一个泛化的 `external` 等待。

本设计的核心目标是让所有能改变 fiber 可调度性的事实都成为 durable control signals，并让 actor mailbox enqueue 与 scheduler resume 之间形成一个可恢复、幂等、可观测的机制闭环。

## 方案概览

1. Durable control signal model
  - 定义控制事件结构：`eventId`、`fiberId`、`actorKey`、`mailboxKind`、`priority`、`signalKind`、`opId`、`toolCallId`、`causationId`、`correlationId`、`idempotencyKey`、`createdAt`。
  - signalKind 至少覆盖：`mailbox_enqueue`、`async_completed`、`interrupt_requested`、`resume_requested`、`suspend_recorded`、`late_completion_ignored`。
  - control signal 是控制真相；transcript/history 是投影。

2. Unified enqueue and scheduling API
  - 提供统一 API，例如 `emitFiberSignal(...)` 或等价命名。
  - API 负责：
    - 持久化 durable control signal。
    - 入队 actor mailbox。
    - 根据 fiber 状态与 unblock predicate 标记 ready 或 pending resume。
    - 对 interrupt 消息设置 actor/fiber interrupt state，并 abort 当前可中断 work。
  - 禁止新增代码继续使用裸 `actor.send(...) + resumeFiber(...)` 表达 unblockable completion。

3. Running actor handling
  - actor 不重入。
  - running actor 收到普通消息时，仅入队。
  - running actor 收到 wake 消息时，入队并等待当前 step 或下一次 safe boundary drain。
  - running actor 收到 interrupt 消息时，入队 control mailbox，设置 interrupt flag，并 abort 当前 in-flight async work；当前 handler 在 safe boundary 处理。

4. Typed wait reasons
  - 将内部 async wait 从 generic external 拆分为 typed wait：
    - `wait_llm_result`
    - `wait_tool_result`
    - `wait_compress_result`
    - `wait_questionnaire_parse`
    - `wait_child_done`
    - `wait_human_input`
    - `idle_external`
  - 每个 typed wait 都有匹配的 durable signal 和 unblock predicate。

5. Recovery and invariant
  - snapshot save 前检查 suspended fiber 是否有可恢复理由。
  - recovery 时按优先级读取：
    - durable control signals / outbox
    - actor mailboxes
    - cooperative exec state
    - fiber scheduling metadata
    - transcript tail as conservative repair hint only
  - 对不可恢复状态输出诊断并转为 recoverable failure，或在安全规则存在时 rehydrate 为 ready。

6. Rx data plane
  - control events 进入 ordered stream。
  - scheduler readiness、blocked reason、interrupt requested、pending resume count 进入 signal/projection。
  - 不用 semantic event 伪造 scheduler state。

7. Late completion and idempotency
  - 每个 async op 使用 op id + epoch/generation。
  - cancel 后返回的旧 tool/LLM completion 不得复活 fiber。
  - 重放 durable signal 时按 idempotency key 去重。

## 影响范围与修改点（Impact）

- `AiAgentExecutor.ts`
  - 替换 async completion 中分散的 `actor.send` 和 `resumeFiber`。
  - 增加 interrupt observation 和 typed wait reason。
  - late completion 过滤。

- `OrchestratorDriver.ts`
  - mailbox enqueue 到 resume 的统一调度入口。
  - running/suspended fiber 对不同 signal class 的处理。
  - pending resume 幂等。

- `RuntimeSnapshots.ts`
  - serialize/restore durable control signal cursor 或 outbox 状态。
  - suspended fiber invariant。
  - recovery redelivery。

- RxData / VM runtime context
  - control event stream。
  - scheduler state signal/projection。

- Tests
  - reducer/unit tests。
  - recovery fixture tests。
  - crash-point simulation。
  - cancel interrupt tests。

## 决策摘要

- 详见 `decisions.md`。
- 当前建议：使用 durable control signal 作为一等控制真相；mailbox enqueue 不导致 running actor 重入；cancel 作为 high-priority cooperative interrupt；validation 使用 final phase gap loop。

## 风险 / 权衡

- 风险：引入新控制事件层后路径复杂度上升。
  - 缓解：先做数据结构和 reducer 测试，再替换执行路径。
- 风险：恢复时双重投递导致 tool result 重复消费。
  - 缓解：所有 signal 携带 idempotency key，并在 actor/fiber 侧记录 consumed cursor。
- 风险：过早删除 transcript-tail heuristic 造成旧 session 兼容下降。
  - 缓解：保留为 conservative repair hint，但不作为主控制真相。
- 风险：不可中断工具无法立即停止。
  - 缓解：cancel 设置 epoch，晚到 completion 被忽略或记录为 cancelled observation。

## 兼容性设计

- 保留旧 waitingReason 的读取兼容，但新写入使用 typed wait reasons。
- 对旧 snapshot 缺少 durable control signal 的场景，允许使用现有 transcript-tail repair 作为一次性兼容路径。
- 对已 terminal detached/background task 保持既有恢复语义。

## 迁移计划

1. 添加 durable control signal 数据模型和测试，不接入主路径。
2. 接入 mailbox enqueue/recovery 但保持旧路径兼容。
3. 替换 async completion 的裸 `actor.send + resumeFiber`。
4. 启用 snapshot invariant 的 warn 模式。
5. 测试稳定后把 invariant 提升为 fail-or-repair 模式。

## 待解决问题

- durable control signal store 的最终归属：VM durable subset、actor durable state、还是 session-scoped control event store。
- 是否所有 mailbox 消息都走 durable event，还是仅 unblock/interrupt-capable 消息走 durable event。
- typed waitingReason 的最终枚举名是否需要与现有 UI/diagnostic 字段保持完全兼容。
