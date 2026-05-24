# 规范：holon runtime protocol 的 lane/workload/scope marker 收口

## 概述

本 track 处理仍属于 runtime protocol 真相的一批旧名，让 autonomous holon 的调度语义不再默认使用 `collective`。

## ADDED Requirements

### Requirement: scheduler lane SHALL 使用 autonomous holon 语义

系统 SHALL 将当前 autonomous holon 的后台调度 lane 从 `collective` 收口为 `autonomous_holon`。

#### Scenario: member roster 与 fiber lane 不再默认写成 collective
- **GIVEN** 成员 lane 会进入 actor identity、fiber lane 与 snapshot/recovery
- **WHEN** 本 track 完成后
- **THEN** autonomous holon 相关 member lane SHALL 使用 `autonomous_holon`
- **AND** `collective` 不得继续作为默认 runtime lane 真相

### Requirement: workload label SHALL 使用 autonomous holon 语义

系统 SHALL 将当前 workload `collective_task` 收口为 `autonomous_holon_task`。

#### Scenario: fiber workload 与 lane 对齐重命名
- **GIVEN** workload label 会进入 runtime snapshot 和调度决策
- **WHEN** 本 track 完成后
- **THEN** autonomous holon 对应 workload SHALL 使用 `autonomous_holon_task`

### Requirement: task-tree holon scope marker SHALL 使用 governance-explicit 语义

系统 SHALL 将 task-tree 的 holon scope marker 改为 governance-explicit 表达。

#### Scenario: activeForm 不再直接使用 collective/formation 前缀
- **GIVEN** task-tree 当前仍使用 `collective:<id>` / `formation:<id>`
- **WHEN** 本 track 完成后
- **THEN** autonomous holon SHALL 使用 `holon:autonomous:<id>`
- **AND** leader-led holon SHALL 使用 `holon:leader_led:<id>`

### Requirement: runtime snapshot SHALL 对旧协议 fail-fast

系统 SHALL 将这次 protocol rename 视为新的 snapshot schema 版本，不长期保留双协议兼容。

#### Scenario: 旧 lane/workload/scope marker snapshot 不被当前 runtime 恢复
- **GIVEN** 旧 snapshot 中仍可能包含 `collective` lane、`collective_task` workload 或旧 `activeForm` marker
- **WHEN** 当前 runtime 尝试恢复这些旧数据
- **THEN** recovery SHALL 以 `unsupported_runtime_snapshot` fail-fast
- **AND** 当前正式恢复版本 SHALL 只接受新协议命名
