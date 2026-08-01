# 变更：Headless Paused Progress Exit

## 背景和动机 (Context And Why)

runtime 已能在 mandatory-continuation timeout 时 seal completed progress 并支持后续恢复。但 headless exec 仍把 `runtime_turn_unsettled:*` 投射为普通 failure，使调用者无法区分“可恢复暂停”和“硬失败”。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**
- 为 headless exec 增加 `paused_with_progress` 状态。
- 只把 `runtime_turn_unsettled:*` 映射为 `paused_with_progress`。
- 保持 provider/empty-output 等硬错误为 `failed`。
- 保持 `--output-last-message` 不被暂停结果覆盖。
- 在 trace `session_end` 中写出 `paused_with_progress`。

**非目标:**
- 不定义新的 shell exit code。
- 不做历史 session replay。
- 不改变 runtime checkpoint 或 recovery 逻辑。

## 变更内容（What Changes）

- 扩展 `ExecRunStatus` / `HeadlessExecResult.status`。
- 增加 ExecProtocolGraph paused projection。
- `runHeadlessExec` 捕获 `runtime_turn_unsettled:*` 时投射 paused status。
- 更新 headless exec 测试。

## 影响范围（Impact）

- 受影响的能力（behaviors）：`terminal-headless-runtime-cli`
- 受影响的代码：
  - `terminal/packages/organ/src/stream/ExecProtocolGraph.ts`
  - `terminal/packages/organ-support/src/exec.ts`
  - `terminal/packages/organ-support/tests/headless-exec.test.ts`
