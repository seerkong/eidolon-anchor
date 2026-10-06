# Design: harden-turn-settle-budget-contract

## 上下文

turn 主泵（`AiAgentRuntimeCoordinator.runInteractiveTurn`）是 turn 的唯一裁决循环，它已经声明了三种结局：`settled` / `blocked_on_human` / `timeout_unsettled`。为了在长时 inflight 工作（provider 调用、工具执行）期间仍能评估 human wait 与 snapshot safepoint，主泵把每次 settle 调用切成一个量子（当前 1000ms），并在量子边界重新 inspect。

driver 的 settle 家族（`tickUntilBlocked` / `tickUntilForegroundSettled` / `tickUntilBackgroundSettled`）把传入的 `maxWallMs` 当成两种东西：

- 循环头 `driverRuntime.ts:1678-1680`：预算用完就 `break` 返回——「本次泵送到此为止」；
- 派发一次 tick 之后 `driverRuntime.ts:1731-1733`：预算耗尽且前台 fiber 仍 `running` 就 `throw new Error(\`Timeout after ${ms}ms\`)`——「没在预算内收口，算失败」。

后者是缺陷：它把主泵的量子预算升级成了 turn 失败判据，异常从裁决循环穿出，既绕过 `timeout_unsettled` 结果 union，也绕过该结果专属的 `sealCompletedProgress`，并且让「长时工具」与「真正的运行时故障」不可区分。

约束：
- 量子化必须保留（human wait 与 safepoint 的可观察性依赖它）；
- `timeout_unsettled` 的 seal 语义（P3）不得改变；
- 不得用异常处理（`.catch`）掩盖，因为那会把 best-effort 语义套到 turn authority 上；
- 三个 settle API 同族，语义应当一致。

## 方案概览

1. **把 settle 预算耗尽表达为声明结果，而不是异常**
  - `AiAgentOrchestratorDriver` 的 settle 家族返回一个声明结果，形如：
    - `{ status: "settled" }` —— 前台（或后台/全 lane）工作已收敛；
    - `{ status: "budget_exhausted", wallMs, stillRunning }` —— 预算耗尽且仍有未 settled 工作。
  - `driverRuntime.ts` 三处 `throw new Timeout after ...` 与循环头的 `break` 合并到同一出口。
  - 无限预算（调用方未声明 wall）时保持既有语义：收敛后返回，不产生预算耗尽结果。
2. **主泵按结果决策，继续而不是中止**
  - 预算耗尽 → 继续循环，保持量子边界的 human wait / safepoint 评估；
  - human wait → `blocked_on_human`；
  - safepoint safe → `settled`；
  - turn deadline 耗尽（`remainingMs <= 0`）→ 既有 `timeout_unsettled` + seal 路径。
  - 主泵 SHALL NOT 对 settle 结果 `.catch` 吞掉。
3. **同族调用点对齐**
  - `progressBeforeSnapshot`（快照前拱进度）与 background pump 属于 best-effort，改为读结果并按结果收尾，语义不变；可保留 catch 作为兜底，但不再依赖异常表达预算。
  - `deliverMemberInbox` 的 `tickUntilBlocked` 调用同理。
4. **测试迁移**
  - 既有把 `maxWallMs` 当「未 settled 完就 throw」信号的测试，改为断言 fiber 状态或 execState phase。
  - 补行为用例：长工具不中止 turn；deadline 耗尽产 `timeout_unsettled`；无限预算不变；量子边界可观察 human wait。

## 影响范围与修改点（Impact）

- 受影响的文件 / 模块：
  - `cell/packages/ai-organ-logic/src/OrchestratorDriver.ts` —— settle API 返回类型（capsule 外表面契约）
  - `cell/packages/ai-organ-logic/src/orchestratorCapsule/internals/driverRuntime.ts` —— 三处 throw、循环头、`tickUntilBlocked` 的等待循环
  - `cell/packages/ai-organ-logic/src/runtime/AiAgentRuntimeCoordinator.ts` —— 主泵、`progressBeforeSnapshot`、`deliverMemberInbox`
  - `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts` —— 调用方适配（typed 结果翻译不变）
  - `cell/packages/ai-organ-logic/src/runtime/tickAiAgentRuntimeBackground.ts` —— 后台泵调用点
  - `cell/packages/ai-core-contract/src/runtime/AiRuntimeControlBoundaries.ts` —— 契约声明核对
  - 测试：`cell/packages/ai-organ-logic/tests/AIAgent/**`、`terminal/packages/organ/tests/AIAgent/**`

## 决策摘要

- 详见 `<track-dir>/decisions.xnl`
- 当前关键结论：不改阈值、不吞异常、不特判 bash；改的是「预算耗尽」的表达方式与其在 turn 裁决中的位置。

## 风险 / 权衡

- 契约变更面大（capsule 外表面）→ 通过类型系统强制所有调用点显式处理；测试迁移是主要工作量，需逐一核对断言意图而非机械替换。
- 把预算耗尽改成「继续」后，可能出现主泵空转（每量子都耗尽但无进展）→ 由 turn deadline 兜底（有限 deadline 时必然收敛到 `timeout_unsettled`）；无限 deadline 下维持既有行为，不引入新的失败模式。
- 可能掩盖「fiber 长时间 running」的第二类缺口 → 明确列为非目标并单独立项，避免本 track 变成「调大量子」的创可贴。
- `Timeout after` 字符串目前在 E2E harness 侧不被识别为传输故障 → 契约修好后该字符串不再产生；harness 分类问题不在本 track 范围。

## 兼容性设计

- 返回类型变更是编译期可见的 BREAKING 变更；不保留旧 `Promise<void>` 重载，避免两套语义并存（那是「以防万一的开关」）。
- `timeout_unsettled` 的外部可观察行为（含 seal 与恢复门 forward-only 容忍）保持不变。
- 恢复语义不变：本 track 不引入新的持久化状态，`session_end` 与 trace 的既有状态取值不变。

## 迁移计划

1. 先在 driver 侧引入声明结果并让三处 throw 走同一出口；
2. 迁移主泵与同族调用点；
3. 迁移测试断言；
4. 全量跑 `cell/packages/ai-organ-logic` 与 `terminal/packages/organ` 的相关测试；
5. 回滚策略：改动集中在三个源文件与测试，无数据迁移，`git revert` 即可。

## 待解决问题

- 三个 settle API 是否统一返回类型（当前倾向统一；`tickUntilBlocked` 有同源 throw 与同族语义）。
- `progressBeforeSnapshot` 的 `.catch` 是否改为读结果（语义不变，属同族可读性清理）。
