# 规范：AIAgent 统一切换到 `member / collective / formation` actor 模型

## 概述

本 track 要对整个 AIAgent 项目进行彻底的 breaking change 重构，将重构前分裂的业务心智模型统一替换为新的 actor 模型与命令体系。

新模型要求：

- 对外正式对象统一为 actor
- 组织语义统一为 `member / collective / formation`
- 任务派发统一为 `assign / assign:r / assign:n / assign:s`
- 监听控制统一为 `watch / unwatch`
- 不兼容旧命令、旧 tool、旧变量命名、旧文档命名和旧数据恢复行为

本 track 同时覆盖：

- AIAgent runtime
- terminal / TUI / minimal 命令与交互
- tools / persistence / tests / docs
- vendor `depa-actor` 中面向 AI agent 的说明文档、示例与模拟测试

## ADDED Requirements

### Requirement: 正式对象模型统一为 actor 组织模型

系统 SHALL 将 AIAgent 的正式业务对象统一为 actor 体系，并以 `member / collective / formation` 作为正式组织语义。

#### Scenario: 用新对象模型替换重构前组织模型
- **GIVEN** 项目中存在重构前组织概念与命名
- **WHEN** 本 track 完成后
- **THEN** 对外正式模型 SHALL 只保留 `member`、`collective`、`formation`
- **AND** 这些对象 SHALL 都被视为可寻址 actor
- **AND** 旧组织模型 SHALL 不再作为正式业务名词存在

#### Scenario: organization actor 允许通过 projection 暴露统一 actor 接口
- **GIVEN** 当前 runtime 中 `collective` / `formation` 未必各自注册为独立 fiber-backed actor
- **WHEN** 用户通过正式命令或正式 tool surface 寻址这些对象
- **THEN** 系统 SHALL 仍将它们作为 actor-addressable target 暴露
- **AND** SHALL 通过统一的 actor-like projection 提供 `assign`、`status`、`watch`、`unwatch` 等正式接口
- **AND** 文档与实现 SHALL 明确这是 organization actor projection，而不是隐含承诺“每个 organization 都已是独立 runtime actor fiber”

#### Scenario: 组织类型语义明确分离
- **GIVEN** 系统存在多个可嵌套的组织 actor
- **WHEN** 用户或代码查询对象语义
- **THEN** `member` SHALL 表示单个成员 actor
- **AND** `collective` SHALL 表示无 leader 的自治组织 actor
- **AND** `formation` SHALL 表示有 leader 的组织 actor

#### Scenario: 组织语义与执行语义保持正交
- **GIVEN** 系统同时存在组织语义与执行语义两条 actor 维度
- **WHEN** runtime 创建或恢复 actor
- **THEN** `member / collective / formation` SHALL 只通过 `identity.kind` 表达组织语义
- **AND** `control / delegate / detached` SHALL 只通过 `actor.type` 表达执行语义
- **AND** 系统 SHALL 不把 `member` 作为新的执行 type

### Requirement: 执行语义正式切换为 `control / delegate / detached`

系统 SHALL 以 `control / delegate / detached` 作为唯一正式执行语义，并完全替换重构前命名。

#### Scenario: 替换重构前执行语义名称
- **GIVEN** 系统当前对主控、子级执行体、后台执行体使用重构前命名
- **WHEN** 本 track 完成后
- **THEN** 项目 SHALL 使用以下新的正式命名来表达这些概念：
  - 主控执行体 -> `control actor`
  - 派生执行体 -> `delegate actor`
  - 脱离前台回合的执行体 -> `detached actor`
- **AND** 新命名 SHALL 与 `member / collective / formation` 的 actor 心智模型一致
- **AND** 旧命名 SHALL 不再出现在正式命令、正式文档、正式工具名和正式变量命名中

#### Scenario: delegate 执行 helper 的正式工具名同步正名
- **GIVEN** 系统存在重构前执行 helper 名称
- **WHEN** 本 track 完成后
- **THEN** 系统 SHALL 使用 `RunDelegateActor` 作为该执行 helper 的正式工具名
- **AND** 重构前 helper 名称 SHALL 不再作为正式工具名、正式提示词或正式文档入口存在

#### Scenario: 后台执行体提升为 actor
- **GIVEN** 系统存在重构前后台执行语义
- **WHEN** 新模型生效
- **THEN** 后台执行体 SHALL 被建模为 actor
- **AND** 它 SHALL 使用统一的 actor 派发、状态和事件协议

#### Scenario: member 不再复用 control type
- **GIVEN** 系统创建常规 member actor
- **WHEN** member 被加入 runtime roster 并参与编排
- **THEN** 该 actor SHALL 使用 `identity.kind = "member"`
- **AND** 该 actor SHALL 使用 `actor.type = "delegate"` 表达其执行语义
- **AND** 只有当前 session root/control actor 才可使用 `actor.type = "control"`

#### Scenario: 后台化 member 保持组织身份但切换执行 type
- **GIVEN** 一个 member 以后台方式继续运行
- **WHEN** 系统将其从前台编排链路切换到后台执行
- **THEN** 该 actor SHALL 保持 `identity.kind = "member"`
- **AND** 该 actor SHALL 使用 `actor.type = "detached"`

### Requirement: 任务派发统一为 assign 协议

系统 SHALL 以 `assign` 作为唯一正式任务派发动词，适用于所有 actor 目标。

#### Scenario: member / collective / formation 使用同一派发动词
- **GIVEN** 用户要向 `member`、`collective` 或 `formation` 派发任务
- **WHEN** 用户使用正式命令面
- **THEN** 系统 SHALL 使用 `assign` 作为唯一正式派发动词
- **AND** SHALL 不再保留 `send`、`call`、`stream`、`dispatch`、`broadcast` 等旧的正式派发命令词

#### Scenario: assign 支持四种正式写法
- **GIVEN** 用户需要不同的回传行为
- **WHEN** 用户执行任务派发
- **THEN** 系统 SHALL 支持：
  - `assign` 表示默认的 request/response 最终结果回传
  - `assign:r` 表示显式的 request/response 最终结果回传
  - `assign:n` 表示单向投递不回传
  - `assign:s` 表示流式回传

### Requirement: watch / unwatch 统一监听控制

系统 SHALL 使用 `watch / unwatch` 作为唯一正式的对象级持续监听控制接口。

#### Scenario: assign:s 自动进入 watched 状态
- **GIVEN** 用户执行 `assign:s`
- **WHEN** 目标 actor 开始执行任务
- **THEN** 系统 SHALL 输出当前任务的流式事件
- **AND** 在任务结束后 SHALL 让目标保持 watched 状态
- **AND** 直到用户显式执行 `unwatch` 前，系统 SHALL 持续推送该目标的后续事件

#### Scenario: watch / unwatch 不控制任务生命周期
- **GIVEN** 某个 actor 已经在工作或空闲
- **WHEN** 用户执行 `watch` 或 `unwatch`
- **THEN** 系统 SHALL 只改变对象级持续监听状态
- **AND** SHALL 不将 `unwatch` 解释为 cancel、shutdown、interrupt 或任务回滚

### Requirement: 正式命令面统一切换

系统 SHALL 将命令面统一到新的一级命令与子命令体系，并移除旧命令的正式地位。

#### Scenario: 只保留新的一级命令面
- **GIVEN** terminal / TUI / minimal 存在旧命令入口
- **WHEN** 本 track 完成后
- **THEN** 系统 SHALL 只保留新的正式一级命令：
  - `/actor`
  - `/member`
  - `/collective`
  - `/formation`
- **AND** 已删除命令空间 SHALL 不再作为正式命令面

#### Scenario: 结构管理动词统一
- **GIVEN** 用户需要创建对象、加入组织、任命 leader、查看状态
- **WHEN** 用户使用正式命令
- **THEN** 系统 SHALL 统一使用：
  - `create`
  - `list`
  - `status`
  - `add`
  - `appoint`
  - `assign`
  - `watch`
  - `unwatch`

### Requirement: 底层 tool surface 必须跟随正式命令设计

系统 SHALL 以 command-aligned lower-level tool surface 作为唯一正式 tool 层，不得继续以重构前工具族作为公开真相源。

#### Scenario: 正式 tool 家族直接映射到正式命令设计
- **GIVEN** 正式命令面只保留 `/actor`、`/member`、`/collective`、`/formation`
- **WHEN** 系统设计或实现底层 tool surface
- **THEN** 正式 tool 家族 SHALL 至少包括：
  - `ActorAssign`、`ActorStatus`、`ActorWatch`、`ActorUnwatch`
  - `MemberCreate`、`MemberList`、`MemberStatus`、`MemberAssign`
  - `CollectiveCreate`、`CollectiveAdd`、`CollectiveAssign`、`CollectiveStatus`
  - `FormationCreate`、`FormationAdd`、`FormationAppoint`、`FormationAssign`、`FormationStatus`
- **AND** actor 状态查询 SHALL 以 `ActorStatus` 作为统一真相源，而不是为每个组织对象保留一套旧状态 API 体系

#### Scenario: member 可通过 typed status wrapper 查询状态
- **GIVEN** 用户已经知道目标是一个 `member`
- **WHEN** 用户使用正式命令面或正式 tool surface 查询该成员状态
- **THEN** 系统 SHALL 支持 `/member status <member_ref>` 与 `MemberStatus`
- **AND** `MemberStatus` SHALL 被视为 `ActorStatus(target=member:...)` 的 typed wrapper
- **AND** 它 SHALL 返回 member 维度的稳定字段投影，而不是重构前字段风格输出

#### Scenario: collective 自治能力内化而不是暴露重构前独立工具家族
- **GIVEN** `collective` 表示无 leader 的自治组织 actor
- **WHEN** 系统提供 collective 相关底层工具
- **THEN** collective 的任务板、任务领取、调度推进 SHALL 被视为 collective 内部能力
- **AND** 系统 SHALL 不再把重构前独立调度工具暴露成正式公开 tool 家族

#### Scenario: 重构前 tool API 被删除而不是改名保留
- **GIVEN** 项目中存在重构前公开工具族
- **WHEN** 本 track 完成后
- **THEN** 这些旧 tool API SHALL 被删除
- **AND** 系统 SHALL 不把它们保留为 alias、rename wrapper 或兼容入口
- **AND** 如需迁移提示，SHALL 通过文档或 fail-fast 错误文案给出，而不是保留运行时兼容行为

### Requirement: 工具、变量、持久化与内部实现同步正名

系统 SHALL 将内部实现层统一切换到新心智模型，不保留旧业务命名作为正式实现名。

#### Scenario: tools 与 runtime 命名统一重写
- **GIVEN** 项目中存在以旧概念命名的 tools、runtime 类型、metadata keys、目录名和测试名
- **WHEN** 本 track 完成后
- **THEN** 这些实现 SHALL 统一改为新模型命名
- **AND** 旧命名 SHALL 不再作为正式实现接口存在

#### Scenario: 内部实现不保留旧概念兼容层
- **GIVEN** breaking change 已被用户确认
- **WHEN** 完成重构
- **THEN** 系统 SHALL 不为了兼容旧行为保留 alias、双字段、双命名或旧协议分支

### Requirement: 旧会话与旧持久化数据不兼容恢复

系统 SHALL 明确将旧数据恢复排除在本次改造后的运行时兼容范围之外。

#### Scenario: 旧 session 或 snapshot 不被新模型直接恢复
- **GIVEN** 存在按旧模型持久化的 session、runtime snapshot、derived indexes 或相关恢复数据
- **WHEN** 新模型版本尝试读取这些数据
- **THEN** 系统 SHALL 不承诺兼容恢复
- **AND** SHALL 要求用户新建会话或放弃旧恢复数据

### Requirement: 文档必须全面切换到新心智模型

系统 SHALL 重写 AIAgent 相关文档，使正式文档只使用新模型与新命令面。

#### Scenario: AIAgent 文档不再使用旧概念作为正式说明
- **GIVEN** 项目内存在大量 AIAgent howto、architecture、module 文档
- **WHEN** 本 track 完成后
- **THEN** 正式文档 SHALL 统一使用新对象模型、命令系统和关系说明
- **AND** 旧概念如需出现，只能作为历史背景或迁移说明

### Requirement: vendor/depa-actor 的 AI agent 文档与示例同步重写

系统 SHALL 同步重写 vendor `depa-actor` 中面向 AI agent 的说明文档、示例和模拟测试，使其与新的 AIAgent 设计一致。

#### Scenario: 重写 ACTOR-FOR-AI-AGENTS 文档
- **GIVEN** `vendor/depa-actor/ACTOR-FOR-AI-AGENTS.md` 使用旧概念解释 AI agent actor 化
- **WHEN** 本 track 完成后
- **THEN** 文档 SHALL 改为使用新的 actor、`member / collective / formation`、`assign`、`watch / unwatch` 心智模型
- **AND** 文档中的概念关系、术语和示例 SHALL 与 AIAgent 正式规范一致

#### Scenario: vendor 示例与模拟测试体现新设计
- **GIVEN** vendor 目录下存在示例、说明或测试代码
- **WHEN** 本 track 完成后
- **THEN** 系统 SHALL 提供至少一套最小但完整的 AI agent 示例与模拟测试
- **AND** 该示例与测试 SHALL 覆盖新对象模型与新派发/监听协议

## ADDED Requirements

### Requirement: 重构范围必须覆盖全项目而不是局部修补

本 track SHALL 以全项目统一收口为目标，而不是在旧模型上局部打补丁。

#### Scenario: 不允许出现双模型长期并存
- **GIVEN** AIAgent 受影响范围覆盖 runtime、tools、TUI、docs、tests、vendor
- **WHEN** 进行改造
- **THEN** 方案 SHALL 优先追求全链路统一
- **AND** SHALL 避免新旧模型在同一正式层级长期并存

### Requirement: 正式命令与对象语义需保持低记忆负担

新命令体系 SHALL 保持统一的动词系统和一致的对象引用规则。

#### Scenario: 用户通过少量规则记住命令体系
- **GIVEN** 用户需要频繁操作多个 actor 类型
- **WHEN** 使用新的命令体系
- **THEN** 系统 SHALL 保持统一动词与统一引用规则
- **AND** SHALL 避免为不同对象类型发明不同的派发词和监听词

## 验收标准

- 整个 AIAgent 项目正式切换到新的 actor 组织模型
- 重构前正式心智模型被彻底移除
- 执行语义正式切换为 `control actor / delegate actor / detached actor`
- 组织语义与执行语义在 runtime 中保持正交，member 不再复用 `control` type
- 对外命令面只保留 `/actor`、`/member`、`/collective`、`/formation`
- 任务派发只保留 `assign / assign:r / assign:n / assign:s`
- `assign:s` 自动进入 watched 状态，`watch / unwatch` 只控制监听
- 内部 tool、变量、runtime、持久化命名和测试命名完成统一正名
- 旧数据恢复不再被正式支持
- AIAgent 正式文档完成全面重写
- `/member status` / `MemberStatus` 与正式文档、命令规范和 tool matrix 保持一致
- `vendor/depa-actor/ACTOR-FOR-AI-AGENTS.md`、相关示例与模拟测试按新设计重写完成

## 范围外事项

- 兼容旧命令、旧 tool、旧变量命名或旧数据格式
- 保留已删除旧命令作为 alias
- 为旧 session、旧 snapshot、旧 indexes 提供运行时兼容恢复
- 仅做文档改名而不改内部实现
