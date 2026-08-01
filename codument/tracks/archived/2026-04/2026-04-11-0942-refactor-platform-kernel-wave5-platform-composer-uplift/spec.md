## ADDED Requirements

### Requirement: Composer Root Assembly Must Be Platform-First
系统应当让 `@cell/composer` 的主装配入口先组合平台 capability，再由 AI facet 在其上叠加领域语义。

#### Scenario: Root composer assembles platform state before AI overlays
- **GIVEN** runtime profile 需要最终产出可执行的 assembly result
- **WHEN** `@cell/composer` 执行主装配流程
- **THEN** 它应先建立 platform-level assembly state/result
- **AND** AI-specific assembly state 不得继续成为根装配器的唯一初始状态模型

#### Scenario: AI runtime assembly remains an explicit facet on top of platform assembly
- **GIVEN** `ai-kernel` 或 `ai-coding` profile 需要 provider/tool/slash/runtime support 等 AI 领域能力
- **WHEN** 它们参与 composer 装配
- **THEN** 这些 AI capability 应作为明确的 domain facet 叠加到 platform assembly 上
- **AND** 平台装配 contract 不应直接内嵌 AI field 的正式真相定义

### Requirement: Platform Contract Must Own The Minimal Root Assembly Engine
系统应当让平台 contract 拥有最小根装配引擎所需的正式 assembly contract，而不是让 `ai-contract` 继续充当事实根 contract。

#### Scenario: Root assembly engine depends on platform contract rather than ai-contract
- **GIVEN** `assembleRuntimeProfile()` 是 runtime profile 的正式根装配入口
- **WHEN** 检查其依赖的 state/context/result contract
- **THEN** 它应优先依赖 platform assembly contract
- **AND** AI facet 应以扩展或派生 contract 的方式叠加，而不是反过来定义根装配器

### Requirement: Focused Tests Must Prove Platform-First Composition Ownership
系统应当通过 focused tests 锁定 platform-first composition ownership，而不是只依赖源码 grep。

#### Scenario: Platform-only profile proves root engine is not AI-shaped by default
- **GIVEN** `platform-only` profile 不引入 AI kernel/coding overlay
- **WHEN** 它通过根 composer 装配
- **THEN** 装配过程应仍然成立
- **AND** 不应因为缺少 AI facet 字段而依赖隐式 AI 默认状态

#### Scenario: AI profiles still layer correctly after composer uplift
- **GIVEN** `ai-kernel` 与 `ai-coding` profile 继续使用正式 layering
- **WHEN** composer uplift 完成
- **THEN** AI profile 的 capability ownership、overlay 顺序与 shell adoption 行为应继续成立
- **AND** 不应重新产生第二套 assembly truth
