## MODIFIED Requirements

### Requirement: Holon Internal Manager Surface
系统应当（SHALL）让 `OrganizationManager` 的内部主实现路径以 `holon + governance` 为中心，而不是继续公开 `collective / formation` 作为默认 helper 真相。

#### Scenario: 内部调用方通过 governance-first helper 访问 holon
- **GIVEN** runtime 需要按治理方式读取或解析 holon
- **WHEN** 调用 `OrganizationManager`
- **THEN** 内部主实现应使用 governance-first helper
- **AND** 不应继续依赖 `getCollective/getFormation/resolveCollective/resolveFormation` 作为默认路径

#### Scenario: legacy assign alias module 不再保留
- **GIVEN** `_collectiveAssignCore.ts` 与 `_formationAssignCore.ts` 已不再承载独立逻辑
- **WHEN** 仓库完成本轮 cleanup
- **THEN** 这两个 alias module 应被移除
- **AND** 内部调用应直接指向 holon-first assign core
