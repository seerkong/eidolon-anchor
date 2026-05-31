## ADDED Requirements

### Requirement: Cell 分层必须以 contract / support / logic 区分数据、接口与环境实现

系统应当（SHALL）将 `cell` 中的数据与接口定义收敛到 `*-contract`，将环境相关副作用实现收敛到 ownership 对应的 support 宿主包，并让其他纯逻辑保留在 `*-logic`。

#### Scenario: 数据与接口定义不再留在逻辑层
- **GIVEN** 某个 module 当前同时包含数据结构、接口定义与本地文件实现
- **WHEN** 完成本次边界重构
- **THEN** 数据结构与接口定义应位于对应的 `*-contract`
- **AND** 不应继续把正式接口定义留在 `ai-core-logic` 或 `ai-organ-logic`

#### Scenario: 环境实现不再直接留在逻辑层
- **GIVEN** 某个副作用当前直接依赖本地文件、home 配置目录或 session 目录布局
- **WHEN** 完成本次边界重构
- **THEN** 该副作用的环境实现应位于 `ai-support` 或 `platform-support`
- **AND** `*-logic` 不应继续直接持有该环境 backend 的正式实现

### Requirement: ai-core-logic 依赖的副作用接口必须先定义到 ai-core-contract

系统应当（SHALL）将 `ai-core-logic` 所依赖的副作用接口先定义到 `ai-core-contract`，再由 ownership 对应的 support 宿主提供具体实现。

#### Scenario: core runtime persistence effects 经由 ai-core-contract 暴露
- **GIVEN** `ai-core-logic` 需要消息历史、编排历史、actor transcript 或 runtime snapshot 的持久化能力
- **WHEN** 完成本次重构
- **THEN** 这些副作用接口应先由 `ai-core-contract` 定义
- **AND** `ai-core-logic` 应通过这些 contract 使用持久化能力，而不是直接依赖本地文件实现

#### Scenario: core 配置加载经由 ai-core-contract 暴露
- **GIVEN** `ai-core-logic` 需要读取模型配置、skill 目录或其他环境来源配置
- **WHEN** 完成本次重构
- **THEN** 相关副作用接口应位于 `ai-core-contract`
- **AND** 文件系统扫描与 home 目录读取实现应由 `ai-support` 或 `platform-support` 提供

### Requirement: ai-organ-logic 专属副作用接口必须定义到 ai-organ-contract

系统应当（SHALL）将 `ai-organ-logic` 专属的副作用接口定义到 `ai-organ-contract`，并由 `ai-support` 承载当前环境下的正式实现。

#### Scenario: 本地权限配置读写边界进入 ai-organ-contract
- **GIVEN** `ai-organ-logic` 需要读取和写回权限配置与 workspace access 配置
- **WHEN** 完成本次重构
- **THEN** 这些配置接口与数据定义应位于 `ai-organ-contract`
- **AND** `~/.eidolon` 本地文件实现应位于 `ai-support`

#### Scenario: agent loader 等组织层环境读取进入 ai-organ-contract
- **GIVEN** `ai-organ-logic` 需要从目录中加载 agent config 或其他组织层环境资源
- **WHEN** 完成本次重构
- **THEN** 这些读取接口应位于 `ai-organ-contract`
- **AND** 目录扫描与文件读取实现应位于 `ai-support`

### Requirement: 第一批迁移范围必须锁定为高确定性副作用实现

系统应当（SHALL）只将第一批高确定性、边界清晰的副作用实现纳入本次重构，而不是一刀切处理所有带副作用的模块。

#### Scenario: 第一批迁移项以范围文件为准
- **GIVEN** 当前 track 已声明第一批高确定性迁移项
- **WHEN** 团队推进本次重构
- **THEN** 消息历史、编排历史、actor transcript、runtime snapshot、权限配置、agent/skill/config loader 的副作用边界应优先纳入
- **AND** 范围锁定应以 `in-scope-organ-support-migrations.md` 为正式清单

#### Scenario: mixed module 允许按职责拆分
- **GIVEN** 某个文件同时包含副作用实现与纯逻辑
- **WHEN** 该文件被纳入第一批迁移
- **THEN** 系统可以按职责拆分 contract / support / logic
- **AND** 不要求整文件机械平移到某一个 support 包

### Requirement: 本次重构不得扩大到显式排除范围

系统应当（SHALL）在本次 track 中保持明确的非范围约束，避免把更大规模的环境 backend 重构混入第一批 contract/support layering 改造。

#### Scenario: LLM HTTP adapter 不在本次改造范围
- **GIVEN** `ai-organ-logic/src/llm/*` 中存在基于 `fetch` 的 provider adapter
- **WHEN** 推进本次 track
- **THEN** 系统不得要求本轮同时迁移这些 adapter
- **AND** 这些模块应保持在后续独立 track 中再处理

#### Scenario: 本地文件与进程工具实现不在本次改造范围
- **GIVEN** `Read`、`Write`、`Edit`、`Bash` 等工具当前直接操作 `fs` 或 `child_process`
- **WHEN** 推进本次 track
- **THEN** 系统不得要求本轮同时迁移这些工具实现
- **AND** 本轮应保持范围只覆盖已锁定的高确定性副作用实现

### Requirement: Runtime entry 的默认装配必须显式依赖正式 support 宿主

系统应当（SHALL）让 runtime entry 通过显式装配正式 support 宿主来获得环境能力，而不是继续从逻辑层直接拿本地文件默认实现。

#### Scenario: terminal runtime 不再直接依赖逻辑层本地文件实现
- **GIVEN** `TerminalRuntime` 当前直接消费 `createLocalFileMessageHistoryEffects`、`createLocalFileOrchestrationHistoryEffects`、`AgentLoader` 或等价本地实现
- **WHEN** 完成本次重构
- **THEN** runtime entry 应显式装配来自 `ai-support` 或 `platform-support` 的实现
- **AND** 不应继续把逻辑层中的本地实现作为默认正式 backend
