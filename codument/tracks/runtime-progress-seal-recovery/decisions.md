# Decisions

## Usage

- 用于记录需要用户确认的决策问题、选项、最终结论与理由。
- 本 track 来自 mission 的已确认设计方向；当前无阻塞决策。

### 1. 【P0】Progress seal 与 checkpoint 的边界
- 背景：长 turn 未到 safepoint 时不能保存完整 VM checkpoint，但 completed conversation progress 已经是 closed fact。
- 需要决定：是否把 completed progress seal 作为 checkpoint 之外的恢复接力机制。
- 选项：
  - A) 启用 production seal，并仅允许 conversation forward-only recovery。
  - B) 继续等待完整 safepoint，不保存任何 progress。
- 当前建议：A。
- 用户答复：来自 mission 目标，要求从本源解决长时间无法到 safepoint 的退出问题，同时保留 checkpoint 事务性。
- 最终决策：A。
- 决策理由：A 不放宽完整 checkpoint 的事务边界，同时避免长 turn 已完成进度丢失。
- 状态：decided
