# Decisions

## D1: 有效模型来源优先级

Status: accepted

Decision:
有效模型解析顺序为：

1. `user-explicit`
2. `cli-arg`
3. `agent-memory`
4. `agent-default`
5. `runtime-config`
6. `recent`
7. `provider-default`

Rationale:
人工在 TUI 中显式选择模型应当最高优先级；启动参数是本次进程的显式意图，但低于运行中人工选择；agent 相关默认应高于全局配置和 recent；provider default 只作为最后 fallback。

## D2: runtime history 不是高优先级选择来源

Status: accepted

Decision:
runtime 历史消息中的 provider/model 只能作为低优先级候选或恢复辅助，不能覆盖 `user-explicit`、`cli-arg`、`agent-memory` 或 `agent-default`。

Rationale:
历史消息描述过去发生过什么，不等同于用户当前选择了什么。将它作为直接 selection 会导致恢复会话或消息投影时覆盖用户新选择。
