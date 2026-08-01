# 变更：Historical Long-Turn Resume Verification

## 背景和动机 (Context And Why)

Mission 需要用真实历史输入验证 long-running turn 不再以 generic failure 退出，而是以可恢复暂停形式暴露进度。

## "要做"和"不做" (Goals / Non-Goals)

**目标:**
- 使用用户给出的 Sparrow session 分析任务运行真实 CLI smoke。
- 验证结果为 `paused_with_progress`。
- 验证 trace 和 `--output-last-message` 行为符合 G3 协议。

**非目标:**
- 不要求在短 timeout smoke 中完成完整分析报告。
- 不把历史验证引入慢速默认测试套件。

## 变更内容（What Changes）

- 记录真实 CLI smoke 验证结果。
- 将 mission G4 作为 evidence track 收口。

## 影响范围（Impact）

- 受影响的能力（behaviors）：`runtime-session-robustness`, `terminal-headless-runtime-cli`
- 受影响的代码：无新增生产代码；本 track 是验证与证据记录。
