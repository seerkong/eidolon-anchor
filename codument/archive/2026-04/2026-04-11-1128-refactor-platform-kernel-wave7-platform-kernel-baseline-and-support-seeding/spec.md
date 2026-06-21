## ADDED Requirements

### Requirement: Platform-Only Profile Must Expose A Real Platform Baseline
系统应当让 `platform-only` 成为真实的平台 kernel baseline，而不是继续作为空 profile 占位符。

#### Scenario: Platform-only assembles non-empty platform capability
- **GIVEN** runtime 选择 `platform-only` profile
- **WHEN** Wave 7 完成
- **THEN** 该 profile 应暴露至少一批真实平台 capability
- **AND** 这些 capability 不得依赖 AI 领域语义

### Requirement: Platform Support Must Host Real Cross-Domain Environment Implementations
系统应当让 `platform-support` 承接第一批真实跨领域环境实现。

#### Scenario: Cross-domain support leaves AI support host
- **GIVEN** 某些 support 实现不依赖 AI identity/state/tooling/provider 语义
- **WHEN** Wave 7 完成
- **THEN** 它们应进入 `platform-support`
- **AND** `domain-ai-support` 不应继续持有这些平台通用实现的正式真相
