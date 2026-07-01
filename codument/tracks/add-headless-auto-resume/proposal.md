# 变更：Add Headless Auto Resume

## 背景和动机

前序 mission 已经让 mandatory-continuation timeout 变成可恢复的 `paused_with_progress`，并保留已完成进度。但真实长程验证显示：CLI 在任务尚未最终输出时仍会把控制权交回调用者，用户感知仍是“agent 没解决问题就停了”。

## 目标

- 增加显式 `--auto-resume` 模式。
- 在 resumable pause 后自动继续同一个 runtime turn。
- 内部续跑不追加新的 user input。
- 增加最大 continuation 次数和无进展保护。
- 保持默认 `paused_with_progress` 行为不变。

## 非目标

- 不改变 checkpoint safepoint 事务性。
- 不把 auto-resume 设为默认行为。
- 不修改被分析项目 `sparrow-agents`。

## 影响范围

- `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts`
- `terminal/packages/organ-support/src/exec.ts`
- `terminal/packages/cli/src/commands/exec.ts`
- 相关 headless/CLI 测试
