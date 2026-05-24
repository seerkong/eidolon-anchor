## MODIFIED Requirements

### Requirement: Holon Runtime State Shall Use Governance-First Names
系统应当（SHALL）让 runtime record、actor identity/state 与 envelope protocol 中的治理差异表达，使用 holon-first 的统一字段，而不是继续以 `collective / formation` 命名承载。

#### Scenario: runtime record 不再暴露 collective/formation record type names
- **GIVEN** runtime session store 已统一为 `sessionState.holons`
- **WHEN** 本 track 完成后
- **THEN** runtime record type 应使用 governance-first 命名
- **AND** 不应继续将 `VmCollectiveRecord / VmFormationRecord` 作为当前正式类型名

#### Scenario: actor state and envelope payload use holonId
- **GIVEN** holon actor identity/state 与 envelope payload 会进入 runtime/snapshot/protocol
- **WHEN** 本 track 完成后
- **THEN** 这些结构应统一使用 `holonId`
- **AND** 不应继续把 `collectiveId / formationId` 作为当前正式字段真相

#### Scenario: leader-led envelope uses holon-first route tag
- **GIVEN** leader-led holon 仍通过 envelope protocol 执行 leader route
- **WHEN** 本 track 完成后
- **THEN** protocol tag 与 payload 字段应使用 holon-first 命名
- **AND** 不应继续使用 `<formation_route>` 与 `formationId`
