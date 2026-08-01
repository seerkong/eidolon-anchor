# 变更：fix-tui-stability-and-jsonl-logs

## 背景和动机
`eidolon-tui` 在长时间 coding 时会出现卡死或整机无响应的症状。现有代码里，热路径会同步写日志、反复重建完整消息投影，而且部分诊断日志和状态数据混在一起，导致 CPU 和 I/O 压力一起放大。

## “要做”和“不做”
**目标:**
- 将非状态类日志迁移到 append-only JSONL 存储。
- 降低 runtime/sync 热路径的同步写盘和重复投影成本。
- 让长会话下的 TUI 响应更稳定。
- 补充回归测试，覆盖日志迁移和高频事件场景。

**非目标:**
- 不重做 OpenTUI 界面。
- 不改变会话语义、消息内容或 runtime 协议。
- 不构建新的远程日志平台。

## 变更内容
- 引入 JSONL append-only 日志存储，用于非状态类诊断日志。
- 重新划分 TUI 日志边界，保留状态类数据在现有 runtime/session 存储中。
- 减少 runtime event receipt、sync dispatch、prompt input churn 等热路径中的日志噪音。
- 收紧 runtime message/part 投影与缓存增长，避免长会话下持续放大开销。
- 增强 subscribe fallback 的退出与退避行为，避免异常情况下忙循环。
- 增加针对日志和高频事件的回归测试。

## 影响范围
- 受影响的规范：`terminal-tui-shell`
- 受影响的代码：TUI log util、runtime client、sync store、prototype projection、prompt/dialog logging
