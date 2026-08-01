## ADDED Requirements

### Requirement: Vendor DataGraph SHALL Provide Ordered Timeline And Fanout Primitives
系统应当在 `vendor/depa-data-graph` 中提供正式的 ordered timeline primitive，用于表达按序事件追加、时间线可见性和多下游 fanout 分发。

#### Scenario: Ordered timeline is modeled as vendor primitive
- **GIVEN** 项目中存在按顺序到达的流式事件源
- **WHEN** 调用方需要把这些事件作为 timeline 暴露给多个下游 consumer 或 projector
- **THEN** 应当能够仅通过 `vendor/depa-data-graph` 提供的 timeline / fanout primitive 建模该能力
- **AND** 调用方不需要继续在项目内维护与 vendor 平行的 `OutputStream` / `TeeOutputStream` 级通用 timeline 基座

### Requirement: Vendor DataGraph SHALL Provide Append-Only Event Log And Reducer Projection Primitives
系统应当在 `vendor/depa-data-graph` 中提供 append-only event log 与 reducer/projection primitive，以支持事件累积、派生快照和投影视图的通用建模。

#### Scenario: Projection graph consumes append-only event log
- **GIVEN** 某个 runtime 按顺序产生事件记录
- **WHEN** 上层需要基于这些事件构建快照、派生状态或 UI projection
- **THEN** 应当能够使用 vendor 提供的 append-only event log 与 reducer/projection primitive 完成建模
- **AND** 不应强制项目层继续用 `latest_event + seq + consumer` 这类手工模式重复实现

### Requirement: Symbiont Ingress Foundations SHALL Converge On Vendor DataGraph
系统应当使 `symbiont-*` 中的低层 ingress/timeline helper 收口到 vendor foundation，而不是长期保留双轨通用实现。

#### Scenario: Existing symbiont helper duplicates vendor capability
- **GIVEN** `symbiont-contract` 或 `symbiont-logic` 中存在某个通用 stream/timeline helper
- **WHEN** `vendor/depa-data-graph` 已提供等价的正式 primitive
- **THEN** 项目实现应当迁移到 vendor primitive 之上
- **AND** 旧 helper 只允许作为短期适配层存在，不能继续作为长期正式通用来源

### Requirement: Core And Terminal Shared Projections SHALL Converge On Vendor Event Foundations
系统应当使 `core-logic`、`organ-logic` 与 terminal 中可复用的 append-only event dispatch 与 stateful projection 基座逐步收口到 vendor foundation。

说明：
- 共享的 event log / state projection 应优先建立在 vendor primitive 之上
- 仅做表现层格式化或 UI event 发射的薄 listener，不要求在本 track 中一律改写为 reducer projection

#### Scenario: Existing project event graph duplicates vendor log or projection capability
- **GIVEN** 项目中存在某个事件 runtime，通过手工 listener、seq signal 或 projection dispatch 维护通用事件流
- **WHEN** `vendor/depa-data-graph` 已提供可表达同类抽象的 event log / projection primitive
- **THEN** 项目实现应当迁移到 vendor primitive 之上
- **AND** `AgentEventGraph`、terminal projection 或同类基座不应继续长期保留独立的通用事件日志语义

#### Scenario: Stateful snapshot projection exists in core or terminal
- **GIVEN** 某个 core 或 terminal 模块负责维护可复用的派生快照、聚合状态或 transcript-style projection
- **WHEN** 该模块本质上是 reducer-style state projection
- **THEN** 其正式状态派生逻辑应优先使用 vendor `ReducerProjection` 或等价 primitive
- **AND** 不应继续长期依赖项目内私有的 stateful projection substrate

### Requirement: AI-Specific Stream Semantics SHALL Remain Outside Vendor Core
系统应当明确将 AI-specific 的 stage event contract、LLM delta 语义、transcript naming 等能力保留在 `symbiont-*`、`core-contract` 或更高层，而不是直接沉淀到 `vendor/depa-data-graph`。

#### Scenario: AI stage contract is reviewed for vendorization
- **GIVEN** 某项 stream 能力已经带有明确的 AI-specific 语义
- **WHEN** 评估该能力是否应进入 `vendor/depa-data-graph`
- **THEN** 如果该能力依赖 lexical/syntactic/semantic、questionnaire、tool-call、transcript naming 或 AI actor event 语义
- **THEN** 该能力应继续留在 `symbiont-*`、`core-contract` 或更高层

### Requirement: Migration SHALL Be Guarded By Focused Tests And Single-Source Cutover
系统应当以 focused tests 锁定 vendor primitive、symbiont adapter 与 core/terminal cutover 的边界，避免形成新的长期双轨来源。

#### Scenario: Vendor primitive lands before project cutover completes
- **GIVEN** 新的 vendor primitive 已经实现，但项目侧仍处于迁移阶段
- **WHEN** track 按 phase 推进 cutover
- **THEN** 应当存在 focused tests 明确约束 vendor primitive 的行为、项目 adapter 的兼容语义和最终 cutover 的单源结果
- **AND** 迁移完成后不应再留下两个正式的通用 stream/timeline/projection 真相源
