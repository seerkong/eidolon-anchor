## MODIFIED Requirements

### Requirement: Runtime Event API Shall Use Holon-First Names Only
系统应当（SHALL）让 autonomous holon claim / idle-exit 的 runtime event API 只暴露 holon-first 名称。

#### Scenario: AgentEventGraph 不再暴露 collective event alias
- **GIVEN** runtime 默认事件 API 已切到 `emitAutonomousHolonClaim` / `emitAutonomousHolonIdleExit`
- **WHEN** 本 track 完成后
- **THEN** `emitCollectiveClaim` / `emitCollectiveIdleExit` 不应继续作为当前 runtime API 暴露

#### Scenario: core-contract 不再导出 Collective runtime alias
- **GIVEN** autonomous holon payload type 已存在于 `runtime/AutonomousHolon.ts`
- **WHEN** 本 track 完成后
- **THEN** `runtime/Collective.ts` 应被移除
- **AND** `core-contract` 默认导出应直接指向 `runtime/AutonomousHolon.ts`
