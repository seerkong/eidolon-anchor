## ADDED Requirements

### Requirement: Formal Runtime Profile Layering
系统 SHALL 提供正式的 runtime profile layering，并固定顺序为 `platform-only -> ai-kernel -> ai-coding`。

#### Scenario: Assemble platform-only baseline
- **GIVEN** runtime 只请求平台基线 profile
- **WHEN** 系统装配 `platform-only`
- **THEN** 结果不应隐式包含 AI kernel 或 coding overlay capability
- **AND** 结果应保持为后续领域 overlay 的正式基线

#### Scenario: Assemble ai-kernel baseline
- **GIVEN** runtime 请求 AI 领域基线 profile
- **WHEN** 系统装配 `ai-kernel`
- **THEN** 结果应显式建立在 `platform-only` 之上
- **AND** 结果应包含 AI kernel capability
- **AND** 结果不应隐式包含 coding app overlay capability

#### Scenario: Assemble ai-coding overlay
- **GIVEN** runtime 请求 coding app profile
- **WHEN** 系统装配 `ai-coding`
- **THEN** 结果应显式建立在 `ai-kernel` 之上
- **AND** 结果应保留 kernel capability
- **AND** 结果应追加 coding overlay capability

### Requirement: Single Profile Truth Source
系统 SHALL 只维护一份正式 profile layering 真相源，不得在 platform/domain 两侧维护平行 profile 组合定义。

#### Scenario: Existing coding runtime stays on formal layering
- **GIVEN** 现有 terminal runtime 需要默认 coding runtime 装配
- **WHEN** runtime 选择默认 profile
- **THEN** 应通过 `ai-coding` 的正式装配入口获得 assembly result
- **AND** 不得在 shell/runtime entry 中重新手工拼 profile 顺序

### Requirement: Capability Absence Must Stay Explicit
系统 SHALL 通过 focused tests 锁定“缺失 capability 是正式语义”，而不是隐式回退为本地默认实现。

#### Scenario: Platform-only has no runtime bootstrap registries
- **GIVEN** `platform-only` 未声明 AI runtime bootstrap
- **WHEN** 调用方尝试创建 runtime registries
- **THEN** 系统应明确报错
- **AND** 不得偷偷回退到 AI kernel 或 coding profile
