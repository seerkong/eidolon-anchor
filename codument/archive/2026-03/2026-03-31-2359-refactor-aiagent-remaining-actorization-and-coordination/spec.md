## MODIFIED Requirements

### Requirement: 正式对象模型统一为 actor 组织模型

系统 SHALL 将 AIAgent 的正式业务对象统一为 actor 体系，并以 `member / collective / formation` 作为正式组织语义。

#### Scenario: collective 与 formation 收口为真正的 fiber-backed actor
- **GIVEN** 当前 runtime 允许 `collective` / `formation` 通过 projection 暴露统一 actor 接口
- **WHEN** 本次收口完成
- **THEN** `collective` 与 `formation` SHALL 拥有自己的 mailbox、fiber 与 actor-owned state
- **AND** 系统不得再依赖仅由 projection/controller/helper 驱动的 organization 业务真相源

### Requirement: 执行语义正式切换为 `control / delegate / detached`

系统 SHALL 以 `control / delegate / detached` 作为唯一正式执行语义，并完全替换重构前命名。

#### Scenario: detached/background 执行体使用真正的 detached actor type
- **GIVEN** 当前 detached/background 主要通过 lane 与 workload 表达运行语义
- **WHEN** 本次收口完成
- **THEN** detached/background 执行体 SHALL 以 `actor.type = "detached"` 作为正式执行语义
- **AND** detached actor 的运行态与终态 SHALL 由 detached actor 自身持有
- **AND** detached registry 只能作为索引或 projection，不得作为 detached 真相源

## ADDED Requirements

### Requirement: collective actor 必须持有自己的任务板与 ownership 真相源

系统 SHALL 提供真正的 collective actor，并让 collective actor 成为 collective task board、task ownership 与完成归并的唯一真相源。

#### Scenario: collective actor 处理 assign 与成员完成回报
- **GIVEN** 用户向 collective 发起 `assign` 任务
- **WHEN** collective actor 接收任务
- **THEN** collective actor SHALL 在自己的 mailbox / actor state 中记录任务与 ownership
- **AND** collective actor SHALL 通过消息把任务分发给成员
- **AND** collective actor SHALL 通过成员回报消息完成状态归并，而不是依赖 tool 层 polling 或手工补完成

### Requirement: formation actor 必须作为 leader 路由与结果回流 actor

系统 SHALL 提供真正的 formation actor，并让它承担 leader 路由与结果回流，而不是只把 formation 当作 leader 的别名。

#### Scenario: formation actor 将任务路由到 leader 并回流给发起者
- **GIVEN** 用户向 formation 发起 `assign`
- **WHEN** formation actor 接收该任务
- **THEN** formation actor SHALL 按当前 leader 配置把任务原样路由给 leader
- **AND** leader 的总结结果或阶段事件 SHALL 先回到 formation actor
- **AND** formation actor SHALL 再依据任务关联关系把这些消息路由回原始发起者

#### Scenario: formation actor 只持有最小必要的路由状态
- **GIVEN** formation actor 负责 leader 路由与结果回流
- **WHEN** 系统维护 formation actor 状态
- **THEN** formation actor SHALL 持有 leader 指针、成员表、watch 状态与回流路由关联
- **AND** formation actor 不得被扩展为复杂 fan-out 汇总协调器

### Requirement: actor 间 coordination 必须通过每个 actor 自有 coordination mailbox 处理

系统 SHALL 将当前 `protocol` 语义收口为 `coordination`，并让每个业务 actor 通过自己的 `coordination` mailbox 处理 request/review/done 类型的控制型协作交互。

#### Scenario: coordination 采用 per-actor mailbox 而不是独立 actor
- **GIVEN** 当前存在 `plan approval`、`shutdown handshake` 等带 `request_id` 的控制型交互
- **WHEN** 本次收口完成
- **THEN** 这些交互 SHALL 进入目标 actor 自己的 `coordination` mailbox
- **AND** 系统不得引入“一请求一 coordination actor”作为正式模型

#### Scenario: coordination 状态推进不再停留在 tool 层
- **GIVEN** 当前 tool 层会同步构造 request、review、response 与 done 状态推进
- **WHEN** 本次收口完成
- **THEN** request/review/done 的状态推进 SHALL 在 actor mailbox / actor state 内部完成
- **AND** tool 层只能负责构造输入或触发动作，不得继续持有 coordination 主状态机

### Requirement: protocol 正式命名必须移除并收口为 coordination

系统 SHALL 移除 `protocol` 作为正式命名，并将相关字段、文件、目录、工具与文档统一收口为 `coordination`。

#### Scenario: 正式命名全面切换为 coordination
- **GIVEN** 项目中存在 `ProtocolEngine`、`ProtocolStatus`、`protocolRecords`、`protocol` 目录等正式命名
- **WHEN** 本次收口完成
- **THEN** 这些正式命名 SHALL 统一切换为 `Coordination*`、`coordinationRecords` 与 `coordination/`
- **AND** 旧 `protocol` 正式命名不得继续作为公开接口或正式文档真相源存在

### Requirement: runtime bridge 不得继续承担 collective/background 的业务推进责任

系统 SHALL 让 business progression 回到 actor/fiber，而不是继续由 terminal runtime 的外挂 pump/controller 驱动。

#### Scenario: TerminalRuntime 退化为 I/O bridge
- **GIVEN** 当前 `TerminalRuntime` 仍会通过 queue、background pump、deferred resume 等机制承担部分业务推进
- **WHEN** 本次收口完成
- **THEN** `TerminalRuntime` SHALL 主要负责输入输出桥接与 orchestrator bridge
- **AND** collective/background 的业务循环 SHALL 由 actor 自己的 mailbox/fiber 推进

## NON-FUNCTIONAL Requirements

### Requirement: actor ownership 必须成为唯一真相源

系统 SHALL 让业务状态优先归属于 actor，而不是长期停留在 sessionState、registry、manager 或 runtime bridge 中。

#### Scenario: registry 与 manager 退化为索引、factory 或 projection
- **GIVEN** 当前仍有 `OrganizationManager`、`DetachedActorRegistry`、`ProtocolEngine` 等 helper 承担部分业务真相源
- **WHEN** 本次收口完成
- **THEN** 这些对象 SHALL 退化为 factory、索引、projection 或 parser/reducer helper
- **AND** 不得继续作为 detached / collective / formation / coordination 的长期业务真相源
