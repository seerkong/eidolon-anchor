## ADDED Requirements

### Requirement: 平台微内核必须只承载跨领域可复用的执行平台能力

系统应当（SHALL）把 actor/fiber/mailbox、event log/projection、manifest composition、profile/bootstrap、hook、permission、diagnostics、persistence ports 等跨领域可复用能力定义为平台微内核，而不是继续混放在 AI 领域 runtime 中。

#### Scenario: 平台内核不再绑定 AI 专属语义
- **GIVEN** 某个 runtime contract 或 logic 只表达调度、状态、组合或观测能力
- **WHEN** 该能力被纳入平台微内核
- **THEN** 它不应依赖 AI 专属名词如 agent、tool-call、member、holon 或 provider adapter
- **AND** 它应能被未来非 AI 领域 runtime 复用

#### Scenario: vendor 原语成为平台内核基础
- **GIVEN** 当前仓库已经存在 `depa-actor`、`depa-processor`、`depa-data-graph`
- **WHEN** 设计平台微内核
- **THEN** actor/fiber、manifest/bundle、timeline/projection 等能力应优先建立在这些 vendor 原语之上
- **AND** 不应平行再造第二套同类基础设施

### Requirement: AI 领域微内核必须保留 AI 语义而不是被错误抽空

系统应当（SHALL）将 provider/model runtime、tool calling、questionnaire、semantic event taxonomy、teammate/holon/member 协作语义等能力保留在 AI 领域微内核，而不是为追求“通用”而错误上移到平台内核。

#### Scenario: AI 领域能力留在 domain-ai 层
- **GIVEN** 某个能力直接依赖 LLM、tool call、AI 协作身份或 AI semantic event
- **WHEN** 设计新的内核分层
- **THEN** 它应位于 AI 领域微内核
- **AND** 不应被包装成空泛的平台抽象

#### Scenario: 平台内核不强行拥有 AI capability taxonomy
- **GIVEN** 当前 capability 里已有 agent、tool、provider、slash namespace 等 AI shaped surface
- **WHEN** 进行微内核升级
- **THEN** 平台层可以只定义更通用的 capability port / registry contract
- **AND** AI 专属 capability kind 应由 AI 领域层定义或扩展

### Requirement: profile 组装必须支持平台基线、领域基线与应用 overlay 叠加

系统应当（SHALL）支持通过正式 profile 将平台 kernel baseline、AI domain kernel baseline 与 AI app overlay 分层叠加，而不是继续由 runtime entry 手工拼装默认产品语义。

#### Scenario: profile 以平台基线为起点
- **GIVEN** runtime 需要启动一个 AI 应用
- **WHEN** 它通过 profile 装配
- **THEN** 组装顺序应先建立平台 kernel baseline
- **AND** 再叠加 AI domain kernel
- **AND** 最后叠加具体 app overlay

#### Scenario: 未来新领域可在平台基线上独立装配
- **GIVEN** 未来存在一个非 AI 领域 runtime
- **WHEN** 它复用平台微内核
- **THEN** 它应能在不依赖 AI domain kernel 的情况下装配自己的领域内核和应用 overlay
- **AND** 不应被迫引入 AI provider、tool 或 teammate 语义

### Requirement: shell 与 runtime entry 必须只消费装配结果与 capability ports

系统应当（SHALL）让 terminal、tui、其他 shell/runtime entry 仅通过装配结果与 capability ports 使用默认能力，而不是继续持有领域默认定义或直接 import 某个默认实现。

#### Scenario: shell 不再成为默认产品定义宿主
- **GIVEN** shell 负责输入输出桥接、projection 与 lifecycle
- **WHEN** 检查默认 runtime product semantics 的来源
- **THEN** shell 应只消费正式 assembly result 与 capability ports
- **AND** 不应继续成为默认 AI 产品语义的真相源

#### Scenario: capability 缺失时 contract 语义明确
- **GIVEN** 某个 runtime 未加载某个领域或应用 overlay
- **WHEN** shell 或 framework 尝试消费该能力
- **THEN** 系统应按 contract 返回 empty、unavailable、no-op 或显式错误
- **AND** 不应因隐式 import 某个默认实现而产生 silent fallback

### Requirement: 迁移路径必须允许在现有 AI runtime 上分阶段落地

系统应当（SHALL）提供增量迁移方案，使当前 AI runtime 能在保持可运行和可测试的前提下逐步迁移到新架构。

#### Scenario: 先拆平台边界，再迁移领域实现
- **GIVEN** 当前 `cell` 与 `terminal` 已有正式运行时入口
- **WHEN** 推进微内核重构
- **THEN** 应先冻结边界与 contract
- **AND** 再逐步迁移 assembly、runtime state、support implementation 与 shell adoption
- **AND** 不要求一轮重构完成全部 cutover

#### Scenario: focused tests 验证边界而不是只验证文件搬迁
- **GIVEN** 微内核升级会引入 package 迁移与装配重排
- **WHEN** 验证迁移结果
- **THEN** tests 应验证 ownership、profile 顺序、capability 消费与 runtime 行为
- **AND** 不应只依赖源码 grep 或文件位置变化

### Requirement: 架构设计必须明确反模式与非目标

系统应当（SHALL）明确记录哪些做法属于反模式，以避免“通用微内核”演化为空洞抽象层。

#### Scenario: 拒绝空泛的万能 capability 抽象
- **GIVEN** 某个抽象没有明确的跨领域复用证据
- **WHEN** 评估是否纳入平台微内核
- **THEN** 系统不得仅因“未来可能复用”而把该抽象上收
- **AND** 仍应优先保留在当前领域层

#### Scenario: 拒绝复制第二套基础设施
- **GIVEN** vendor 层已经具备 actor、dispatch、projection 基础设施
- **WHEN** 设计新的微内核
- **THEN** 新设计不得平行复制同类底层机制
- **AND** 应优先在现有 vendor 原语上定义更高层 contract
