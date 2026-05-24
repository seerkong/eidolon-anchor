## ADDED Requirements

### Requirement: Vendor DataGraph SHALL Expose Structured Node Reference Primitives
系统应当在 `vendor/depa-data-graph` 中提供结构化的 node identity primitive，使 graph node 的正式身份不再只依赖裸字符串字面量。

说明：
- 该 primitive 应可表达节点的稳定身份与值类型
- 最终字符串 ID 可以继续存在，但应降级为 runtime canonicalization 结果，而不是上层主要编程对象

#### Scenario: Runtime API consumes typed node references
- **GIVEN** 调用方需要声明 signal、computed、processor、consumer 或执行 `get/set/peek/node`
- **WHEN** 调用方使用 vendor graph API
- **THEN** 应当能够以结构化 node reference 作为一等输入
- **AND** 该 reference 应能携带节点值类型信息
- **AND** 调用方不应被迫继续在业务代码中手写同一批裸字符串 ID

### Requirement: Vendor DataGraph SHALL Support Modular Graph Definitions With Public Port Boundaries
系统应当允许 graph 以 module 形式定义，并显式区分公开端口与内部实现节点。

说明：
- graph module 至少应支持 `inputs`、`outputs` 与 `internals/state` 这类边界
- 外层组合者默认只应依赖 module 暴露的公开端口

#### Scenario: Parent graph wires only through child public ports
- **GIVEN** 某个子图被定义为可复用 graph module
- **WHEN** 外层 graph 组合该子图
- **THEN** 外层应通过该 module 的 `inputs/outputs` 完成 wiring
- **AND** 不应把子图内部节点默认暴露为正式跨层依赖面

### Requirement: Derived And Nested Graphs SHALL Support Scoped Mounting Without Global Enum Pollution
系统应当支持同一 graph module 在不同层级、不同实例中重复挂载，并通过作用域化 mount 机制生成稳定的 runtime identity。

#### Scenario: Same module is mounted multiple times
- **GIVEN** 某个 graph module 需要被多个 actor、多个 view model 或多个 subgraph 实例复用
- **WHEN** 调用方在不同 scope 下多次挂载该 module
- **THEN** 每个挂载实例都应获得稳定且互不冲突的 runtime canonical ID
- **AND** 调用方不应依赖全局 enum、集中式字符串表或人工前缀拼接来避免冲突

### Requirement: Builder And Dependency APIs SHALL Accept Reference-First Wiring
系统应当使 builder 与 dependency declaration API 以 node reference 为正式 wiring 入口，而不是长期要求 `deps: string[]`、`outputs: string[]`。

#### Scenario: Computed and processor dependencies are declared with refs
- **GIVEN** 调用方定义 computed、processor 或 consumer 节点
- **WHEN** 其声明依赖节点与输出节点
- **THEN** 应当能够通过 node reference / port reference 声明这些依赖
- **AND** ref wiring 的类型检查应覆盖 `deps`、`outputs`、`ctx.get/set` 与 builder API

### Requirement: JSON DSL And Codegen SHALL Converge On The Same Identity Model
系统应当使 JSON DSL、code-first graph 定义与 codegen 产物在 node identity 模型上保持一致，而不是长期维持一套模块化 ref 模型和一套扁平字符串模型。

#### Scenario: JSON or codegen graph participates in modular composition
- **GIVEN** 某个 graph 来源于 JSON DSL 或 codegen 产物
- **WHEN** 该 graph 被组合到更高层 graph module 中
- **THEN** 其公开 identity surface 应与 code-first module 使用同一套概念模型
- **AND** 调用方不应因 graph 来源不同而退回到字符串级手工 wiring

### Requirement: Vendor Identity Layer SHALL Remain Domain-Agnostic
系统应当保持 vendor graph identity layer 为领域无关的通用机制，不将 AI-specific stage/transcript 语义直接固化为基础库概念。

#### Scenario: Identity API is reviewed for new domain terms
- **GIVEN** 某个新 identity abstraction 被提议加入 vendor
- **WHEN** 审查其 API 命名和建模边界
- **THEN** 该 abstraction 应只表达 graph identity、module composition、mount scope、port visibility 等通用概念
- **AND** 不应直接引入 lexical、syntactic、semantic、questionnaire、tool-call 等 AI-specific 领域词汇

### Requirement: Migration SHALL Preserve A Controlled Compatibility Layer
系统应当为现有字符串 API 提供受控兼容层与迁移路径，避免在新 identity model 落地期间形成新的长期双轨真相源。

#### Scenario: Existing string-based graph code is migrated incrementally
- **GIVEN** 仓库中已存在大量基于字符串 ID 的 graph 定义和调用点
- **WHEN** 新的模块化 node identity 能力落地
- **THEN** 项目应允许通过兼容层分阶段迁移现有调用点
- **AND** 新增能力应以 module/ref-first API 作为正式推荐路径
- **AND** 迁移完成后不应长期维持两个同等正式的 identity truth source
