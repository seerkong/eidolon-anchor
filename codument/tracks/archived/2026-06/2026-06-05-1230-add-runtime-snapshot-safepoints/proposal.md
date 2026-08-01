# 变更：Runtime 快照 Safepoint

## 背景和动机 (Context And Why)
当前 runtime 会在 queued operation 结束后保存快照，但保存前没有判断当前状态是否是可恢复 safepoint。现场问题显示，系统可能在 assistant tool call 已进入 history、但 `start_tool` 尚未创建 durable tool operation 的半步状态落盘。恢复后该状态既没有 matching tool result，也没有可恢复的 tool start 证明，导致 provider 消息协议和调度状态不一致。

## “要做”和“不做” (Goals / Non-Goals)
**目标:**
- 为 runtime snapshot 定义 safepoint 语义：保存成功即表示进程可立即崩溃并从该快照恢复到可用状态。
- 禁止把 `start_tool` 等协议关键半步状态保存为最新可恢复快照。
- 调整 foreground/all-lane settled 边界，使必须消费的 `agent_step` continuation 被执行到 durable operation 或 typed wait。
- 将已有未提交的 OpenAI Responses tool-call/tool-output 配对修复纳入相关兼容验证范围。
- 为历史坏快照和新 safepoint 规则补充聚焦测试与诊断。

**非目标:**
- 不把恢复时看到 `start_tool` 就补 wake 作为主要设计。
- 不重写整个 actor runtime 或 provider adapter。
- 不把 delegate/member/batch 工具文案和工具集调整纳入本 track，除非实现中发现直接依赖。
- 不保存完整 provider 私有内容或大 tool output 作为 safepoint 证明。

## 变更内容（What Changes）
- 新增 snapshot safepoint 判定与诊断。
- 调整 snapshot save 路径：非 safepoint 时先尝试推进到 safepoint；无法推进时跳过本次保存并保留上一个 known-good snapshot。
- 调整 settled 判定：`ready + start_tool` 等 mandatory continuation 不得被视为 snapshot-safe settled。
- 补充工具调用协议一致性测试，包括 assistant tool call、durable tool operation、tool result 的配对关系。
- 将相关未提交 OpenAI Responses input-item 修复纳入本 track 的验证范围。

## 影响范围（Impact）
- 受影响的功能规范：`aiagent-persistence-recovery`、`aiagent-fiber-orchestration`
- 受影响的代码区域：
  - `cell/packages/ai-organ-logic/src/runtime/AiAgentRuntimeCoordinator.ts`
  - `cell/packages/ai-organ-logic/src/OrchestratorDriver.ts`
  - `cell/packages/ai-organ-logic/src/persistence/RuntimeSnapshots.ts`
  - `cell/packages/ai-organ-logic/src/llm/ResponsesInputItems.ts`
  - `cell/packages/ai-organ-logic/src/llm/OpenAIResponsesNodejsFetchAdapter.ts`
  - `cell/packages/ai-organ-logic/tests/AIAgent/`
