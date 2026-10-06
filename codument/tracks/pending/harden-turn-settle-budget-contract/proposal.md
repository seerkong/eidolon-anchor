# Track: harden-turn-settle-budget-contract

## Why

一个包含长时工具调用的正常 turn 会被运行时中止，并被上报为 `Timeout after 1000ms`，而该 turn 实际上已经完成了 27 次 provider 调用、47 次工具调用，只是最后一次 bash 仍在执行。

E2E 证据（eidolon runtime，`deepseek/deepseek-v4-flash`）：blog plan-0 receipt `failureSummary=Timeout after 1000ms`、`elapsedMs=147632`；trace `wallMs=145448`、`providerCalls=27`（全部 completed）、`toolCalls=47`、`toolOpen=1`。

根因不是超时太短，而是两个不同的运行时事实共用一个名字。turn 主泵给每次 settle 分配一个 1000ms 的泵送量子，目的是在每个量子边界重新评估 human wait 与 snapshot safepoint；而 driver 把这个量子预算当成硬失败判据——预算耗尽时前台 fiber 仍在 `running` 就抛异常。异常从 turn 裁决循环穿出，绕过已声明的 `timeout_unsettled` 结果，也绕过了该结果才有的「seal 已完成进度」路径。

因此长时工具不是「跑太久所以超时」，而是「运行时用错误的方式表达了它没跑完」。

## Goals / Non-Goals

**目标:**

- settle 的 wall 预算耗尽 SHALL 表达为一个声明的结果，而非异常。
- turn 主泵据此继续推进，直到 turn 收口或 turn deadline 真正耗尽。
- 只有 turn deadline 耗尽才判 `timeout_unsettled`，并保留既有的 seal 语义。
- 保留量子化带来的控制面可观察性（human wait 与 safepoint 在每个量子边界仍被评估）。
- 三个 settle 家族 API 的语义一致。

**非目标:**

- 不调整任何超时阈值（1000ms 量子、`--timeout`、120s first-event 均不在本 track 范围）。
- 不处理 provider 侧的首 token 超时（`first event exceeded timeout after 120s`）。
- 不追查「谁让 fiber 在量子内保持 `running`」这第二类缺口——若证实某处把 await 留在 fiber 上，应另立 track 以 Effect/actor 边界的方式修。
- 不改变 `timeout_unsettled` 的 seal 语义（只 seal 已完成 conversation 进度，不快照 in-flight）。
- 不改 `dist/`，不重新构建发布产物。

## What Changes

- `AiAgentOrchestratorDriver` 的三个 settle API 由 `Promise<void>` 改为返回声明结果：已收敛，或「预算耗尽且未 settled」。
- `driverRuntime.ts` 中三处 `throw new Error(\`Timeout after ${...}ms\`)` 改为返回该结果；与循环头既有的 `break` 路径合并为同一语义。
- `AiAgentRuntimeCoordinator.runInteractiveTurn` 主泵按结果决策：预算耗尽则继续（保持量子边界评估），不得用 `.catch` 吞掉。
- turn deadline 耗尽仍走既有 `timeout_unsettled` + `sealCompletedProgress` 路径，行为不变。
- 既有依赖「未 settled 即 throw」的测试改为检查 fiber / execState 状态。
- 新增行为覆盖：长工具不中止 turn；deadline 耗尽产 `timeout_unsettled`；无限预算语义不变；量子边界仍可观察 human wait。

**BREAKING**：`tickUntil*Settled` 是 `ai-core-contract` 声明的 `orchestrator_driver` capsule 外表面，返回类型变更影响所有调用方与测试。

## Impact

- 受影响的能力（behaviors）：`aiagent-fiber-orchestration`（新增两个 requirement）；`runtime-session-robustness` 的 `timed-out-turn-progress-persisted` 语义保持，仅其触发路径变清晰。
- 受影响的代码：
  - `cell/packages/ai-organ-logic/src/OrchestratorDriver.ts`（接口契约）
  - `cell/packages/ai-organ-logic/src/orchestratorCapsule/internals/driverRuntime.ts`（三处 throw + 循环头）
  - `cell/packages/ai-organ-logic/src/runtime/AiAgentRuntimeCoordinator.ts`（主泵、`progressBeforeSnapshot`、`deliverMemberInbox`）
  - `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts`（调用方，typed 结果翻译不变）
  - 测试：`cell/packages/ai-organ-logic/tests/AIAgent/{orchestrator_driver*,runtime/*,conversation/*,member_manager*,tui_management_tools,detached_*}`、`terminal/packages/organ/tests/AIAgent/*`
