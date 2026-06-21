## ADDED Requirements

### Requirement: Domain AI Hosts Must Become Preferred Consumer Entrypoints
系统应当让 `@cell/domain-ai-contract` 与 `@cell/domain-ai-logic` 成为 AI-specific contract/logic 的默认消费入口，而不是继续主要依赖历史 `core-*` / `organ-*` 路径。

#### Scenario: New AI-specific consumers prefer domain-ai hosts
- **GIVEN** 某个 composer/mod/shell/test 需要消费 AI-specific contract 或 AI runtime logic
- **WHEN** 完成本 track
- **THEN** 它应优先从 `@cell/domain-ai-contract` 或 `@cell/domain-ai-logic` 导入
- **AND** 不应继续默认走历史 `core-*` / `organ-*` 入口

### Requirement: Consumer Cutover Must Not Introduce A Second Truth Source
系统应当通过增量 consumer cutover 强化 domain-ai host，而不是复制一份新的 contract/logic 真相。

#### Scenario: Domain-ai host remains the formal ownership shell
- **GIVEN** 历史实现文件仍可能暂时保留在 `core-*` / `organ-*`
- **WHEN** 完成本 track
- **THEN** domain-ai host 应成为正式对外入口
- **AND** 不应出现另一套独立的 AI contract/logic host
