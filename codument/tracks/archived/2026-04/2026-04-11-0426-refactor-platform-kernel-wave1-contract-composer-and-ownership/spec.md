## ADDED Requirements

### Requirement: Wave 1 必须建立第一版平台执行 contract 真相源

系统应当（SHALL）在本波次中建立第一版平台执行 contract 真相源，用于承载跨领域可复用的执行平台能力，而不是继续让这些边界默认寄生在 AI-shaped contract 中。

#### Scenario: 平台 contract 只包含执行平台能力
- **GIVEN** 当前 runtime contract 中同时混有平台能力与 AI 领域语义
- **WHEN** Wave 1 完成
- **THEN** 第一版平台 contract 应明确表达 actor/fiber/mailbox、manifest/bundle/profile/bootstrap、event log/projection/replay、hook/permission/policy 等平台能力
- **AND** 不应默认把 AI 领域语义继续作为平台 contract 的一部分

#### Scenario: AI-shaped contract 有正式迁出方向
- **GIVEN** 当前 `core-contract` 仍导出多个明显 AI-shaped surface
- **WHEN** Wave 1 完成
- **THEN** 系统应明确这些 surface 的目标 ownership
- **AND** 后续 wave 不应再就其归属反复摇摆

### Requirement: Wave 1 必须将 `@cell/composer` 收口为平台级 composition contract

系统应当（SHALL）在本波次中让 `@cell/composer` 的正式 contract 表达平台级 capability composition，而不是继续直接依赖 AI-shaped assembly surface。

#### Scenario: composer contract 不再直接依赖 AI-shaped surface
- **GIVEN** 当前 `RuntimeAssemblyContext`、`RuntimeAssemblyState`、`RuntimeAssemblyResult` 仍直接依赖 `AgentConfig`、`ToolSchema` 或 AI-shaped slash surface
- **WHEN** Wave 1 完成
- **THEN** platform composer contract 应不再直接绑定这些 AI-shaped 类型
- **AND** AI domain assembly contribution 应通过单独的 domain facet 或等价边界表达

#### Scenario: composer 不产生第二套平行真相源
- **GIVEN** 当前仓库已有正式 `@cell/composer` 包
- **WHEN** Wave 1 推进
- **THEN** 系统应直接提升该包的 contract ownership
- **AND** 不应通过新建平行 composer 包引入第二套 composition truth

### Requirement: Wave 1 必须形成正式 ownership tables

系统应当（SHALL）在本波次中形成正式 ownership tables，以冻结后续 profile、shell 与包迁移的边界前提。

#### Scenario: contract ownership table 可直接指导后续迁移
- **GIVEN** 后续还将推进 profile layering、shell adoption 与 package cleanup
- **WHEN** Wave 1 完成
- **THEN** contract ownership table 应能直接指示哪些 contract 属于 platform，哪些属于 AI domain
- **AND** 后续 wave 不应再重新解释同一边界

#### Scenario: runtime facet table 明确 platform/domain 切分
- **GIVEN** 当前 `AiAgentVm` 同时承载通用执行状态与 AI 领域状态
- **WHEN** Wave 1 完成
- **THEN** runtime facet table 应明确哪些状态属于 platform facet，哪些属于 AI domain facet
- **AND** 不应只停留在口头描述

#### Scenario: package mapping table 明确当前包的新职责
- **GIVEN** 当前仓库暂不立即 rename 到 `platform-* / domain-ai-*`
- **WHEN** Wave 1 完成
- **THEN** package mapping table 应明确现有 `core-* / organ-* / composer / mod-*` 的目标职责
- **AND** 允许后续 wave 继续使用旧包名推进

### Requirement: Wave 1 的 focused verification 必须验证 ownership 而不是文件搬迁

系统应当（SHALL）使用 focused verification 验证 platform contract、composer contract 与 ownership tables 的行为边界，而不是只验证文件是否被移动。

#### Scenario: verification 验证 composer ownership
- **GIVEN** platform composer contract 已完成第一轮收口
- **WHEN** focused verification 运行
- **THEN** 它应验证 composer 不再直接依赖 AI-shaped surface
- **AND** 不应只依赖源码 grep

#### Scenario: verification 保护当前 AI runtime 连续可运行
- **GIVEN** Wave 1 仍属于增量迁移
- **WHEN** 本波次结束
- **THEN** 当前 AI runtime 主路径仍应保持可运行
- **AND** 不允许为了 contract 重构打断 terminal、tui 或 headless 主入口
