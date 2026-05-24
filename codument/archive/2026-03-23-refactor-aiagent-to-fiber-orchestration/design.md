## 上下文

当前 AIAgent 的执行推进主要由外部调用方直接 `await aiAgentLoopStreaming()` 完成（terminal minimal / tui mock / subagent 工具调用链路）。这使得：
- 多 actor 的公平调度、等待让出、超时/重试/死信等语义难以在统一位置表达和测试。
- human wait（Questionnaire）虽然已有 `pause_all/continue_others` 的业务语义，但调度层不具备统一、可复用的编排实现。

项目已在 `vendor/depa-actor/src/orchestration/` 提供 fiber orchestration 原语（reducer/scheduler/runtimeAdapter）以及模拟测试用例。本 Track 将 AIAgent 调度彻底迁移到该编排能力。

## 方案概览

1. 引入 AIAgent Orchestrator Driver 作为唯一调度权威
  - 维护 `OrchestratorState`（fibers 生命周期、等待原因、优先级/老化、超时/重试/死信等）。
  - 每次调度调用 `scheduleOne()` 选择下一个 fiber，并通过 `dispatchEffects()` 投递 step。
  - 接收 agent 回传的 `yield/suspend/resume/complete/fail/cancel` 动作并通过 `reduceOrchestrator()` 归并状态。
  - 注：这里的 `cancel` 是 fiber 生命周期动作；AIAgent mailbox tag 层面会按要求移除 `cancel` tag，统一改用 `control` 表达取消信号（见后文）。

2. 扩展 depa-actor orchestration：支持 per-fiber/per-wait suspend policy
  - 现状：scheduler 在 `options.defaultSuspendPolicy=pause_all` 时，只要存在任何 human wait fiber 就全局暂停。
  - 目标：对齐 Questionnaire 的 per-request `suspendPolicy`：同一 orchestrator 内不同等待 fiber 可以分别选择 `pause_all` 或 `continue_others`。
  - 做法：在 fiber record 上记录 suspend policy override（或在一次 suspend 动作中携带），scheduler gating 只对 pause_all 的 human wait 生效。

3. Stage 1（含 Bridge）：Hard replace 所有外部 `aiAgentLoopStreaming()` 调用点
  - Bridge：保留 `aiAgentLoopStreaming()` 作为“一个 fiber step 的内部实现”，但仅在 agent 处理 `agent_step` 时调用。
  - 外部驱动（terminal / tooling）改为：投递输入 -> tick orchestrator -> 直到 idle/wait。

4. Stage 2：SubAgent fiber 化 + 完成消息回注历史
  - 将 `RunSubAgent` 演进为 child fiber：parent/child fiber 关系 + child_done 回注。
  - 同时支持两种模式：
    - sync_wait：parent 等待 child_done 再继续
    - background：parent 不等待，但仍接收 child_done 并注入对话历史
  - 关键：subagent completion 必须进入高优先级 mailbox tag（例如 `childDone`），确保下一步优先处理并注入 messages。
  - 代码上下文说明（现状）：当前 AIAgent actor 的 mailbox tags 为 `cancel/control/humanInput/toolResult/aiGenerated`，其优先级映射位于 `backend/packages/core/src/modules/AIAgent/runtime/actor.ts`（其中 `aiGenerated` 为最低优先级）。现状并不存在一个专门用于“subagent done 通知 parent”的高优先级 mailbox tag。
  - 设计结论：Stage 2 将新增一个专用的完成消息 tag（`childDone`）并为其分配高优先级（建议仅低于 control、高于 humanInput/toolResult），以满足“完成消息优先处理 + 注入对话历史”的需求。

6. Mailbox 方案调整：移除 `cancel` tag，统一使用 `control` 表达 cancel
  - 现状：AIAgent mailbox tags 含 `cancel`，并通过 tag priority 保证 cancel 优先级最高。
  - 目标：按要求移除 `cancel` tag；所有取消信号通过 `control` tag（payload.kind=cancel）表达。
  - 做法：
    - 将 `control` tag 的优先级提升为最高（例如 0），以维持“取消/控制优先处理”的总体语义。
    - 在 control payload 内区分 `cancel_requested`、`questionnaire_pending` 等控制消息。
    - 对于同一 tag 内的不同 kind，如需更强优先级，可在 drain 时进行 kind-level 归一化（先处理 cancel，再处理其他）。

5. Stage 3：cooperative step state machine
  - 将 executor 拆成多个可让出的量子（drain/llm/tool/wait decision），外部等待通过 suspend/resume 表达。
  - 允许在一个 fiber 等待外部 IO 时调度其他 fiber（充分发挥 continue_others、公平性、老化防饥饿）。

## 影响范围与修改点（Impact）

### depa-actor（vendor）
- `vendor/depa-actor/src/orchestration/types.ts`
  - 为 FiberRecord 增加 per-fiber suspend policy 字段（例如 `suspendPolicy?: SuspendPolicy`）。
  - 为 `FiberAction.suspend` 增加可选字段（例如 `suspendPolicy?: SuspendPolicy`）或复用上述字段。
- `vendor/depa-actor/src/orchestration/reducer.ts`
  - 在处理 `suspend` 时将 policy override 持久化到 fiber record。
- `vendor/depa-actor/src/orchestration/scheduler.ts`
  - gating 逻辑从“任意 human wait -> pause_all”升级为“存在 pause_all 的 human wait -> pause_all”。
- `vendor/depa-actor/test/ai-agent-human-wait-policy.test.ts`
  - 增加混合策略测试：一个 fiber pause_all、另一个 fiber continue_others。

### AIAgent（backend/terminal）
- 引入新的 orchestrator 驱动模块（建议目录：`backend/packages/organ/src/AIAgent/orchestration/`）。
- 扩展运行时 mailbox schema：
  - Stage 1：引入 orchestrator 驱动相关 tags（如 `agent_step`、`orch_tick`、`orch_action`）。
  - Stage 2：引入 subagent completion tag（`childDone`），并设置高优先级。
  - 并将 `AiAgentVm.actorRuntime` 的 schema 泛型迁移到新 schema。
- Hard replace 外部推进点：
  - `terminal/packages/minimal/src/app.ts`
  - `terminal/packages/tui/src/runtime/TuiRuntime.ts`
  - `backend/packages/organ/src/AIAgent/agent/SubAgent.ts`
  - `backend/packages/composer/src/modules/AIAgent/tools/RunSubAgent/Logic.ts`

## 决策

- 决策：Stage 1 允许 Bridge（单 step 内调用一次 `aiAgentLoopStreaming()`）
  - 理由：降低首次迁移的爆炸半径，确保调度权先收敛到 orchestrator。

- 决策：扩展 vendor/depa-actor 支持 per-fiber human policy
  - 理由：Questionnaire 是 per-request suspendPolicy；若仅依赖全局 policy，会引入不可接受的语义缺失。
  - 替代方案：在 AIAgent 层动态切换全局 policy（被否决，原因：难以表达混合等待并保持 reducer/scheduler 纯语义的一致性）。

- 决策：Stage 2 同时支持 sync_wait/background
  - 理由：用户明确要求未来两种模式共存，且两者都必须通过“完成消息 + mailbox 优先级 + 注入对话历史”实现一致的父流程可观测性。

## 风险 / 权衡

- Bridge 阶段量子较大 → 公平性受限
  - 缓解：Stage 3 拆分为 cooperative state machine 并以测试门控。

- schema 泛型迁移影响面大（ActorRuntime 的 MailboxSchema 变更）
  - 缓解：先新增新 schema（兼容旧 tag），再逐步将生产代码迁移；在 Stage 1 即移除外部直接调用。

- subagent completion 注入历史的时机/优先级错误可能导致上下文漂移
  - 缓解：将 child_done mailbox priority 设置为高优先级，并新增集成测试断言 messages 注入顺序。

## 兼容性设计

- **BREAKING**：本 Track 最终不保留 legacy 外部直接调用 `aiAgentLoopStreaming()` 的路径。
- Bridge 仅作为 Stage 1 内部过渡实现，Stage 3 完成后可移除/降级为内部实现细节。

## 迁移计划

1. Stage 1：
  - 扩展 depa-actor 支持 per-fiber human policy（先测后改）。
  - 引入 orchestrator driver + agent_step。
  - 迁移 terminal/subagent 调用点到 orchestrator tick。

2. Stage 2：
  - SubAgent fiber 化：parent/child fiber + child_done。
  - 提供 sync_wait/background 模式。
  - 完成消息注入对话历史。

3. Stage 3：
  - 将 executor 拆分为 cooperative step state machine。
  - 外部等待（LLM/tool/human）统一通过 suspend/resume。

## 待解决问题

- AIAgent 的 fiber id 命名规则（建议：`agentKey:actorId:seq`）以及 parent/child id 生命周期。
- child_done 的 payload 结构：仅 text，还是结构化（tool call id / result / usage / trace）。
- Stage 3 的最小量子边界：按“turn”还是按“tool call”拆分（影响公平性与复杂度）。

## 实现细节（Implementation Notes）

本节补充“产品/terminal/subagent 的推进是否已经由 actor orchestrator driver 统一编排”的落地细节与关键改动，作为后续阅读的快速入口。

### 1) 统一编排的入口与调用约束

- 统一入口：`backend/packages/organ/src/AIAgent/OrchestratorDriver.ts`
  - `createAiAgentOrchestratorDriver(...)`：通用 driver（持有 `OrchestratorState`，负责 schedule/reduce/dispatchEffects）。
  - `createAiAgentOrchestratorDriverWithCooperative(...)`：AIAgent 专用封装，内部将 `agent_step` 绑定到 `aiAgentCooperativeStep(...)`。
- 调用约束：terminal/minimal、terminal/tui mock、以及 subagent 的执行推进不再直接 `await aiAgentLoopStreaming()`；而是“投递消息到 actor mailbox -> `resumeFiber()` -> `tickUntilBlocked()`”。
- legacy 说明：`aiAgentLoopStreaming()` 仍保留在 `backend/packages/organ/src/AIAgent/exec/AiAgentExecutor.ts` 作为对照/单元测试用途，但不再作为生产推进入口导出（exec barrel 已仅导出 cooperative step）。

### 2) Terminal（minimal / tui mock）如何驱动 orchestrator

- 关键文件：
  - minimal：`terminal/packages/minimal/src/app.ts`
  - tui mock：`terminal/packages/tui/src/runtime/TuiRuntime.ts`
- 统一驱动模式（每条输入一次）：
  1) 终端收到用户输入文本
  2) 根据当前 pending 状态选择投递目标 mailbox：
     - 若存在 `control.kind="questionnaire_pending"`，则把输入投递为 `toolResult`（相当于“回答问卷”）
     - 否则投递为 `humanInput`
  3) 调用 `driver.resumeFiber(mainFiberId, now)`
  4) `await driver.tickUntilBlocked({ now, maxWallMs })`，直到“无可调度 fiber 且无 in-flight async”
- `tickUntilBlocked()` 的关键语义（driver 层保证）：
  - 会持续等待 cooperative fiber 的异步 IO（LLM/tool/parse）完成并触发 `resume_fiber`，避免“思考输出到一半就提前返回”一类问题。

### 3) Cooperative step（执行器）如何与 driver 对接

- 关键文件：`backend/packages/organ/src/AIAgent/exec/AiAgentExecutor.ts`
- `aiAgentCooperativeStep(...)` 是“单个 fiber 的一个可让出量子”，driver 通过投递 `agent_step` 触发它执行。
- 外部等待统一通过 `suspend/resume` 表达：
  - LLM 调用/工具执行/问卷解析等异步流程不会阻塞 orchestrator；step 会返回 `suspend`，并在异步完成后由内部发送 `aiGenerated` + 调用 `resumeFiber(...)` 唤醒。
- 消息注入顺序的关键点：
  - `control`（尤其是 cancel / questionnaire_pending）优先级最高，确保“控制面先于普通输入”被处理。

### 4) SubAgent（RunSubAgent）如何纳入同一 orchestrator

- 关键文件：
  - `backend/packages/organ/src/AIAgent/agent/SubAgent.ts`
  - `backend/packages/core/src/modules/AIAgent/runtime/actor.ts`（mailbox schema / priority）
- 当 VM 上下文存在 orchestrator（通过 `vm.outerCtx.metadata.__ai_orchestrator` 注入）时：
  - `RunSubAgent` 不再直接同步执行子代理循环，而是通过 `spawnFiber(...)` 创建 child fiber（kind=subagent）。
  - child fiber 完成后通过 parent actor 的 `childDone` mailbox 回传结果。
- 模式：
  - `sync_wait`：parent 工具返回 `WAIT_FOR_CHILD_DONE`，父 fiber 进入 `child_wait`（等待 `childDone` 到达）；到达后将结果作为对应 `tool_call_id` 的 tool message 注入 messages。
  - `background`：parent 不等待；childDone 到达后被注入为一条 assistant 消息（用于后续上下文）。
- 为什么必须有 `childDone` mailbox + 高优先级：
  - 保证“子代理完成通知”能在下一轮 step 中优先注入 messages，从而避免上下文漂移。

### 5) Questionnaire（human wait）在 orchestrator 下的落点

- 关键文件：
  - `backend/packages/composer/src/modules/AIAgent/tools/Questionnaire/Logic.ts`
  - `backend/packages/organ/src/AIAgent/exec/AiAgentExecutor.ts`（cooperative wait mapping）
  - `terminal/packages/minimal/src/app.ts`
  - `terminal/packages/tui/src/runtime/TuiRuntime.ts`
- 触发等待：Questionnaire tool 负责写入 `actor.pendingQuestionnaires` + 发送 `control.kind="questionnaire_pending"`，并 emit `QuestionnaireRequest`。
- 等待与门控：cooperative step 检测到 pending 后返回 `suspend`，并将 `QuestionnaireRequest.suspendPolicy` 映射到 fiber 的 `suspendPolicy`（pause_all / continue_others），从而由 scheduler 做全局门控。
- 等待与门控：cooperative step 检测到 pending 后返回 `suspend`，并将 `QuestionnaireRequest.suspendPolicy` 映射到 fiber 的 `suspendPolicy`（pause_all / continue_others），从而由 scheduler 做全局门控。

### 6) 关键改动点清单（方便快速定位）

- Driver：`backend/packages/organ/src/AIAgent/OrchestratorDriver.ts`
- Cooperative step：`backend/packages/organ/src/AIAgent/exec/AiAgentExecutor.ts`
- Terminal minimal driver：`terminal/packages/minimal/src/app.ts`
- Terminal TUI mock driver：`terminal/packages/tui/src/runtime/TuiRuntime.ts`
- SubAgent fiber 化：`backend/packages/organ/src/AIAgent/agent/SubAgent.ts`
- Mailbox schema / priority：`backend/packages/core/src/modules/AIAgent/runtime/actor.ts`
