## ADDED Requirements

### Requirement: AI Domain Contract And Logic Boundaries Must Become Explicit
系统应当让 AI 领域微内核的 contract/logic 边界在正式包结构或等价真相源中显式存在，而不是继续完全依赖历史 `core-*` / `organ-*` 边界。

#### Scenario: AI domain ownership can be described without historical package ambiguity
- **GIVEN** 团队需要描述 AI 领域微内核的正式 contract 与 logic ownership
- **WHEN** Wave 9 完成
- **THEN** 这些 ownership 应可通过显式 domain-ai 边界描述
- **AND** 不应继续完全依赖历史命名推断

### Requirement: Composer AI Facet Must Become Thinner
系统应当收紧 `composer/ai-contract`，使其成为明确的 AI facet，而不是继续携带过重的 runtime root types。

#### Scenario: AI facet no longer behaves like a second root contract
- **GIVEN** platform-first composer 已经建立
- **WHEN** Wave 9 完成
- **THEN** `composer/ai-contract` 应只承载 AI-specific facet contract
- **AND** 不应继续充当事实上的第二个 runtime root contract
