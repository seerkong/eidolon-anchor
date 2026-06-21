# 规范：AIAgent 内部 `collective / formation` 行为名收口到 holon 实现模型

## 概述

本 track 不再修改正式对象模型，而是继续收口内部实现命名，使主实现路径与当前正式模型一致。

目标是让内部实现优先表达：

- 统一组织对象：`holon`
- 治理分支：`autonomous | leader_led`
- 明确兼容边界：legacy `collective / formation` 只留在必要的 alias / adapter 层

## ADDED Requirements

### Requirement: 主实现路径 SHALL 以 holon/governance 作为组织行为命名中心

系统 SHALL 在主实现路径中，以 `holon` 与 `governance` 表达组织行为，而不是继续把 `collective / formation` 当作实现层主语。

#### Scenario: manager / executor / assign core 使用 holon-first 命名
- **GIVEN** 运行时存在组织创建、寻址、派发、回流与状态聚合的主实现路径
- **WHEN** 本 track 完成后
- **THEN** 这些路径的主命名 SHALL 优先使用 `holon` 或 governance-explicit 命名
- **AND** `collective / formation` 如保留，只能出现在明确的 legacy adapter、alias 或迁移边界

### Requirement: runtime signal store SHALL 不再以旧组织类型作为正式内部主名

系统 SHALL 将组织完成信号、路由完成信号等 runtime signal store 收口到 holon/governance 语义。

#### Scenario: autonomous 与 leader_led 的 signal store 用治理语义命名
- **GIVEN** 当前 runtime context 中仍存在 `collectiveTaskSignals` 与 `formationRouteSignals`
- **WHEN** 本 track 完成后
- **THEN** 这些主实现 store SHALL 改为以 `holon` 或 `governance` 语义命名
- **AND** 调用方 SHALL 不再把旧组织类型名当作内部真相源

### Requirement: 内部协议与 envelope SHALL 与 holon 实现语义对齐

系统 SHALL 让组织 assign/result/route 的 envelope 和协议名与 holon 实现模型一致。

#### Scenario: envelope 与 route protocol 改为治理显式表达
- **GIVEN** 当前存在 autonomous board 流与 leader-led route 流两类协议
- **WHEN** 本 track 完成后
- **THEN** 这些 envelope、payload helper 与 assign core SHALL 使用 holon/governance 对齐的命名
- **AND** 不再把 `collectiveEnvelope` / `formationEnvelope` 作为主实现协议名

### Requirement: 运行时组件命名 SHALL 反映其真实职责

系统 SHALL 重命名 controller / runner / manager API，使组件名更贴近其真实职责。

#### Scenario: autonomous holon board 组件不再以 collective 作为正式内部主名
- **GIVEN** 当前存在 `RuntimeCollectiveController`、`CollectiveTaskRunner` 等组件
- **WHEN** 本 track 完成后
- **THEN** 这些组件 SHALL 评估并改为反映 autonomous holon board / claim / dispatch 职责的命名
- **AND** 调用方 SHALL 跟随切换到新组件名

### Requirement: legacy 旧名 SHALL 被明确收口到保留边界

系统 SHALL 明确哪些旧名暂时保留，以及为什么保留。

#### Scenario: lane / workload / task-tree 历史协议可暂时保留
- **GIVEN** 某些内部名同时承担调度语义或历史持久化协议，例如 `AI_AGENT_LANES.collective` 或 `activeForm`
- **WHEN** 本 track 完成后
- **THEN** 若这些名字暂不改动，设计文档 SHALL 明确记录其保留理由
- **AND** 不得让这些保留项继续向上层扩散为新的正式心智

### Requirement: focused tests SHALL 以新内部基线验证收口结果

系统 SHALL 为内部命名收口更新 focused tests。

#### Scenario: tests 区分主实现命名与 legacy alias 覆盖
- **GIVEN** 项目中存在 organization/runtime/recovery/TUI 相关测试
- **WHEN** 本 track 完成后
- **THEN** 主实现基线测试 SHALL 使用 holon/governance 命名
- **AND** 若保留 legacy alias，相关测试 SHALL 显式声明其兼容边界，而不是混入默认实现基线
