# Mission：Stabilize Runtime WIP And Shell Approval

## 背景和动机

当前工作区已有一批未提交的 runtime/headless/TUI 续跑相关实现改动；这些改动属于已完成的 `long-running-turn-progress-resume` mission 及其 tracks 的实际代码落地，但还需要在新的收口 mission 中被明确记录、验证并保持不被后续 shell 权限改造污染。

同时，真实 session 记录显示 bash 权限审批噪音集中来自 `Approve bash command with unsupported syntax?`：模型生成的多行 Python inspection、换行串联的只读命令、命令替换读 trace 等常见 coding-agent 诊断命令被保守 parser 归为 unsupported，导致需要用户频繁确认。

## 目标

- 记录当前未提交 runtime/headless/TUI 改动作为 mission actual state，并为后续收口提供锚点。
- 将 shell 权限审批降噪拆成可独立执行和验证的 tracks。
- 降低只读探索命令、常见 Python inspection 命令和多行读命令的人工审批次数。
- 保持高风险 shell 行为的保守边界：破坏性写入、权限配置写入、未知危险组合仍需审批或拒绝。

## 非目标

- 不在本 mission 中归档既有 `long-running-turn-progress-resume` mission。
- 不把 bash permission parser 改造成完整 shell AST 解释器。
- 不绕过 sandbox、workspace access grant 或 protected permission config 防线。
- 不自动提交当前工作区改动。

## 成功判据

- 新增 shell tracks 均有 behavior delta、proposal、design、track.xml，并能回指本 mission。
- `LocalPermissionEvaluator` 对换行分段、支持的 Python heredoc / Python readonly inspection 和低风险只读 fallback 有测试覆盖。
- 已有高风险/unsupported syntax 测试仍保持 fail-closed 或 ask。
- 当前未提交 runtime/headless/TUI 改动未被 shell tracks 回退或误改。
