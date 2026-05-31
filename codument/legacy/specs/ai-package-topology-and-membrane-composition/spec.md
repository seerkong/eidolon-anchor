## ADDED Requirements

### Requirement: AI package topology SHALL be renamed and regrouped around core, organ, support, composer, and membrane ownership
系统应当将当前 AI 相关 package topology 重构为 `ai-core-*`、`ai-organ-*`、`ai-support`、`ai-composer` 与 `membrane` 的明确分层，而不是继续保留 `domain-ai-*` 与历史 ownership 混杂状态。

#### Scenario: Existing domain-ai packages are renamed into ai-core and ai-support hosts
- **GIVEN** 当前仓库存在 `@cell/domain-ai-contract`、`@cell/domain-ai-logic`、`@cell/domain-ai-support`
- **WHEN** 本轮 package topology 重构完成
- **THEN** 它们必须分别由 `@cell/ai-core-contract`、`@cell/ai-core-logic`、`@cell/ai-support` 承接正式 ownership
- **AND** 旧 package 不得继续作为长期正式宿主

#### Scenario: AI-specific organ ownership is split out into dedicated ai-organ packages
- **GIVEN** 当前 `@cell/organ-contract` 与 `@cell/organ-logic` 同时承载 AI-specific 组织层契约与逻辑
- **WHEN** 本轮重构完成
- **THEN** 必须新增 `@cell/ai-organ-contract` 与 `@cell/ai-organ-logic`
- **AND** 它们应分别承接 AI-specific organ data / organ logic 的正式 ownership

#### Scenario: Legacy organ packages are deleted after source migration
- **GIVEN** 当前 `@cell/organ-contract` 与 `@cell/organ-logic` 仍保留一部分 AI runtime 相关源码
- **WHEN** 本轮 ownership cutover 完成
- **THEN** 这些源码必须迁入 `@cell/ai-organ-contract` 与 `@cell/ai-organ-logic`
- **AND** 旧 `organ-*` 包、workspace alias 与 package 注册必须被删除，而不得继续保留第二套正式源码真相

### Requirement: AI composer ownership SHALL belong to @cell/ai-composer rather than ai-core-logic
系统应当让 AI runtime composition contract、profile/extension reducer 与 runtime deps composition helper 的正式宿主变为 `@cell/ai-composer`，而不是继续让 composer 逻辑散落到 runtime entry 或 `ai-core-logic` 中。

#### Scenario: Composer is renamed and aligned with composer-style responsibility
- **GIVEN** 当前 `@cell/composer` 已承担 runtime assembly contract 与 profile reduction
- **WHEN** 本轮重构完成
- **THEN** 该包必须迁移并改名为 `@cell/ai-composer`
- **AND** 其职责必须是组合层职责

#### Scenario: Core logic does not become the fallback host for composition ownership
- **GIVEN** `ai-core-logic` 负责 AI core runtime glue 和 host-facing helper
- **WHEN** 本轮 package ownership 被审查
- **THEN** `ai-core-logic` 不得成为 composer ownership 的正式宿主
- **AND** runtime composition contract 不得继续私下回流到 logic 包

### Requirement: AI support SHALL own environment implementations and support-bundle creation
系统应当让 `@cell/ai-support` 成为 AI 宿主环境实现与 support bundle factory 的正式宿主，而不是继续让 profile/composer 组合链直接正式拥有本地文件实现。

#### Scenario: Mod profiles no longer own LocalFile support implementations as formal runtime backends
- **GIVEN** 当前 `mod-ai-kernel` 仍直接使用 `LocalFile*` support 实现
- **WHEN** 本轮 topology 重构完成
- **THEN** 这些本地宿主实现的正式 ownership 必须迁入 `@cell/ai-support`
- **AND** `mod-ai-kernel` 不得继续作为它们的正式宿主

#### Scenario: AI support becomes the formal host for runtime support bundle creation
- **GIVEN** runtime entry 需要 message history、orchestration history、snapshot repository、permission store、agent loader 等环境能力
- **WHEN** runtime 进行正式装配
- **THEN** 这些能力必须通过 `@cell/ai-support` 提供的正式 support 宿主获得
- **AND** runtime entry 不得继续绕过 support host 直接拼接默认本地实现

### Requirement: AI organ contract SHALL own RuntimeDeps and other AI-specific organization-layer contracts
系统应当让 `@cell/ai-organ-contract` 成为 AI-specific 组织层依赖组合与相关 contract 的正式宿主。

#### Scenario: RuntimeDeps moves into ai-organ-contract
- **GIVEN** runtime 需要组合 core contract、support bundle 和组织层运行时依赖
- **WHEN** 定义 `RuntimeDeps` 或等价的组织层依赖组合结构
- **THEN** 这些 contract 必须定义在 `@cell/ai-organ-contract`
- **AND** 不得继续挂在错误的 core 或历史 organ ownership 下

#### Scenario: AI-specific permission and persistence contracts are reviewed for organ ownership
- **GIVEN** 权限配置、派生索引、组织层恢复等 contract 当前分散在历史 organ 包中
- **WHEN** 完成本轮重构
- **THEN** AI-specific 的组织层 contract 必须迁入 `@cell/ai-organ-contract`
- **AND** 非 AI-generic 的内容不应继续混在历史泛化 ownership 中

#### Scenario: Legacy organ-contract package is removed after contract migration
- **GIVEN** `organ-contract` 中仍存在 `DelegateRunMode`、`AgentCatalogLoader`、`MemberRole`、`LocalPermissionConfig`、`RuntimeDerivedIndexes` 等源码文件
- **WHEN** `ai-organ-contract` 成为正式宿主
- **THEN** 上述 contract 的源码真相必须位于 `@cell/ai-organ-contract`
- **AND** `@cell/organ-contract` 的目录、tsconfig alias 与 package 依赖声明必须被删除

### Requirement: AI organ logic SHALL own orchestration, organization, coordination, and recovery logic
系统应当让 `@cell/ai-organ-logic` 承担 AI-specific orchestration / organization / coordination / permission runtime / runtime recovery 等组织层逻辑。

#### Scenario: AI organization logic moves into ai-organ-logic
- **GIVEN** 当前 `organ-logic` 中存在 MemberManager、OrganizationManager、CoordinationEngine、TaskTreeManager 等 AI-specific 组织逻辑
- **WHEN** 本轮 topology 重构完成
- **THEN** 这些逻辑必须由 `@cell/ai-organ-logic` 承接正式 ownership
- **AND** 不得继续长期停留在历史混合 ownership 中

#### Scenario: Runtime recovery and coordination paths are reviewed for organ logic ownership
- **GIVEN** runtime recovery、coordinator、detached actor coordination 等逻辑当前位于历史 organ host
- **WHEN** 评审新的 AI package topology
- **THEN** 这些 AI-specific 组织层逻辑应优先归入 `@cell/ai-organ-logic`
- **AND** `ai-core-logic` 不应被迫承担组织层职责

#### Scenario: ai-organ-logic depends on ai-core-logic rather than the reverse
- **GIVEN** `ai-core-logic` 承担 AI core facade、graph 与配置解析等 core 级能力
- **WHEN** shell runtime、LLM、MCP、runtime bootstrap 与组织层协调能力被重新分层
- **THEN** `@cell/ai-organ-logic` 可以依赖 `@cell/ai-core-logic`
- **AND** `@cell/ai-core-logic` 不得反向依赖 `@cell/ai-organ-logic`

#### Scenario: Legacy organ-logic package is removed after logic migration
- **GIVEN** `organ-logic` 中仍保留 delegate actor、tool composer、llm、stream、permission runtime、task tree、questionnaire 与 holon orchestration 等 AI runtime 逻辑源码
- **WHEN** `ai-organ-logic` 成为正式宿主
- **THEN** 这些源码必须迁入 `@cell/ai-organ-logic` 并以其为主要导入面
- **AND** `@cell/organ-logic` 的目录、测试目录、tsconfig alias 与 package 依赖声明必须迁移并删除

### Requirement: AI core contract and logic SHALL own all AI-specific core data and behavior
系统应当让 `@cell/ai-core-contract` 与 `@cell/ai-core-logic` 成为 AI core 层数据与逻辑的唯一正式宿主，而不是继续让 `core-contract` / `core-logic` 保留 AI-specific 真相源。

#### Scenario: AI-specific logic is extracted from core-logic into ai-core-logic
- **GIVEN** `cell/packages/core-logic` 中仍保留 AI runtime actor、VM、semantic graph、LLM stage pipeline、runtime transcript、config loader 等 AI 领域专属逻辑
- **WHEN** 本轮 core ownership cutover 完成
- **THEN** 这些 AI-specific 逻辑必须迁入 `@cell/ai-core-logic`
- **AND** 若原实现把数据与方法混在同一对象中，应拆成 AI core data 与以该数据为首参数的静态逻辑函数后再迁移

#### Scenario: AI-specific data moves into ai-core-contract
- **GIVEN** `cell/packages/core-contract` 与 `cell/packages/core-logic` 中仍保留 AI runtime actor / VM / stream / coordination / questionnaire / LLM / snapshot 等数据定义
- **WHEN** 本轮 core ownership cutover 完成
- **THEN** 这些 AI-specific 数据定义必须迁入 `@cell/ai-core-contract`
- **AND** `@cell/ai-core-logic` 只能保留逻辑实现与 facade，而不再私藏第二套数据真相

#### Scenario: Legacy AI compatibility layers are removed from core packages
- **GIVEN** `@cell/core-contract` 与 `@cell/core-logic` 曾在迁移期通过 compatibility export 暴露 AI-specific surface
- **WHEN** `ai-core-*` 成为正式宿主
- **THEN** `core-contract` 与 `core-logic` 下不再保留 AI 领域专属源码或 compatibility shell
- **AND** 仓库活动 consumer 必须切到 `@cell/ai-core-contract` / `@cell/ai-core-logic`

### Requirement: Membrane SHALL become a higher-level composer facade host
系统应当让 `@cell/membrane` 成为位于 `@cell/ai-composer` 之上的更高层 facade 聚合面，以便未来继续封装更多领域 composer，而不是继续维持空壳状态。

#### Scenario: Membrane wraps ai-composer as a higher-level runtime composition facade
- **GIVEN** `@cell/ai-composer` 提供 AI 领域 runtime composition 能力
- **WHEN** 高层 consumer 需要更产品化或更上层的 facade
- **THEN** `@cell/membrane` 应能封装 `@cell/ai-composer` 并暴露更高层 facade
- **AND** membrane 不得继续只是无职责 re-export 壳

#### Scenario: Membrane remains extensible to future composers
- **GIVEN** 未来仓库可能引入更多领域的 composer
- **WHEN** 设计 membrane 的正式职责
- **THEN** 它必须允许在 AI composer 之外继续聚合更多领域 composer
- **AND** 不得把 membrane 设计成只服务单一当前实现的临时命名层

### Requirement: Terminal consumers SHALL depend on appropriate facade layers rather than a single forced entrypoint
系统应当允许 `terminal/*` 按职责引用不同层级的 `cell/*` facade/contract，但必须保持明确的层级消费边界，避免无边界地直接拉取内部实现细节。

#### Scenario: Terminal is not forced to consume membrane as the only entrypoint
- **GIVEN** 不同 terminal 子包对 runtime composition、runtime bridge、host glue 的抽象需求不同
- **WHEN** 评审新的 package topology
- **THEN** `terminal/*` 可以引用 `membrane` 或其他合适层级的 `cell/*` facade
- **AND** 系统不得强制规定 terminal 只能通过 membrane 访问所有能力

#### Scenario: Terminal consumers use layer-appropriate facades
- **GIVEN** `terminal/core`、`terminal/organ`、`terminal/tui`、`terminal/cli` 的职责层级不同
- **WHEN** 它们需要消费 AI runtime 相关能力
- **THEN** 它们应按职责消费对应层级的 facade/contract
- **AND** 不得越级拉取大量 composer/support/mod internals 形成新的耦合真相

### Requirement: Migration SHALL preserve compatibility through an explicit cutover plan
系统应当通过显式迁移计划完成新 package topology 的切换，而不是要求全仓一次性无保护改名。

#### Scenario: Only non-organ legacy packages may keep temporary compatibility shells
- **GIVEN** 旧 package 名称已被多个 consumer 和测试使用
- **WHEN** 本轮 rename 和 ownership cutover 开始
- **THEN** 除 `organ-contract` / `organ-logic` 外的旧 package 可以在迁移期保留 forwarding shell 或等价兼容层
- **AND** 这些兼容层必须被标记为过渡方案，而非长期正式宿主

#### Scenario: Focused tests guard the new package topology and facade ownership
- **GIVEN** 本轮会影响 package name、导入路径、ownership 和 facade 使用边界
- **WHEN** 实现完成
- **THEN** 应存在 focused tests 锁定 package ownership、membrane facade、terminal adoption 与兼容层 cutover 行为
- **AND** 迁移后不应继续留下第二套正式 package ownership 真相源
