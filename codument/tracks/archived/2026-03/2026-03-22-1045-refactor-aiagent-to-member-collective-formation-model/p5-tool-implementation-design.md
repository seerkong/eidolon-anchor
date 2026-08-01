# P5 Tool Implementation Design

## 目标

P5 不再沿用重构前公开 tool API，也不做 rename-only 包装。

本文件定义 P5 要实现的 command-aligned lower-level tool matrix，使底层 tool 直接对应正式命令面：

- `/actor`
- `/member`
- `/collective`
- `/formation`

## 设计原则

1. **Actor 是统一执行入口**
   - 任务派发、状态查询、监听控制统一落在 `Actor*` 工具族。

2. **组织工具只负责结构语义**
   - `Member* / Collective* / Formation*` 只做对象创建、关系管理、类型约束和组织态投影。

3. **Collective 内化自治**
   - collective 调度不再是独立 API 家族。
   - collective 的任务板、领取、调度推进是 collective 内部能力。

4. **不保留旧 API 兼容入口**
   - 重构前公开工具族删除。
   - 如需迁移提示，只通过文档或 fail-fast 错误文案提供。
   - 执行 helper 若继续存在，也必须按正式执行语义命名。

## 统一输入/输出约定

### 目标引用

所有 actor/组织目标统一支持：

- 裸名字：`alice` / `research` / `alpha`
- 类型前缀：`member:alice` / `collective:research` / `formation:alpha`
- 稳定 id：`member-*` / `collective-*` / `formation-*`

### 统一派发模式

- `final`
- `none`
- `stream`

### 统一行为约束

- `stream` 模式必须自动开启 watched 状态
- `watch / unwatch` 必须幂等
- typed wrapper 工具必须先做类型校验，再调用底层 actor 能力

## Shared Foundation Checklist

- [ ] 统一 actor ref resolver（裸名 / typed ref / stable id）
- [ ] 统一 assign mode parser 与 validation helper
- [ ] 统一 watched 状态写回 helper
- [ ] 统一 tool output mapper（member-first / actor-first）
- [ ] 统一 fail-fast error 文案（removed old APIs / invalid target type / missing leader 等）

## Actor Tool Family

### ActorAssign

**Purpose**
- 对任意 actor 执行统一任务派发

**Input**
- `target`
- `content`
- `mode?: final | none | stream`

**Runtime dependencies**
- actor ref resolver
- assignment dispatcher
- watch state store
- event stream bridge

**Validation**
- [ ] `target` 必填且可解析
- [ ] `content` 非空
- [ ] `mode` 合法
- [ ] target 必须可接收任务

**Output**
- [ ] `final` 返回 assignment/result 结构
- [ ] `none` 返回 accepted/pending 结构
- [ ] `stream` 返回 streamOpened/watched 结构

**Key tests**
- [ ] 三种 mode 语义矩阵
- [ ] `assign:s` 自动 watched
- [ ] bad ref / empty content / wrong target fail-fast
- [ ] bare name / typed ref / stable id 全支持

### ActorStatus

**Purpose**
- 查询任意 actor 当前状态

**Input**
- `target`

**Runtime dependencies**
- actor ref resolver
- runtime state projection
- watch state store

**Validation**
- [ ] `target` 必填且可解析
- [ ] 目标存在

**Output**
- [ ] 统一返回 actor id / actor type / watched / lifecycle
- [ ] 组织对象返回 membership / leader / queue summary 等投影
- [ ] detached actor 返回 detached-specific projection

**Key tests**
- [ ] member / collective / formation / detached 全覆盖
- [ ] watched 状态正确投影
- [ ] unknown target fail-fast

### ActorWatch

**Purpose**
- 开启对象级持续监听

**Input**
- `target`

**Runtime dependencies**
- actor ref resolver
- watch state store
- subscription manager

**Validation**
- [ ] `target` 必填且可解析
- [ ] 目标存在

**Output**
- [ ] 返回 `watched: true`
- [ ] 返回 `changed` 幂等标志

**Key tests**
- [ ] 首次 watch 成功
- [ ] 重复 watch 幂等
- [ ] 不创建任务

### ActorUnwatch

**Purpose**
- 关闭对象级持续监听

**Input**
- `target`

**Runtime dependencies**
- actor ref resolver
- watch state store
- subscription manager

**Validation**
- [ ] `target` 必填且可解析
- [ ] 目标存在

**Output**
- [ ] 返回 `watched: false`
- [ ] 返回 `changed` 幂等标志

**Key tests**
- [ ] 首次 unwatch 成功
- [ ] 重复 unwatch 幂等
- [ ] 不取消任务、不回滚状态

## Member Tool Family

### MemberCreate

**Purpose**
- 创建 member actor

**Input**
- `name`
- `agent_type?`
- `prompt?`

**Runtime dependencies**
- member factory
- actor registry
- prompt/profile builder

**Validation**
- [ ] `name` 必填且合法
- [ ] 名称不可冲突
- [ ] `agent_type` 若提供必须能映射到 agent registry

**Output**
- [ ] 返回 `member_id`
- [ ] 返回 actor registration 结果
- [ ] 不再把 removed member alias 字段作为正式主输出

**Key tests**
- [ ] 最小创建
- [ ] 带 `@agent_name` / prompt 创建
- [ ] duplicate name reject

### MemberList

**Purpose**
- 列出 member registry

**Input**
- 无

**Runtime dependencies**
- member registry
- roster projection

**Validation**
- [ ] 空输入即可工作

**Output**
- [ ] 只返回 `members`
- [ ] 输出稳定排序与 `member_count`
- [ ] 不再以 removed roster alias 作为正式主输出

**Key tests**
- [ ] 仅返回 member 对象
- [ ] 空列表
- [ ] member_count 正确

### MemberStatus

**Purpose**
- typed wrapper over `ActorStatus(target=member:...)`

**Input**
- `target`

**Runtime dependencies**
- member resolver
- ActorStatus

**Validation**
- [ ] `target` 必须解析为 member

**Output**
- [ ] 返回 `member_id` / `name` / `status` / `lifecycle_state` / `watch_state`
- [ ] 补充 `actor_key` / `actor_id`
- [ ] 不再以重构前字段风格作为正式主输出

**Key tests**
- [ ] member 状态查询成功
- [ ] 非 member ref 类型错误
- [ ] watched 状态正确投影

### MemberAssign

**Purpose**
- typed wrapper over `ActorAssign(target=member:...)`

**Input**
- `target`
- `content`
- `mode?`

**Runtime dependencies**
- member resolver
- ActorAssign

**Validation**
- [ ] `target` 必须解析为 member
- [ ] `content` 非空

**Output**
- [ ] 继承 ActorAssign 输出
- [ ] 补充 `target_type = member`

**Key tests**
- [ ] member assign 三种模式
- [ ] collective/formation ref 类型错误
- [ ] `assign:s` 自动 watched

## Collective Tool Family

### CollectiveCreate

**Purpose**
- 创建 collective actor

**Input**
- `name`

**Runtime dependencies**
- collective factory
- organization registry

**Validation**
- [ ] `name` 必填
- [ ] 名称唯一

**Output**
- [ ] 返回 `collective_id`
- [ ] 返回 `member_count = 0`

**Key tests**
- [ ] create success
- [ ] duplicate reject

### CollectiveAdd

**Purpose**
- 建立 member → collective membership

**Input**
- `collective`
- `member`

**Runtime dependencies**
- collective resolver
- member resolver
- organization relation store

**Validation**
- [ ] collective ref 必须是 collective
- [ ] member ref 必须是 member
- [ ] 不可重复加入

**Output**
- [ ] 返回 `collective_id`
- [ ] 返回 `member_id`
- [ ] 返回更新后的 `member_count`

**Key tests**
- [ ] add success
- [ ] duplicate add fail-fast
- [ ] wrong type reject

### CollectiveAssign

**Purpose**
- typed wrapper over `ActorAssign(target=collective:...)`
- collective 内部调度从这里进入，但不再暴露独立旧工具族

**Input**
- `target`
- `content`
- `mode?`

**Runtime dependencies**
- collective resolver
- ActorAssign
- collective task board / scheduler

**Validation**
- [ ] `target` 必须是 collective
- [ ] `content` 非空
- [ ] collective 空成员时行为必须明确（建议 fail-fast）

**Output**
- [ ] 继承 ActorAssign 输出
- [ ] 补充 `target_type = collective`

**Key tests**
- [ ] collective 正常接单
- [ ] empty collective reject
- [ ] `assign:s` 自动 watched
- [ ] 不再依赖重构前调度工具

### CollectiveStatus

**Purpose**
- typed wrapper over `ActorStatus(target=collective:...)`

**Input**
- `target`

**Runtime dependencies**
- collective resolver
- ActorStatus
- collective projection builder

**Validation**
- [ ] `target` 必须是 collective

**Output**
- [ ] 返回 collective actor 基础状态
- [ ] 返回成员列表 / 成员数 / 当前任务摘要
- [ ] 不再以重构前状态工具作为正式公开入口

**Key tests**
- [ ] membership / queue summary 正确
- [ ] 非 collective ref reject

## Formation Tool Family

### FormationCreate

**Purpose**
- 创建 formation actor

**Input**
- `name`

**Runtime dependencies**
- formation factory
- organization registry

**Validation**
- [ ] `name` 必填
- [ ] 名称唯一

**Output**
- [ ] 返回 `formation_id`
- [ ] 返回 `leader_member_id = null`

**Key tests**
- [ ] create success
- [ ] duplicate reject

### FormationAdd

**Purpose**
- 建立 member → formation membership

**Input**
- `formation`
- `member`

**Runtime dependencies**
- formation resolver
- member resolver
- organization relation store

**Validation**
- [ ] formation ref 必须是 formation
- [ ] member ref 必须是 member
- [ ] 不可重复加入

**Output**
- [ ] 返回 `formation_id`
- [ ] 返回 `member_id`
- [ ] 返回更新后的 `member_count`

**Key tests**
- [ ] add success
- [ ] duplicate add fail-fast
- [ ] wrong type reject

### FormationAppoint

**Purpose**
- 任命 formation leader

**Input**
- `formation`
- `member`

**Runtime dependencies**
- formation resolver
- member resolver
- leadership relation store

**Validation**
- [ ] formation ref 必须是 formation
- [ ] member ref 必须是 member
- [ ] member 必须已属于 formation

**Output**
- [ ] 返回 `formation_id`
- [ ] 返回 `leader_member_id`
- [ ] 返回 `appointed: true`

**Key tests**
- [ ] appoint success
- [ ] 非 formation member reject
- [ ] reappoint 语义明确

### FormationAssign

**Purpose**
- typed wrapper over `ActorAssign(target=formation:...)`

**Input**
- `target`
- `content`
- `mode?`

**Runtime dependencies**
- formation resolver
- ActorAssign
- formation leader routing / coordinator

**Validation**
- [ ] `target` 必须是 formation
- [ ] `content` 非空
- [ ] 无 leader 时行为明确（建议 fail-fast）

**Output**
- [ ] 继承 ActorAssign 输出
- [ ] 补充 `target_type = formation`

**Key tests**
- [ ] 有 leader 时 assign success
- [ ] 无 leader reject
- [ ] `assign:s` 自动 watched

### FormationStatus

**Purpose**
- typed wrapper over `ActorStatus(target=formation:...)`

**Input**
- `target`

**Runtime dependencies**
- formation resolver
- ActorStatus
- formation projection builder

**Validation**
- [ ] `target` 必须是 formation

**Output**
- [ ] 返回 formation actor 基础状态
- [ ] 返回 leader / members / member_count / task summary

**Key tests**
- [ ] leader 正确显示
- [ ] 无 leader 时仍可查询
- [ ] 非 formation ref reject

## P5 Task Mapping

### T5.1 红：command-aligned tool matrix 与 slash command 测试
- [ ] `T5.1.1` actor ref 解析与 assign mode 协议测试
- [ ] `T5.1.2` Actor* 工具矩阵测试
- [ ] `T5.1.3` Member* 工具矩阵测试
- [ ] `T5.1.4` Collective* / Formation* 工具矩阵测试
- [ ] `T5.1.5` 已删除公开工具删除测试

### T5.2 绿：实现 actor-native 核心工具与组织结构工具
- [ ] `T5.2.1` shared resolver / validation / output contract helpers
- [ ] `T5.2.2` `ActorAssign / ActorStatus / ActorWatch / ActorUnwatch`
- [ ] `T5.2.3` `MemberCreate / MemberList / MemberStatus / MemberAssign`
- [ ] `T5.2.4` `CollectiveCreate / CollectiveAdd / CollectiveAssign / CollectiveStatus`
- [ ] `T5.2.5` `FormationCreate / FormationAdd / FormationAppoint / FormationAssign / FormationStatus`
- [ ] `T5.2.6` builtin tool registry 切换到新矩阵

### T5.3 绿：让 slash command 组合新的底层 tools
- [ ] `T5.3.1` `/actor` → Actor*
- [ ] `T5.3.2` `/member` → Member*
- [ ] `T5.3.3` `/collective` + `/formation` → 组织工具族
- [ ] `T5.3.4` terminal / TUI / minimal help、catalog、completion 切换

### T5.4 拆除重构前工具与公开入口
- [ ] `T5.4.1` 删除重构前 tool registry 与 schema name
- [ ] `T5.4.2` 删除重构前公开入口
- [ ] `T5.4.3` 删除旧帮助文案、旧 tests、旧文档引用
- [ ] `T5.4.4` 只保留文档级迁移表或 fail-fast 提示，不保留运行时 alias
