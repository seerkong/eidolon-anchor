## MODIFIED Requirements

### Requirement: actor ownership 必须成为唯一真相源

系统 SHALL 让业务状态优先归属于 actor，而不是长期停留在 cache、projection、manager、registry 或 runtime bridge 中。

#### Scenario: coordination cache 不再伪装成 live actor-owned state
- **GIVEN** 某个 `coordination` request 已不再有 actor owner，也不在任何 pending mailbox 中
- **WHEN** 系统查询该 request 的状态
- **THEN** 系统 SHALL 不把纯 cache/store-only record 作为默认 live truth 返回
- **AND** 若仍暴露兼容或诊断信息，必须显式表明它不是当前 actor-owned live state

### Requirement: 正式对象模型统一为 actor 组织模型

系统 SHALL 将 AIAgent 的正式业务对象统一为 actor 体系，并以 `member / collective / formation` 作为正式组织语义。

#### Scenario: organization 查询优先返回真实 actor
- **GIVEN** `collective` 或 `formation` 已经拥有真实 actor、fiber 与 actor-owned state
- **WHEN** 系统执行 actor target 解析、status 查询、watch/unwatch 或相关 typed wrapper 查询
- **THEN** 系统 SHALL 优先返回真实 organization actor
- **AND** synthetic projection 只能停留在显式 degraded 或兼容路径，不得继续作为默认正式 subject

## ADDED Requirements

### Requirement: vendor 文档与 runtime prompt 必须与当前正式 surface 对齐

系统 SHALL 让 vendor actor 指南、runtime prompt 与当前正式 mailbox、assign surface 和 coordination 术语保持一致。

#### Scenario: vendor actor 指南补齐 coordination mailbox
- **GIVEN** 当前业务 actor 已正式拥有 `coordination` mailbox
- **WHEN** 系统维护 vendor `depa-actor` 的 AI agent 指南
- **THEN** 文档 SHALL 把 `coordination` 纳入正式 mailbox 清单与职责说明
- **AND** 不得继续遗漏当前正式控制型协作语义

#### Scenario: runtime prompt 与帮助文案保留正式 assign surface
- **GIVEN** 当前正式命令面保留 `assign`、`assign:r`、`assign:n`、`assign:s`
- **AND** formal tool mode 仍统一映射为 `final | none | stream`
- **WHEN** 系统生成 runtime system prompt 或帮助文案
- **THEN** 文案 SHALL 只使用与当前正式 surface 一致的 assign 表达
- **AND** 必须明确 `assign:r` 是正式的显式 final 写法，而不是待删除旧写法

## NON-FUNCTIONAL Requirements

### Requirement: residual cleanup 必须有 focused regression tests

系统 SHALL 为 coordination fallback、organization actor query 与术语对齐补 focused tests，避免 residual cleanup 未来回退。

#### Scenario: owner 丢失与 store-only coordination 路径可被明确断言
- **GIVEN** 运行时中存在只剩 cache/store 的 coordination record
- **WHEN** 测试查询状态或尝试继续 review
- **THEN** 测试 SHALL 能明确断言其是 degraded/diagnostic 状态，而不是 actor-owned live truth

#### Scenario: organization query 不再默认回落为 synthetic projection
- **GIVEN** runtime 中已存在真实 `collective` / `formation` actor
- **WHEN** 测试执行 target 解析和 status 查询
- **THEN** 测试 SHALL 断言正式路径优先命中真实 actor，而不是 `type: null` 的 synthetic subject

#### Scenario: runtime prompt、help 与 parser 对 `assign:r` 一致可见
- **GIVEN** `assign:r` 是当前正式命令面的一部分
- **WHEN** 测试检查 runtime prompt、slash help 与 slash parser
- **THEN** 测试 SHALL 断言三者对 `assign:r` 的可见性与语义一致
