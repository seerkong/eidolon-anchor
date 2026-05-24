# 变更：AIAgent 迁移到 depa-actor Fiber Orchestration 调度（Stage 1→2→3）

## 背景和动机 (Context And Why)

当前 AIAgent 的推进方式主要由调用方（terminal minimal / tui mock / 子代理调用工具）直接 `await aiAgentLoopStreaming()` 驱动。这种命令式推进导致：
- 多 actor 并行推进与公平调度难以在统一语义下表达与测试。
- “等待人类输入 / 等待外部 IO” 期间无法有效让出调度机会。
- 子代理（subagent）执行以同步调用为主，难以自然表达“后台运行 + 回注父对话历史”。

项目已在 `vendor/depa-actor/src/orchestration/` 引入 fiber orchestration（reducer/scheduler/runtimeAdapter）并具备模拟测试。现在需要将生产 AIAgent 模块彻底改造为使用该编排能力完成调度。

## “要做”和“不做” (Goals / Non-Goals)

**目标:**
- 将 AIAgent 调度权集中到 depa-actor fiber orchestrator：由其选择下一个可运行 fiber，并通过 ActorRuntime 投递 step。
- 按 Stage 1→2→3 顺序迁移：
  - Stage 1：orchestrator 驱动 + Bridge 过渡 + hard replace 所有 `aiAgentLoopStreaming()` 调用点
  - Stage 2：SubAgent fiber 化，支持 sync_wait/background 两模式，完成消息回注父对话历史
  - Stage 3：将执行器拆为 cooperative step state machine，等待外部 IO 时可调度其他 fiber
- 保持 Questionnaire 的 `pause_all/continue_others` 语义可测，并可在多 actor 场景稳定回归。

**非目标:**
- 不在本 Track 内新增新的终端 UI 交互形态。
- 不在本 Track 内重做 Questionnaire schema 或事件流（沿用现有结构）。
- 不引入新的外部依赖（继续使用 repo 内 `vendor/depa-actor`）。

## 变更内容（What Changes）

- 新增 AIAgent Orchestrator driver（OrchestratorState + scheduleOne + dispatchEffects）作为唯一调度权威。
- 扩展 `vendor/depa-actor` orchestration：支持 per-fiber/per-wait 的人类等待策略（用于对齐 Questionnaire 的 per-request suspendPolicy）。
- 调整 AIAgent session/terminal 驱动方式：从“直接调用 executor”切换为“投递输入 + tick orchestrator”。
- **BREAKING**：移除/停止使用 legacy 直接 `aiAgentLoopStreaming()` 作为外部推进入口（Stage 1 完成后）。
- 重构 RunSubAgent：支持 sync_wait/background 两模式，子代理完成后发送完成消息，父 actor 以 mailbox 优先级处理并将结果注入对话历史。
- 将执行器演进为 cooperative step 状态机，显式 suspend/resume 外部等待。

## 影响范围（Impact）

- 受影响的代码（预计）：
  - `backend/packages/organ/src/AIAgent/exec/AiAgentExecutor.ts`
  - `backend/packages/core/src/modules/AIAgent/runtime/runtime.ts`
  - `backend/packages/core/src/modules/AIAgent/runtime/actor.ts`
  - `backend/packages/composer/src/modules/AIAgent/tools/RunSubAgent/Logic.ts`
  - `backend/packages/organ/src/AIAgent/agent/SubAgent.ts`
  - `terminal/packages/minimal/src/app.ts`
  - `terminal/packages/tui/src/runtime/TuiRuntime.ts`

- 受影响的 vendor 模块（预计）：
  - `vendor/depa-actor/src/orchestration/types.ts`
  - `vendor/depa-actor/src/orchestration/reducer.ts`
  - `vendor/depa-actor/src/orchestration/scheduler.ts`
  - `vendor/depa-actor/test/ai-agent-human-wait-policy.test.ts`
