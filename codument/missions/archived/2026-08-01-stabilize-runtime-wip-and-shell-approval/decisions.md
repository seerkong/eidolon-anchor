# Decisions

## 1. 【P0】mission 范围

- 背景：用户要求把当前未提交改动与 shell 命令处理整体纳入一个 mission。
- 最终决策：创建新的 active mission，把既有未提交 runtime/headless/TUI 改动作为 actual-state 收口节点，把 shell 审批降噪作为新 tracks 实现。
- 决策理由：既有改动已对应另一条 completed mission 的实现，不应在 shell tracks 中重写；但必须被当前收口 mission 记录，避免后续验证和提交时遗漏。
- 状态：accepted

## 2. 【P1】shell parser 策略

- 背景：完整 shell AST parser 成本高，且不能替代 sandbox / permission policy。
- 最终决策：采用“支持常见安全形态 + unsupported risk fallback”的分层策略。
- 决策理由：真实审批噪音来自 read-only inspection command，不来自未知恶意命令；risk fallback 能降低噪音并维持保守边界。
- 状态：accepted
