## ADDED Requirements

### Requirement: Platform Logic Introduction Must Be Evidence-Gated
系统应当为 `platform-logic` 的引入设置明确证据门槛，而不是因为目标结构中存在该层就提前实现空平台逻辑包。

#### Scenario: No platform-logic without cross-domain evidence
- **GIVEN** 当前只有 AI 领域真实落在平台微内核之上
- **WHEN** 团队评估是否引入 `platform-logic`
- **THEN** 必须先具备明确跨领域复用证据或第二领域需求
- **AND** 不应为了未来可能复用而提前抽象

### Requirement: Evidence Gate Must Preserve Current Ownership Boundaries
系统应当确保 platform-logic 的证据门槛不会把 AI 语义错误上移到平台层。

#### Scenario: Candidate capability remains in current host until evidence is sufficient
- **GIVEN** 某个能力仍主要服务于 AI domain
- **WHEN** 尚未满足 platform-logic 证据门槛
- **THEN** 它应继续留在当前宿主
- **AND** 不应为追求结构完整而被提前上收到平台层
