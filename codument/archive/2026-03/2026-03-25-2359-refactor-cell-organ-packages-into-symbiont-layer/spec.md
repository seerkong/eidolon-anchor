## ADDED Requirements

### Requirement: cell 低层 contract 必须以 symbiont 命名承载

系统应当（SHALL）将不依赖 `core-contract` 的低层可复用 contract 层从 `organ-contract-low` 收敛为 `symbiont-contract`。

#### Scenario: 低层 stream 与 actor-framework contract 使用 symbiont-contract
- **GIVEN** 当前存在 `organ-contract-low`
- **WHEN** 完成本次重构
- **THEN** 低层 stream / actor-framework contract 应位于 `symbiont-contract`
- **AND** 这些 contract 不得继续以 `organ-contract-low` 作为正式来源

### Requirement: 依赖 core 定义的组织领域 contract 必须收敛为 organ-contract

系统应当（SHALL）将当前 `organ-contract-high` 收敛为 `organ-contract`，明确其是依赖核心定义的业务器官契约层。

#### Scenario: 组织领域 contract 使用 organ-contract 命名
- **GIVEN** 当前存在 `organ-contract-high`
- **WHEN** 完成本次重构
- **THEN** `DelegateRunMode`、`MemberRole` 等依赖核心定义的组织领域 contract 应位于 `organ-contract`
- **AND** 不再以 `organ-contract-high` 作为正式来源

### Requirement: 可脱离项目核心复用的低层实现必须进入 symbiont-logic

系统应当（SHALL）提供 `symbiont-logic`，承载不依赖 `core-contract` 的低层可复用 logic。

#### Scenario: stream / ingress 基础设施下沉到 symbiont-logic
- **GIVEN** 当前 `core-logic` 或 `organ-logic` 中存在低层 stream / ingress 基础设施
- **WHEN** 完成本次重构
- **THEN** `IngressStreams`、`StreamTranscript`、`StreamLogger`、`IngressStreamRuntime`、`OpenAICompletionsNodejsFetchStreamAdapter` 等第一批低层实现应迁入 `symbiont-logic`
- **AND** `core-logic` 应通过依赖 `symbiont-logic` 使用这些能力

### Requirement: workspace 不得继续保留旧 package 名作为正式导入面

系统应当（SHALL）一次性更新 workspace 内的 package dependency、TS path 和 import surface，使其收敛到 `symbiont-contract`、`organ-contract`、`symbiont-logic`。

#### Scenario: 仓库内导入面收敛到新 package 名称
- **GIVEN** `cell`、`backend`、`terminal` 与测试代码中存在旧 package import
- **WHEN** 完成本次重构
- **THEN** 仓库内正式导入面应切换到新的 package 名称
- **AND** 不得依赖兼容 alias 继续引用 `organ-contract-low` 或 `organ-contract-high`

## NON-FUNCTIONAL Requirements

### Requirement: 新包边界必须反映可复用性与业务依赖边界

系统应当（SHALL）让包命名和依赖方向准确表达“共生层”和“业务器官层”的边界，而不是只做目录重命名。

#### Scenario: core 与 organ 对 symbiont 的依赖方向清晰
- **GIVEN** `symbiont-*` 表示可脱离项目核心复用的共生层
- **WHEN** 完成本次重构
- **THEN** `core-logic` 可以依赖 `symbiont-logic`
- **AND** 依赖核心定义的组织业务逻辑不得反向下沉到 `symbiont-*`
