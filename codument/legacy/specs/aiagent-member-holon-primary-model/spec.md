## ADDED Requirements

### Requirement: 正式对象模型统一为 `member / holon`
系统 SHALL 将 AIAgent 的正式组织对象模型统一为 `member / holon`。

#### Scenario: 用 holon 取代旧组织类型
- **GIVEN** 系统历史上使用 `collective` 与 `formation` 作为一级正式组织类型
- **WHEN** 当前正式模型生效
- **THEN** 对外正式组织类型 SHALL 只保留 `member` 与 `holon`
- **AND** `collective` 与 `formation` SHALL 不再作为正式组织 kind 出现在正式命令面、正式工具族、正式文档与正式 contract 中

#### Scenario: holon 继续作为可寻址 actor 暴露
- **GIVEN** 用户通过正式命令或正式 tool surface 寻址一个组织对象
- **WHEN** runtime 解析目标
- **THEN** 系统 SHALL 将该对象暴露为可寻址的 `holon` actor
- **AND** SHALL 通过统一 actor 接口提供 `assign`、`status`、`watch`、`unwatch` 等正式能力

### Requirement: holon 的治理差异通过 `governance` 表达
系统 SHALL 使用 `holon.governance` 表达组织治理差异。

#### Scenario: autonomous holon 对应无 leader 组织
- **GIVEN** 某个 holon 采用自主决策、成员领取或任务板分发模型
- **WHEN** runtime 创建、恢复或展示该对象
- **THEN** 系统 SHALL 使用 `identity.kind = "holon"`
- **AND** SHALL 使用 `identity.governance = "autonomous"`

#### Scenario: leader_led holon 对应 leader 路由组织
- **GIVEN** 某个 holon 采用 leader 路由、结果回流模型
- **WHEN** runtime 创建、恢复或展示该对象
- **THEN** 系统 SHALL 使用 `identity.kind = "holon"`
- **AND** SHALL 使用 `identity.governance = "leader_led"`

#### Scenario: 组织语义与执行语义保持正交
- **GIVEN** 系统同时存在组织语义与执行语义两条 actor 维度
- **WHEN** runtime 创建或恢复 actor
- **THEN** `member / holon` SHALL 只通过 `identity.kind` 表达组织语义
- **AND** `governance` SHALL 只存在于 `holon`
- **AND** `primary / delegate / detached` SHALL 只通过 `actor.type` 表达执行语义

### Requirement: 执行语义正式切换为 `primary / delegate / detached`
系统 SHALL 以 `primary / delegate / detached` 作为唯一正式执行语义。

#### Scenario: primary 替换 control
- **GIVEN** 系统历史上使用 `control` 表达主会话执行体
- **WHEN** 当前正式模型生效
- **THEN** 系统 SHALL 使用 `primary` 作为正式命名
- **AND** `control` SHALL 不再作为正式执行 type 出现在正式 contract、正式文档与正式 tool surface 中

#### Scenario: delegate 与 detached 保持执行分工
- **GIVEN** 系统已使用 `delegate` 与 `detached`
- **WHEN** 当前正式模型生效
- **THEN** `delegate` SHALL 表示短生命周期协作执行体
- **AND** `detached` SHALL 表示脱离当前交互回合、可独立推进的执行体

### Requirement: 任务派发统一为 `assign`
系统 SHALL 以 `assign` 作为唯一正式派发动词，适用于 `member` 与 `holon`。

#### Scenario: member 与 holon 使用同一派发动词
- **GIVEN** 用户要向 `member` 或 `holon` 派发任务
- **WHEN** 用户使用正式命令面或正式 tool surface
- **THEN** 系统 SHALL 使用 `assign` 作为唯一正式派发动词
- **AND** SHALL 支持 `assign`、`assign:r`、`assign:n`、`assign:s`

#### Scenario: assign:s 自动进入 watched 状态
- **GIVEN** 用户执行 `assign:s`
- **WHEN** 目标 actor 开始执行任务
- **THEN** 系统 SHALL 输出流式事件
- **AND** 目标对象 SHALL 进入 `watched` 状态

### Requirement: watch / unwatch 统一控制持续监听
系统 SHALL 使用 `watch / unwatch` 作为唯一正式对象级持续监听接口。

#### Scenario: watch / unwatch 不控制任务生命周期
- **GIVEN** 某个 actor 已经在工作或空闲
- **WHEN** 用户执行 `watch` 或 `unwatch`
- **THEN** 系统 SHALL 只改变对象级持续监听状态
- **AND** SHALL 不将 `unwatch` 解释为 cancel、shutdown、interrupt 或任务回滚

### Requirement: 正式命令面统一为 `/actor`、`/member`、`/holon`
系统 SHALL 将正式命令面统一收口到 `/actor`、`/member`、`/holon`。

#### Scenario: 只保留新的一级命令面
- **GIVEN** 系统历史上存在 `/collective` 与 `/formation`
- **WHEN** 当前正式模型生效
- **THEN** 正式一级命令面 SHALL 只保留 `/actor`、`/member`、`/holon`
- **AND** `/collective` 与 `/formation` 如保留，也只能作为 deprecated parser alias

#### Scenario: holon create 显式接收 governance
- **GIVEN** 用户需要创建组织对象
- **WHEN** 用户使用正式命令面
- **THEN** 系统 SHALL 支持 `/holon create <governance> <name>`
- **AND** `<governance>` SHALL 只允许 `autonomous | leader_led`

#### Scenario: holon appoint 只适用于 leader_led
- **GIVEN** 用户使用 `/holon appoint`
- **WHEN** 目标 holon 的 `governance` 不是 `leader_led`
- **THEN** 系统 SHALL fail-fast
- **AND** SHALL 返回明确的治理不匹配错误

### Requirement: 正式组织工具族统一为 `Holon*`
系统 SHALL 以 `Holon*` 作为唯一正式组织工具族。

#### Scenario: 正式组织工具族映射到 holon 命令面
- **GIVEN** 用户通过底层 tool surface 操作组织对象
- **WHEN** 当前正式模型生效
- **THEN** 系统 SHALL 提供 `HolonCreate`、`HolonAdd`、`HolonAppoint`、`HolonStatus`、`HolonAssign`
- **AND** `Collective*` 与 `Formation*` SHALL 不再作为默认正式 tool family 暴露

#### Scenario: builtin registry 只保留 holon-first 组织工具族
- **GIVEN** runtime 构建 builtin tool registry
- **WHEN** 当前正式模型生效
- **THEN** builtin registry SHALL 只注册 `Holon*` 作为组织工具族
- **AND** `includeInternalOnly: true` 也 SHALL NOT 恢复 `Collective* / Formation*`

### Requirement: slash 自由文本分隔符统一为 `--`
系统 SHALL 使用 `--` 作为 slash 命令中结构化参数与自由文本的正式分隔符。

#### Scenario: create 与 assign 使用 -- 分隔自由文本
- **GIVEN** 用户通过 slash 命令传递 prompt 或 task content
- **WHEN** 用户使用正式命令面
- **THEN** 系统 SHALL 使用 `--` 作为唯一正式分隔符
- **AND** `--` 后的全部文本 SHALL 被视为 prompt 或 content

### Requirement: autonomous holon 必须持有自己的任务板与 ownership 真相源
系统 SHALL 提供真正的 autonomous holon actor，并让其持有任务板、ownership 与完成归并的唯一真相源。

#### Scenario: autonomous holon 处理 assign 与成员完成回报
- **GIVEN** 用户向一个 `autonomous` holon 发起 `assign`
- **WHEN** holon actor 接收任务
- **THEN** holon actor SHALL 在自己的 mailbox 与 actor-owned state 中记录任务与 ownership
- **AND** holon actor SHALL 通过消息将任务分发给成员
- **AND** holon actor SHALL 通过成员回报消息完成状态归并，而不是依赖 tool 层 polling 或手工补完成

### Requirement: leader_led holon 必须作为 leader 路由与结果回流 actor
系统 SHALL 提供真正的 leader-led holon actor，并让其承担 leader 路由与结果回流。

#### Scenario: leader_led holon 将任务路由到 leader 并回流给发起者
- **GIVEN** 用户向一个 `leader_led` holon 发起 `assign`
- **WHEN** holon actor 接收该任务
- **THEN** holon actor SHALL 按当前 leader 配置将任务路由给 leader
- **AND** leader 的阶段事件或最终结果 SHALL 先回到该 holon actor
- **AND** 该 holon actor SHALL 再依据任务关联关系将这些消息回流给原始发起者

### Requirement: coordination 必须通过每个 actor 自有 coordination mailbox 处理
系统 SHALL 将控制型协作交互收口为 `coordination`，并通过每个业务 actor 自有的 `coordination` mailbox 处理。

#### Scenario: coordination 采用 per-actor mailbox
- **GIVEN** 系统存在 plan review、shutdown handshake 等带 `request_id` 的控制型交互
- **WHEN** 当前正式模型生效
- **THEN** 这些交互 SHALL 进入目标 actor 自己的 `coordination` mailbox
- **AND** 系统不得引入“一请求一 coordination actor”作为正式模型

### Requirement: actor ownership 必须成为唯一真相源
系统 SHALL 让业务状态优先归属于 actor，而不是长期停留在 sessionState、registry、manager 或 runtime bridge 中。

#### Scenario: manager 与 registry 退化为 factory、索引或 projection
- **GIVEN** 系统仍有 `OrganizationManager`、detached registry、coordination helper 等对象
- **WHEN** 当前正式模型生效
- **THEN** 这些对象 SHALL 退化为 factory、索引、projection 或 parser/reducer helper
- **AND** 不得继续作为 `holon`、`detached` 或 `coordination` 的长期业务真相源

### Requirement: runtime truth 与 persistence 必须同步正名
系统 SHALL 将运行时真相源与持久化结构同步切换到新命名。

#### Scenario: actor key 与 actor-owned state 收口到 holon
- **GIVEN** 系统历史上使用 `collective:<id>` / `formation:<id>` 与 `collectiveState` / `formationState`
- **WHEN** 当前正式模型生效
- **THEN** runtime SHALL 将正式组织 actor key 收口为 `holon:<id>`
- **AND** SHALL 将 actor-owned organization state 收口为统一的 `holonState`

#### Scenario: sessionState 与 snapshot 不再保留旧正式字段
- **GIVEN** 系统历史上在 VM 与 snapshot 中使用 `collectives` / `formations`
- **WHEN** 当前正式模型生效
- **THEN** 正式 sessionState 与 snapshot 结构 SHALL 收口为 `holons`
- **AND** 旧正式字段 SHALL 不再继续作为新模型正式结构存在

#### Scenario: governance-specific runtime record 使用 holon-first type names
- **GIVEN** runtime session store 已统一为 `sessionState.holons`
- **WHEN** 当前正式模型生效
- **THEN** governance-specific runtime record SHALL 使用 `VmAutonomousHolonRecord` 与 `VmLeaderLedHolonRecord`
- **AND** `VmCollectiveRecord / VmFormationRecord` SHALL NOT 继续作为当前正式类型名

#### Scenario: holon identity state 与 envelope payload 统一使用 holonId
- **GIVEN** holon actor identity、holonState 与 envelope payload 会进入 runtime、snapshot 与 protocol
- **WHEN** 当前正式模型生效
- **THEN** 这些结构 SHALL 统一使用 `holonId`
- **AND** `collectiveId / formationId` SHALL NOT 继续作为当前正式字段真相

#### Scenario: leader-led holon route protocol 使用 holon-first tag
- **GIVEN** leader-led holon 仍通过 envelope protocol 执行 route/backflow
- **WHEN** 当前正式模型生效
- **THEN** payload SHALL 使用 `holonId`
- **AND** route tag SHALL 使用 `<leader_led_holon_route>`
- **AND** `<formation_route>` SHALL NOT 继续作为当前正式 protocol tag

### Requirement: holon runtime protocol 与 event API 必须使用治理显式命名
系统 SHALL 让 holon 的 scheduler/workload/scope marker 与 runtime event API 使用治理显式、holon-first 的正式命名。

#### Scenario: autonomous holon lane 与 workload 使用正式治理命名
- **GIVEN** autonomous holon 相关成员 lane 与 fiber workload 会进入调度、snapshot 与投影视图
- **WHEN** 当前正式模型生效
- **THEN** 系统 SHALL 使用 `autonomous_holon` 作为正式 lane
- **AND** SHALL 使用 `autonomous_holon_task` 作为正式 workload
- **AND** `collective` 与 `collective_task` SHALL NOT 继续作为当前正式 runtime protocol 真相

#### Scenario: task-tree holon scope marker 使用 governance-explicit 语义
- **GIVEN** task-tree activeForm 需要表达 holon 任务归属
- **WHEN** 当前正式模型生效
- **THEN** autonomous holon SHALL 使用 `holon:autonomous:<id>`
- **AND** leader-led holon SHALL 使用 `holon:leader_led:<id>`
- **AND** 旧组织前缀 SHALL NOT 继续作为当前正式 scope marker

#### Scenario: runtime event API 只暴露 holon-first 名称
- **GIVEN** runtime 需要发出 autonomous holon claim 与 idle-exit 事件
- **WHEN** 当前正式模型生效
- **THEN** 系统 SHALL 使用 `emitAutonomousHolonClaim` 与 `emitAutonomousHolonIdleExit`
- **AND** 旧 event alias SHALL NOT 继续作为当前正式 runtime API 暴露

### Requirement: 旧 session 与旧 snapshot 不保证兼容恢复
系统 SHALL 明确将旧命名下的恢复兼容排除在当前正式运行时范围之外。

#### Scenario: 旧数据恢复不被当前模型直接承诺
- **GIVEN** 存在按 `collective / formation / control` 命名持久化的旧 session 或 snapshot
- **WHEN** 当前模型尝试读取这些数据
- **THEN** 系统 SHALL 不承诺兼容恢复
- **AND** 如需兼容，必须通过明确迁移器处理，而不是通过 runtime 双字段双命名长期保留

### Requirement: 正式文档与示例必须使用 `member / holon / primary`
系统 SHALL 重写 AIAgent 相关正式文档、示例与测试基线，使其与当前命名一致。

#### Scenario: 正式文档不再使用旧对象模型作为当前真相
- **GIVEN** 项目内存在 howto、architecture、spec、vendor AI-agent 说明与测试基线
- **WHEN** 当前正式模型生效
- **THEN** 正式文档 SHALL 统一使用 `member / holon / primary`
- **AND** 旧命名如需出现，只能作为迁移说明或历史背景
