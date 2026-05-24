## ADDED Requirements

### Requirement: Domain AI Logic Host Must Carry First-Batch Real Implementations
系统应当让 `@cell/domain-ai-logic` 不再长期停留在“显式宿主 + re-export 收口”状态，而是承接第一批 host-facing AI runtime logic 的正式实现。

#### Scenario: Domain-ai-logic becomes more than a forwarding shell
- **GIVEN** `domain-ai-logic` 已成为 AI-specific logic 的正式默认消费入口
- **WHEN** 推进本 track
- **THEN** 它应承接第一批真实 AI runtime glue 实现
- **AND** 不应继续长期只作为 `core-*` / `organ-*` 的转发壳

### Requirement: Host Implementation Cutover Must Preserve Platform And Domain Boundaries
系统应当确保 `domain-ai-logic` 的实现下沉不会把平台原语误搬入 AI domain，也不会把 AI 语义错误上移到平台层。

#### Scenario: AI host keeps host-facing glue while platform primitives stay put
- **GIVEN** actor/runtime/stream primitive 仍属于底层平台或历史基础层
- **WHEN** 下沉第一批 `domain-ai-logic` 实现
- **THEN** 优先迁移 shell/runtime facade、runtime coordinator glue、host-facing orchestration bridge
- **AND** 不应为了“宿主完整”而机械搬运 actor/runtime primitive 本体

### Requirement: Domain AI Logic Cutover Must Preserve Existing Consumer Adoption
系统应当在 `domain-ai-logic` 承接真实实现后保持 terminal/tui/headless 与 focused ownership guard 稳定。

#### Scenario: Existing consumers keep using the same formal host
- **GIVEN** terminal/tui/headless 与 focused tests 已切到 `@cell/domain-ai-logic`
- **WHEN** 本 track 完成
- **THEN** 这些 consumers 仍通过同一 formal host 工作
- **AND** 行为不应回退到历史 `core-*` / `organ-*` 入口
