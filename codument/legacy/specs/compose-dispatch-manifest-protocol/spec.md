## ADDED Requirements

### Requirement: Compose Dispatch SHALL Provide Formal Component Manifest Contracts
系统应当在 `vendor/depa-processor` 中提供正式的 component manifest contract，用于声明组件的 schema、执行协议、可见性、导出配置与分发元数据。

#### Scenario: Directory exports a component through manifest
- **GIVEN** 某个组件目录希望导出一个可注册、可路由、可分发的组件
- **WHEN** 该目录编写自己的 `index.ts`
- **THEN** 它应当能够通过正式的 component manifest contract 描述该组件
- **AND** 该 manifest 应可被上层 registry 或 composer 消费

#### Scenario: Manifest carries execution protocol without moving business logic into vendor
- **GIVEN** 某个组件已经通过 `runByFuncStyleAdapter` 或等价协议定义执行逻辑
- **WHEN** 该组件被包装为 manifest
- **THEN** manifest 应表达组件的导出与分发元数据
- **AND** vendor 不应要求把具体业务逻辑迁入 `depa-processor`

### Requirement: Compose Dispatch SHALL Preserve Directory-Level Index As Manifest Authoring Layer
系统应当保留每个组件目录中的 `index.ts` 作为 manifest/export 编排层，而不是要求统一取消目录级显式导出控制。

#### Scenario: Tool directory wants explicit export control
- **GIVEN** 某个 tool 目录需要精确控制本目录导出哪些组件
- **WHEN** 该目录使用 `vendor/depa-processor`
- **THEN** 其 `index.ts` 应当能够继续作为正式 export 编排层存在
- **AND** 不应被强制替换为不可控的全自动导出机制

#### Scenario: Directory index chooses what not to export
- **GIVEN** 某个组件目录内部包含多个逻辑实现或多个实验性变体
- **WHEN** 目录作者编写该目录的 `index.ts`
- **THEN** `index.ts` 应当能够显式决定导出哪些 manifest、忽略哪些内部组件
- **AND** 组件的导出边界应由目录作者控制

### Requirement: Compose Dispatch SHALL Support Variant-Based Manifest Export
系统应当允许同一目录导出多个变体 manifest，使不同配置、不同 prompt、不同 schema、不同 capability surface 可以由目录级 `index.ts` 显式控制。

#### Scenario: Tasktree exports flat and tree variants
- **GIVEN** 某个组件目录同时支持单层任务模式和树形任务模式
- **WHEN** 该目录定义其导出 manifest
- **THEN** 它应当能够导出多个变体 manifest
- **AND** 不同变体应能够绑定不同的 prompt、schema 或 capability 配置

#### Scenario: Variant manifest changes prompt and schema together
- **GIVEN** 两个组件变体共享核心逻辑，但使用不同 prompt 和不同输入约束
- **WHEN** 调用方选择某个 variant manifest
- **THEN** 该 variant 应一并切换其 prompt、schema 与导出元数据
- **AND** 不需要为每个变体复制整套目录结构

### Requirement: Compose Dispatch SHALL Provide Bundle And Registry Composition Foundations
系统应当在 `vendor/depa-processor` 中提供 bundle manifest、registry composer、route bundle 或 command bundle 等能力，使组件分发不再长期依赖全局静态列表手工聚合。

#### Scenario: Multiple manifests are composed into registry
- **GIVEN** 上层 runtime 需要从多个目录收集组件并装配成 registry 或 route table
- **WHEN** 上层依赖 `vendor/depa-processor`
- **THEN** 应当能够通过 bundle/registry composition foundation 完成该装配
- **AND** 不应长期依赖单一的手写全局静态列表作为唯一正式组合方式

### Requirement: First Iteration SHALL Be Verifiable Through A Real Directory-Level Variant Adoption
系统应当在本 capability 第一轮中使用至少一个真实组件目录完成 manifest variant adoption，以验证该协议不是停留在 vendor 内部抽象。

#### Scenario: Real tasktree-like directory adopts manifest protocol
- **GIVEN** 仓库内存在一个真实组件目录，具有 prompt/schema/config 差异化导出需求
- **WHEN** 第一轮实现完成
- **THEN** 该目录应至少提供两个可区分的 variant manifest
- **AND** 上层应能基于这些 manifest 完成最小的 registry 或 route 装配
- **AND** 该验证不应仅停留在 vendor 自测中的虚构示例
