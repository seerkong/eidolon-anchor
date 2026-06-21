## ADDED Requirements

### Requirement: Runtime VM Must Be Split Into Platform And AI Facets
系统应当将当前单体 `AiAgentVm` 拆分为 platform facet 与 AI facet，而不是继续让平台与 AI state 共用一个不透明 VM 类型。

#### Scenario: Platform facet carries generic runtime ownership
- **GIVEN** runtime 需要 actor runtime、generic registries、callbacks、effects、outer context 等执行平台状态
- **WHEN** 完成 VM facet split
- **THEN** 这些状态应归入 platform facet
- **AND** 不应再默认通过 AI-shaped VM 类型表达

#### Scenario: AI facet carries domain-specific runtime ownership
- **GIVEN** runtime 需要 member/holon、AI coordination、AI detached work、AI semantic state 等领域状态
- **WHEN** 完成 VM facet split
- **THEN** 这些状态应归入 AI facet
- **AND** 平台 facet 不应继续直接承载它们的正式真相定义

### Requirement: VM Facet Split Must Preserve Runtime Behavior
系统应当通过增量兼容方式完成 VM facet split，不得破坏当前 runtime 主路径。

#### Scenario: Existing runtime entry continues to work during facet split
- **GIVEN** terminal/tui/headless 仍使用当前 runtime 主路径
- **WHEN** Wave 6 实施完成
- **THEN** focused tests 与 adoption 路径应继续通过
- **AND** 不得通过平行保留两套 runtime truth 规避迁移
