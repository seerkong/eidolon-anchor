## ADDED Requirements

### Requirement: Shell Bridge Must Not Own AI Slash Truth
系统应当让 AI slash/direct-action contract 从 `terminal/core` 的硬编码语法下沉到 AI domain kernel 资产。

#### Scenario: Slash grammar follows AI domain kernel ownership
- **GIVEN** runtime 需要 `actor/member/holon` 等 AI slash/direct action contract
- **WHEN** Wave 8 完成
- **THEN** 这些 contract 应来自 AI domain kernel
- **AND** `terminal/core` 不应继续成为其正式真相源

### Requirement: Shell Runtime Must Move Closer To Platform-Neutral Bridge
系统应当继续收紧 shell/runtime entry 对 AI 领域细节的直接了解。

#### Scenario: Terminal runtime consumes capability ports rather than AI internals
- **GIVEN** `TerminalRuntime` 需要创建 turn bridge 与 projection bridge
- **WHEN** Wave 8 完成
- **THEN** 它应优先消费 assembly result 与 capability ports
- **AND** 不应继续直接持有过多 AI-specific coordination/organization/bootstrap truth
