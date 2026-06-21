# 规范：AIAgent 正式切换到 `member / holon` 与 `primary / delegate / detached` 模型

## 概述

本 track 定义一次正式的 breaking rename。

目标不是增加 alias，而是将 AIAgent 的正式对象模型、命令面和运行时命名统一收口为：

- 组织轴：`member / holon`
- 治理轴：`holon.governance = autonomous | leader_led`
- 执行轴：`primary / delegate / detached`
- 正式组织命令面：`/holon`
- prompt/content 分隔符：`--`

本 track 同时覆盖：

- runtime 对象模型与状态字段
- tools / slash command / prompt parse
- persistence / snapshot / recovery
- tests / docs / vendor 文档

## ADDED Requirements

### Requirement: 正式组织对象模型统一为 `member / holon`

系统 SHALL 将 AIAgent 的正式组织对象模型统一为 `member / holon`。

#### Scenario: 用 holon 替换 collective / formation 作为正式组织类型
- **GIVEN** 当前系统对组织对象使用 `collective` 与 `formation`
- **WHEN** 本 track 完成后
- **THEN** 对外正式组织类型 SHALL 只保留 `member` 与 `holon`
- **AND** `collective` 与 `formation` SHALL 不再作为正式组织 kind 出现在 runtime contract、正式命令面、正式工具族和正式文档中

### Requirement: holon 的治理语义通过 `governance` 表达

系统 SHALL 使用 `holon.governance` 表达组织治理类型。

#### Scenario: autonomous holon 对应原 collective
- **GIVEN** 某个 holon 采用无 leader 的自主决策与任务分发模型
- **WHEN** runtime 创建、恢复或展示该对象
- **THEN** 系统 SHALL 使用 `identity.kind = "holon"`
- **AND** SHALL 使用 `identity.governance = "autonomous"`

#### Scenario: leader_led holon 对应原 formation
- **GIVEN** 某个 holon 采用 leader 路由与结果回流模型
- **WHEN** runtime 创建、恢复或展示该对象
- **THEN** 系统 SHALL 使用 `identity.kind = "holon"`
- **AND** SHALL 使用 `identity.governance = "leader_led"`

### Requirement: 执行语义正式切换为 `primary / delegate / detached`

系统 SHALL 以 `primary / delegate / detached` 作为唯一正式执行语义。

#### Scenario: primary 替换 control 成为主执行体正式命名
- **GIVEN** 当前系统使用 `control` 表达主交互执行体
- **WHEN** 本 track 完成后
- **THEN** 系统 SHALL 使用 `primary` 作为正式命名
- **AND** `control` SHALL 不再作为正式执行 type 出现在 contract、runtime、正式工具名和正式文档中

#### Scenario: delegate 与 detached 保持原有执行语义
- **GIVEN** 当前系统已使用 `delegate` 与 `detached`
- **WHEN** 本 track 完成后
- **THEN** 两者的执行语义 SHALL 保持不变
- **AND** 只与 `primary` 一起构成统一执行轴

### Requirement: 组织语义与执行语义保持正交

系统 SHALL 保持组织语义与执行语义正交。

#### Scenario: member 与 holon 只通过 identity 表达组织语义
- **GIVEN** 系统需要表示 actor 的组织身份
- **WHEN** runtime 创建或恢复 actor
- **THEN** `member / holon` SHALL 只通过 `identity.kind` 表达
- **AND** `governance` SHALL 只存在于 `holon`

#### Scenario: primary / delegate / detached 只通过 actor.type 表达执行语义
- **GIVEN** 系统需要表示 actor 的执行角色
- **WHEN** runtime 创建或恢复 actor
- **THEN** `primary / delegate / detached` SHALL 只通过 `actor.type` 表达

### Requirement: 正式组织命令面统一为 `/holon`

系统 SHALL 将组织型一级命令面统一到 `/holon`。

#### Scenario: holon 成为唯一正式组织命令面
- **GIVEN** 当前命令面存在 `/collective` 与 `/formation`
- **WHEN** 本 track 完成后
- **THEN** 正式组织命令面 SHALL 只保留 `/holon`
- **AND** `/collective` 与 `/formation` SHALL 不再作为正式命令面展示在 help、tips、prompt 与 catalog 中

#### Scenario: holon create 显式接收 governance
- **GIVEN** 用户需要创建组织对象
- **WHEN** 用户使用正式命令面
- **THEN** 系统 SHALL 支持 `/holon create <governance> <name>`
- **AND** `<governance>` SHALL 只允许 `autonomous | leader_led`

#### Scenario: holon appoint 只适用于 leader_led
- **GIVEN** 用户使用 `/holon appoint`
- **WHEN** 目标 holon 的 `governance` 不是 `leader_led`
- **THEN** 系统 SHALL fail-fast
- **AND** SHALL 返回明确的治理类型不匹配错误

### Requirement: 正式组织工具族统一为 `Holon*`

系统 SHALL 以 `Holon*` 作为唯一正式组织工具族。

#### Scenario: HolonCreate / Status / Add / Assign / Appoint 替换原工具族
- **GIVEN** 当前系统存在 `Collective*` 与 `Formation*` 工具族
- **WHEN** 本 track 完成后
- **THEN** 正式组织工具族 SHALL 至少包括：
  - `HolonCreate`
  - `HolonStatus`
  - `HolonAdd`
  - `HolonAssign`
  - `HolonAppoint`
- **AND** `Collective*` 与 `Formation*` SHALL 不再作为正式工具族存在

### Requirement: prompt/content 分隔符正式切换为 `--`

系统 SHALL 使用 `--` 作为 slash 命令中结构化参数与 prompt/content 的正式分隔符。

#### Scenario: create 与 assign 使用 -- 分隔 prompt 或 content
- **GIVEN** 用户通过 slash 命令传递自由文本 prompt 或 task content
- **WHEN** 用户使用正式命令面
- **THEN** 系统 SHALL 使用 `--` 作为唯一正式分隔符
- **AND** `--` 后的全部文本 SHALL 被视为 prompt/content

#### Scenario: :: 不再作为正式展示语法
- **GIVEN** 当前帮助文案、tips、prompt 或 catalog 仍展示 `::`
- **WHEN** 本 track 完成后
- **THEN** 这些正式展示面 SHALL 统一改为 `--`

### Requirement: runtime truth 与 persistence 必须同步正名

系统 SHALL 将运行时真相源与持久化结构同步切换到新命名。

#### Scenario: actor key 与 actor-owned state 收口到 holon
- **GIVEN** 当前 runtime 使用 `collective:<id>` / `formation:<id>` 作为 actor key，并使用 `collectiveState` / `formationState`
- **WHEN** 本 track 完成后
- **THEN** runtime SHALL 将正式组织 actor key 收口为 `holon:<id>`
- **AND** SHALL 将 actor-owned state 收口到统一的 `holonState`

#### Scenario: sessionState 与 snapshot 不再保留 collectives / formations 正式字段
- **GIVEN** 当前 VM 和 snapshot 中存在 `collectives` / `formations`
- **WHEN** 本 track 完成后
- **THEN** 正式 sessionState 与 snapshot 结构 SHALL 收口为 `holons`
- **AND** 旧正式字段 SHALL 不再继续作为新模型正式结构存在

### Requirement: 旧 snapshot / 旧 session 不保证兼容恢复

系统 SHALL 明确将旧命名下的恢复兼容排除在本次改造后的正式范围之外。

#### Scenario: 旧数据恢复不被新模型直接承诺
- **GIVEN** 存在按 `collective / formation / control` 命名持久化的旧 session 或 snapshot
- **WHEN** 新模型尝试读取这些数据
- **THEN** 系统 SHALL 不承诺兼容恢复
- **AND** 如需兼容，必须通过明确迁移器处理，而不是通过 runtime 双字段双命名长期保留

### Requirement: 文档与测试必须全面切换到新命名

系统 SHALL 重写相关文档、提示词、帮助文案和测试，使正式仓库心智模型与新命名一致。

#### Scenario: 正式文档只使用 member / holon / primary
- **GIVEN** 项目内存在 runtime guide、howto、tips、theater report、vendor guide
- **WHEN** 本 track 完成后
- **THEN** 正式文档 SHALL 统一使用 `member / holon / primary`
- **AND** 旧命名如需出现，只能作为迁移说明或历史背景

#### Scenario: tests 与 fixtures 使用新命名和新 slash 语法
- **GIVEN** 项目中存在 slash command tests、runtime recovery tests、organization tests、TUI tests
- **WHEN** 本 track 完成后
- **THEN** 这些 tests / fixtures SHALL 切换到 `holon`、`primary` 与 `--` 语法
- **AND** 不得继续把旧命名当作正式行为基线
