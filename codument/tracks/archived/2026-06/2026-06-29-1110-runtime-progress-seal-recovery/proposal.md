# 变更：Runtime Progress Seal Recovery

## 背景和动机 (Context And Why)

长时间 mandatory-continuation turn 可能在没有到达完整 safepoint 前超时。完整 VM checkpoint 不能在这种状态下保存，否则会破坏工具执行事务性；但已经完成并提交到 conversation domain 的工具结果和消息是 closed fact，可以作为后续 continuation 的接力点。

当前代码已有 seal 机制和 coordinator 注入点，但生产路径未绑定 seal；恢复门也会把 conversation head 领先 checkpoint 判为 dirty。因此长 turn 即使做了大量已完成进度，也无法安全接力。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**
- 在生产 runtime 中启用 completed conversation progress seal。
- 让恢复门显式容忍 conversation head 的 forward-only advancement。
- 保持 VM/ToolCallDomain in-flight 状态不被超时路径快照。
- 用测试证明恢复后的 model-visible history 包含 sealed progress。

**非目标:**
- 不实现 headless CLI `paused_with_progress` 输出协议。
- 不做历史真实 session replay 验证。
- 不解决单轮内 repeat-read 或模型重复工具调用问题。

## 变更内容（What Changes）

- `runtime-session-robustness` 行为中，`continuation-resumes-not-restarts` 从 deferred 变为本 track 交付目标。
- Recovery scanner 增加 conversation forward-only head policy。
- Shell/terminal runtime production coordinator 绑定 `sealCompletedConversationProgress`。
- 既有 pin 测试从“生产不 seal、恢复回 checkpoint”更新为“生产 seal、恢复包含 sealed progress”。

## 影响范围（Impact）

- 受影响的能力（behaviors）：`runtime-session-robustness`
- 受影响的代码：
  - `cell/packages/ai-runtime-control-logic/src/recoveryScanner.ts`
  - `cell/packages/ai-organ-logic/src/runtime/ShellRuntimeBootstrap.ts`
  - `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts`
  - `cell/packages/ai-organ-logic/tests/AIAgent/runtime/timed_out_turn_progress.test.ts`
  - `cell/packages/ai-runtime-control-logic/tests/runtime_control_recovery_scanner.test.ts`
