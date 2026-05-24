## ADDED Requirements

### Requirement: Vendor Actor SHALL Provide Completion Signal And Waiter Foundations
系统应当在 `vendor/depa-actor` 中提供 keyed completion signal 与 waiter foundation，用于表达 fiber 完成等待、异步完成绑定和结果回流，而不要求业务层反复手写等待表与轮询逻辑。

#### Scenario: Parent flow waits for keyed completion

- **GIVEN** 某个 runtime 需要等待一个 child workload 或异步步骤以 key 形式回传完成结果
- **WHEN** 该 runtime 使用 `vendor/depa-actor` 的 orchestration foundation
- **THEN** 应当能够通过 vendor 提供的 completion signal / waiter foundation 完成等待与唤醒
- **AND** 不需要在业务层长期维护平行的 waiter store 机制

#### Scenario: Child completion binding routes detached or nested results

- **GIVEN** 某个 runtime 需要把 child actor / fiber 的完成事件路由回 parent 或 detached watcher
- **WHEN** 该 runtime 依赖 `vendor/depa-actor`
- **THEN** vendor 应提供 child completion binding 或等价 foundation 表达该关系
- **AND** 业务层不应继续手工维护一套平行的 completion routing helper

### Requirement: Vendor Actor SHALL Separate Persistence Protocol From Persistence Implementation

系统应当在 `vendor/depa-actor` 中将 actor / fiber / orchestrator 的持久化与恢复能力表达为 protocol、codec hook 和 effect port，而不是内置具体的 save/load 实现。

#### Scenario: Runtime wants actor persistence without fixed storage medium

- **GIVEN** 上层 runtime 需要对 actor 状态进行保存与恢复
- **WHEN** 该 runtime 依赖 `vendor/depa-actor`
- **THEN** vendor 应只要求上层注入 state codec、hydrate / recover hook 与 persistence effect adapter
- **AND** vendor 不应假定文件系统、数据库或其他具体存储介质

#### Scenario: Snapshot contract does not embed product-specific fields

- **GIVEN** 某个产品 runtime 为 actor 挂载了 domain-specific state
- **WHEN** 它基于 vendor snapshot protocol 构建保存与恢复
- **THEN** vendor snapshot contract 应只表达通用 actor / fiber / orchestrator 基础结构
- **AND** 产品字段应通过外层 codec / facet hook 注入，而不是写死在 vendor snapshot schema 中

#### Scenario: Vendor snapshot base contract is the structural source of truth

- **GIVEN** 项目侧 runtime 需要定义 actor、vm、fiber 或 manifest 的 snapshot shape
- **WHEN** 它声明这些 snapshot 类型
- **THEN** 其通用基础结构应建立在 `vendor/depa-actor` 导出的 snapshot base contract 之上
- **AND** 项目侧不应继续独立维护一套与 vendor 平行的基础 snapshot 结构定义

### Requirement: Vendor Actor SHALL Expose Actor Runtime Extension Points For Product Facets

系统应当在 `vendor/depa-actor` 中提供正式的 runtime / plugin / facet extension point，使上层能够为 actor / vm 挂载额外状态与索引，而不必把全部产品态字段内嵌进 vendor actor shell。

#### Scenario: Product runtime adds domain-specific actor state

- **GIVEN** 某个产品 runtime 需要为 actor 挂载额外 domain-specific state
- **WHEN** 该产品 runtime 构建在 `vendor/depa-actor` 之上
- **THEN** 它应当能够通过 facet、plugin 或等价扩展点挂载这些状态
- **AND** 不应要求 `vendor/depa-actor` 直接认识这些产品字段

#### Scenario: Product runtime installs indexes without forking vendor actor shell

- **GIVEN** 某个产品 runtime 需要维护 actor / fiber 的额外索引或派生视图
- **WHEN** 该 runtime 使用 `vendor/depa-actor`
- **THEN** 它应当能够通过正式扩展点安装这些索引
- **AND** 不应继续通过复制 vendor actor shell 的方式承载这些索引

### Requirement: AI-Specific Organization And Coordination Semantics SHALL Remain Outside Vendor Actor Core

系统应当明确 holon 治理语义、TaskTree、plan approval、shutdown coordination、questionnaire wait policy 等 AI-specific 业务逻辑不直接沉淀到 `vendor/depa-actor`。

#### Scenario: AI-specific actor behavior is reviewed for vendorization

- **GIVEN** 某项 actor behavior 依赖 autonomous / leader_led holon、questionnaire、TaskTree 或 coordination 业务语义
- **WHEN** 评估该能力是否进入 `vendor/depa-actor`
- **THEN** 该能力应优先保留在 `symbiont-*` 或更高层
- **AND** vendor 只沉淀其底层可复用机制

### Requirement: First Iteration SHALL Be Verified Through Real Adoption Targets

系统应当在本 capability 第一轮中使用真实仓库调用方验证新的 vendor foundation，而不是只在 vendor 内部抽象层停留。

#### Scenario: Orchestrator driver adopts vendor waiter foundation

- **GIVEN** `OrchestratorDriver` 当前仍持有项目内等待、完成绑定与 settle helper
- **WHEN** 第一轮实现完成
- **THEN** 它应开始建立在 `vendor/depa-actor` 的 completion signal / waiter foundation 之上
- **AND** 原项目内通用 waiter helper 不应继续作为正式来源

#### Scenario: Runtime snapshot adopts vendor persistence protocol

- **GIVEN** runtime snapshot / recovery 当前仍主要由项目侧 schema 与 helper 驱动
- **WHEN** 第一轮实现完成
- **THEN** actor / fiber / orchestrator 的通用 persistence protocol 应收口到 vendor
- **AND** 项目侧只保留 AI-specific product-state codec 与 effect adapter

#### Scenario: Runtime state mounting adopts vendor facet foundation

- **GIVEN** `AiAgentActor` 或 `AiAgentVm` 当前直接内嵌大量产品态字段
- **WHEN** 第一轮实现完成
- **THEN** 至少应有一类产品态挂载改为建立在 vendor facet / plugin foundation 之上
- **AND** 迁移结果应通过 focused tests 或现有回归测试证明无行为回归
