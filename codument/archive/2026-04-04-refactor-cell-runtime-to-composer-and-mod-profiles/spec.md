## ADDED Requirements

### Requirement: Cell Composer SHALL Provide Formal Capability Composition For Runtime Assembly
系统应当让 `@cell/composer` 成为正式的 capability composition layer，用于解析 profile、组合 extension/bundle 并装配 runtime 所需能力。

#### Scenario: Runtime is assembled through composer
- **GIVEN** 某个 runtime 需要组合 agent、tool、prompt、slash route、bootstrap initializer 等能力
- **WHEN** 该 runtime 通过正式组合层进行装配
- **THEN** `@cell/composer` 应当负责解析这些能力并生成装配结果
- **AND** runtime 不应继续自己手工内嵌全部默认装配逻辑

#### Scenario: Composer consumes manifest-backed capability bundles
- **GIVEN** 底层工具、route 或 command 已经通过 manifest/bundle 协议暴露
- **WHEN** `@cell/composer` 组装某个 runtime profile
- **THEN** 它应能够消费这些 manifest/bundle 并产出最终装配结果
- **AND** 组合面不应退回为新的全局静态硬编码列表

### Requirement: Composer SHALL Expose A Stable Runtime Assembly Result Contract
系统应当让 `@cell/composer` 输出稳定的 runtime assembly result contract，使 terminal 或其他 runtime 入口只消费装配结果，而不重新定义默认产品语义。

#### Scenario: Runtime entry consumes assembly result
- **GIVEN** 某个 runtime 入口需要获得 system messages、agent seeds、tool registry、route surface 与 bootstrap hooks
- **WHEN** 它调用 `@cell/composer`
- **THEN** 这些默认装配结果应通过统一 contract 返回
- **AND** runtime 入口不应再自己重新拼装一份平行的默认定义

#### Scenario: Assembly result carries richer runtime composition ownership
- **GIVEN** 第一轮 cutover 之后 runtime 入口仍需要默认 tooling、slash route surface、registry bootstrap 与 capability 元信息
- **WHEN** 它消费 `@cell/composer` 返回的 assembly result
- **THEN** 这些装配结果应作为 contract 的正式组成部分暴露
- **AND** `@cell/composer` 不应重新退化成新的静态默认拼装中心

#### Scenario: Extension-facing assembly contract is owned by composer
- **GIVEN** 某个 mod package 或第三方 overlay 需要实现 `RuntimeExtension` 并参与 runtime 组装
- **WHEN** 它依赖正式的 assembly contract 类型
- **THEN** 这些 contract 类型应由 `@cell/composer` 暴露
- **AND** extension 不应再通过 `@cell/mod-sys-kernel` 才能获得组合 contract

#### Scenario: Composer contract ownership does not create reverse package dependency cycles
- **GIVEN** `@cell/composer` 已成为 extension-facing assembly contract 的正式宿主
- **WHEN** 默认 kernel/coding profile 需要聚合这些 mod 贡献形成内置 profile
- **THEN** 默认 profile 聚合层应位于 composer 之上的独立薄层，而不是让 `@cell/composer` 反向依赖默认 mod bundle
- **AND** `@cell/mod-sys-kernel` / `@cell/mod-sys-coding` 应继续只依赖 composer contract，而不与 composer 根包形成工作区依赖环

### Requirement: Default System Capability SHALL Move Into Ext Sys Kernel
系统应当将默认系统能力 bundle 收口到 `@cell/mod-sys-kernel`，而不是继续写死在 `core/organ/terminal` 中。

#### Scenario: Runtime needs default system capability
- **GIVEN** 某个 runtime 需要默认系统能力
- **WHEN** 它通过 composer/profile 进行装配
- **THEN** 这些能力应来自 `@cell/mod-sys-kernel`
- **AND** 不应再以 runtime 内部硬编码方式作为唯一正式来源

#### Scenario: Kernel bundle provides default runtime bootstrap pieces
- **GIVEN** 默认 runtime 启动需要 system prompt、default agent seed、tool/route bootstrap 与初始化 hook
- **WHEN** 第一轮 composer/mod cutover 完成
- **THEN** 这些默认系统能力应由 `@cell/mod-sys-kernel` 暴露
- **AND** `TerminalRuntime.createRuntimeBridge()` 不应继续直接定义它们

#### Scenario: Kernel owns baseline tooling and slash surface
- **GIVEN** 默认 runtime 需要默认 tool registry、toolset 组合与 slash surface 基线
- **WHEN** runtime 通过 composer/profile 选择 kernel bundle
- **THEN** 这些 baseline capability 应由 `@cell/mod-sys-kernel` 暴露
- **AND** `@cell/composer` 与 `TerminalRuntime` 不应各自再维护一份平行默认定义

### Requirement: Default Coding Overlay SHALL Move Into Ext Sys Coding
系统应当将默认 coding app 语义收口到 `@cell/mod-sys-coding`，包括 coding agent、coding prompt overlay、delegate-agent capability selection 与 coding policy。

#### Scenario: Runtime selects coding overlay
- **GIVEN** 某个 runtime 需要默认 coding app 语义
- **WHEN** 它通过 composer/profile 选择 coding overlay
- **THEN** 这些能力应来自 `@cell/mod-sys-coding`
- **AND** runtime 本身不应继续默认假定“当前应用就是 coding agent”

#### Scenario: Coding overlay augments kernel bundle without forking runtime entry
- **GIVEN** 默认 coding app 需要在系统 bundle 之上叠加 coding agent、coding prompt overlay 与 coding capability 选择
- **WHEN** runtime 选择 coding profile
- **THEN** `@cell/mod-sys-coding` 应以 overlay 或等价方式叠加这些差异
- **AND** 不应要求 `TerminalRuntime` 单独维护一套 coding 专用默认装配分支

#### Scenario: Coding overlay is applied after kernel baseline
- **GIVEN** kernel bundle 提供系统级 baseline，coding profile 只表达 coding 差异
- **WHEN** composer 组装默认 coding runtime profile
- **THEN** kernel baseline 应先建立基础 bundle
- **AND** coding overlay 应在其上叠加 agent、prompt 与 capability 差异

#### Scenario: Coding overlay contributes delegate-agent capability selection
- **GIVEN** kernel baseline 已提供通用 tooling 组装能力
- **WHEN** coding overlay 为默认 runtime 注入 fallback coding agent 或覆盖 delegate-agent 选择
- **THEN** 最终 runtime assembly 应体现出来自 coding overlay 的 delegate-agent capability 差异
- **AND** 该差异不应再由 `TerminalRuntime` 或 `@cell/composer` 私下补齐

### Requirement: Terminal SHALL Remain Shell Bridge Rather Than Default Product Definition Host
系统应当让 terminal 继续承担 shell I/O、projection bridge 与 turn driver 的职责，但不再让它成为默认产品定义与默认 capability 装配的正式宿主。

#### Scenario: Terminal runtime is reviewed for product defaults
- **GIVEN** terminal runtime 提供用户交互与 runtime bridge
- **WHEN** 检查默认 agent、默认 prompt、默认 tool bundle、默认 slash surface 的来源
- **THEN** 这些默认产品语义应来自 composer/profile/mod 装配结果
- **AND** terminal 自身只保留 shell bridge 所必需的职责

### Requirement: First Iteration SHALL Be Verified Through Real Terminal Runtime Adoption
系统应当在本 track 第一轮中通过真实 `TerminalRuntime` 接线验证 composer/mod profile 装配，而不是只停留在空包或独立示例层。

#### Scenario: Terminal runtime no longer hardcodes default product assembly
- **GIVEN** `TerminalRuntime.createRuntimeBridge()` 当前仍直接定义默认 agent、默认 system prompt 与默认工具装配
- **WHEN** 第一轮实现完成
- **THEN** 这些默认定义应改为来自 composer 产出的装配结果
- **AND** terminal 只保留 shell bridge、runtime lifecycle 与 projection 相关职责

#### Scenario: Migration is guarded by focused tests
- **GIVEN** composer/mod profile 第一轮 cutover 会影响默认 runtime 入口
- **WHEN** track 推进实现
- **THEN** 应存在 focused tests 锁定 composer 组合结果、mod overlay 叠加语义与 terminal adoption 路径
- **AND** 迁移完成后不应继续留下第二套默认 runtime 装配真相源

#### Scenario: Focused tests verify ownership rather than source-code strings
- **GIVEN** 迁移后的风险是默认 tooling 或 overlay 语义悄悄回流到 composer 或 terminal
- **WHEN** focused tests 检查默认 runtime adoption
- **THEN** 它们应验证实际装配行为、bundle ownership 与 overlay 顺序
- **AND** 不应只依赖对 `TerminalRuntime.ts` 的源码 grep

#### Scenario: Focused tests prove slash routing depends on assembly ownership
- **GIVEN** slash namespace 或 action surface 已由 runtime assembly 声明
- **WHEN** focused tests 改变 assembly 暴露的 slash route/action contract
- **THEN** `TerminalRuntime` 的直接 slash 行为应随 assembly 变化
- **AND** terminal 不应继续保留同等能力作为第二真相源

#### Scenario: Slash grammar, help, and prompt expansion follow assembly ownership
- **GIVEN** runtime assembly 暴露了某个 namespace 的 slash action contract
- **WHEN** terminal 解析 direct slash、展示 `/<namespace> help`，或把未直达的 slash 输入扩展为提示文本
- **THEN** 可识别的 action、help 文案与 prompt expansion 都应随 assembly contract 变化
- **AND** `terminal/core` 不应继续私下保留一份静态 grammar/help truth 作为第二真相源

#### Scenario: Non-runtime callers do not fall back to a module-local slash contract
- **GIVEN** TUI facade、prompt 组件或其他非 `TerminalRuntime` 调用方也需要判断 formal slash 输入
- **WHEN** 它们调用 slash 解析、help 或 prompt expansion 能力
- **THEN** 它们应显式消费 runtime assembly 提供的 slash descriptor，或退化为不做 formal slash 解析
- **AND** 它们不应因为 `terminal/core` 的隐式默认值而继续获得一份静态 slash contract
