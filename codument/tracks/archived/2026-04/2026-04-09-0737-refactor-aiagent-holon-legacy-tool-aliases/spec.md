# 规范：legacy `Collective* / Formation*` 工具族收口为 holon-first alias

## 概述

本 track 只处理 internal-only 兼容工具族，让旧工具名明确成为 holon-first 主实现路径上的 alias，而不是继续保留平行实现。

## ADDED Requirements

### Requirement: legacy 旧工具族 SHALL 成为显式 alias 边界

系统 SHALL 让 `Collective* / Formation*` 旧工具族继续存在于 internal-only registry 中，但其行为必须明确依附于 holon-first 主路径。

#### Scenario: 旧工具不再维护独立主逻辑
- **GIVEN** `CollectiveCreate / Add / Status / Assign` 与 `FormationCreate / Add / Appoint / Status / Assign` 仍然存在
- **WHEN** 本 track 完成后
- **THEN** 它们 SHALL 通过 holon-first 实现路径完成核心行为
- **AND** 不得继续形成与 `Holon*` 主路径分叉的独立逻辑真相源

### Requirement: legacy 工具 alias SHALL 保留兼容输入输出

系统 SHALL 继续接受 legacy 工具原有的输入字段与输出字段，以保证 internal-only 兼容边界稳定。

#### Scenario: 旧工具字段仍按 collective/formation 语义返回
- **GIVEN** internal-only registry 仍可调用 `Collective* / Formation*`
- **WHEN** 用户通过这些旧工具进行组织创建、加人、任命、查询或派发
- **THEN** 输出 SHALL 继续返回 `collective_id` 或 `formation_id` 等 legacy 字段
- **AND** 这些字段的值 SHALL 来自当前 holon-first 运行时真相

### Requirement: focused tests SHALL 锁定 legacy alias 边界

系统 SHALL 为这批 legacy 工具 alias 增加 focused tests，确保它们既不会回到正式面，也不会因主实现路径继续演进而失效。

#### Scenario: public registry 与 internal-only registry 的边界保持清晰
- **GIVEN** 默认 builtin registry 不应暴露 `Collective* / Formation*`
- **WHEN** internal-only registry 被构建
- **THEN** 旧工具族 SHALL 仍可被调用
- **AND** 对 create/add/appoint/status/assign 的兼容行为 SHALL 有 focused tests 覆盖
