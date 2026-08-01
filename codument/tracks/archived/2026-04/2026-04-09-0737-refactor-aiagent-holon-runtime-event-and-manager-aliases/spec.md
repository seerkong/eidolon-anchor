# 规范：holon runtime manager helper 与 event wording 收口

## 概述

本 track 继续处理 runtime 内部仍然承担真实行为的旧命名，目标是让 `holon + governance` 成为 manager helper 和 autonomous event wording 的默认实现心智。

## ADDED Requirements

### Requirement: OrganizationManager SHALL 以 holon-first helper 作为主实现入口

系统 SHALL 让 `createHolon/addHolonMember/setHolonWatchState/appointHolonLeader` 成为 `OrganizationManager` 的主实现入口。

#### Scenario: collective/formation helper 退化为 alias 包装
- **GIVEN** `OrganizationManager` 仍保留 `createCollective/createFormation/...` 等旧 helper
- **WHEN** 本 track 完成后
- **THEN** 这些旧 helper SHALL 只作为兼容包装存在
- **AND** 主实现逻辑 SHALL 由 holon-first helper 承担

### Requirement: autonomous runtime event SHALL 使用 holon-first wording

系统 SHALL 让 autonomous holon 的 claim / idle-exit runtime event 使用 holon-first 命名与可见文案。

#### Scenario: visible runtime notice 不再默认使用 Collective wording
- **GIVEN** 当前 runtime event 仍有 `Collective claim` 与 `Collective idle exit`
- **WHEN** 本 track 完成后
- **THEN** 默认 event API 与 visible notice SHALL 使用 autonomous-holon 语义
- **AND** 旧 `emitCollective*` API 如保留，只能作为兼容 alias

### Requirement: focused tests SHALL 锁定新的 runtime alias 边界

系统 SHALL 更新 focused tests，确保 manager helper 与 runtime event 的新旧边界清晰。

#### Scenario: manager helper 主实现与旧 event alias 同时被验证
- **GIVEN** runtime event、orchestration history、runner 与 organization tests 已存在
- **WHEN** 本 track 完成后
- **THEN** focused tests SHALL 验证新 wording 与主实现 helper
- **AND** 兼容 alias 若保留，也 SHALL 被显式覆盖
