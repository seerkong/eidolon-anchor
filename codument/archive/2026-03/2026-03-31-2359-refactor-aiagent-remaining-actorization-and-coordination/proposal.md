# 变更：收口 AIAgent 剩余 actor ownership 并将 protocol 正名为 coordination

## 背景和动机 (Context And Why)

前一轮 AIAgent 重构已经完成了正式对象模型、命令面和大部分 actor/fiber 调度底座，但当前运行时仍存在几个关键残留：`detached` 仍停留在 lane/workload 语义而不是实际 actor type，`collective` 与 `formation` 仍主要通过 projection/controller/helper 驱动，`protocol` 仍以 VM helper 和 tool 内同步状态推进存在，`TerminalRuntime` 仍保留部分业务推进责任。

这些残留使项目对外已经像 actor 模型，但对内仍有多处“business state 不归 actor 持有”的半完成结构，也让 `vendor/depa-actor` 所推荐的 actor-owned state / mailbox / fiber 边界没有真正落地。因此需要一轮收口，把剩余未完成的 actor ownership 完整实现，并统一将 `protocol` 正名为 `coordination`。

## “要做”和“不做” (Goals / Non-Goals)

**目标:**
- 将 detached/background 执行体收口为真正的 `actor.type = detached`
- 将 `collective` 收口为真正的 collective actor，并让其持有 task board 与 ownership 真相源
- 将 `formation` 收口为轻量 leader 路由与结果回流 actor
- 将 `protocol` 重命名为 `coordination`
- 为每个业务 actor 引入自己的 `coordination` mailbox，而不是新增独立 coordination actor
- 将 request/review/done 的 coordination 状态推进从 tool 层移到 actor mailbox / actor state
- 让 `OrganizationManager`、`DetachedActorRegistry`、`ProtocolEngine`、`TerminalRuntime` 退化为 factory/index/helper/bridge，而不再承担业务真相源职责
- 同步更新状态查询、持久化快照、文档命名、测试命名和目录命名

**非目标:**
- 不新增 `/coordination` 之类新的一级命令面
- 不引入“一请求一 coordination actor”模型
- 不把 formation 扩展成复杂多成员协调器或 fan-out 汇总器
- 不把 `TerminalRuntime`、`ToolRegistry`、projection graph、history writer 改造成 actor
- 不保留 `protocol` 作为正式兼容命名

## 变更内容（What Changes）

- **BREAKING** detached/background 执行体改为真正的 `actor.type = detached`
- **BREAKING** `collective` 从 organization projection/controller 收口为真正的 collective actor
- **BREAKING** `formation` 从 leader proxy 收口为轻量路由与回流 actor
- **BREAKING** 将 `protocol` 正式重命名为 `coordination`
- **BREAKING** 将 `ProtocolEngine`、`ProtocolStatus`、`protocolRecords`、`protocol` 目录等正式命名收口为 `Coordination*`、`coordinationRecords`、`coordination/`
- 将每个业务 actor 的控制型协作交互统一纳入 `coordination` mailbox
- 将 `plan approval`、`shutdown handshake` 等 request/review/done 状态推进从 tool 层收回 actor mailbox
- 将 `collectiveTaskOwnership` 从 VM 全局表收回 collective actor 内部状态
- 将 formation 的 leader 指针、成员表、回流路由关联收回 formation actor 状态
- 清理 `TerminalRuntime` 上的 business pump 依赖，降级为 I/O bridge 与 orchestrator bridge

## 影响范围（Impact）

- 受影响的功能规范：
  - `aiagent-member-collective-formation-model`
  - `aiagent-fiber-orchestration`
  - `aiagent-persistence-recovery`

- 受影响的代码与资产：
  - `cell/packages/core-logic/src/runtime/*`
  - `cell/packages/organ-logic/src/agent/*`
  - `cell/packages/organ-logic/src/organization/*`
  - `cell/packages/organ-logic/src/protocol/*`（将重命名）
  - `cell/packages/organ-logic/src/composer/AIAgent/tools/*`
  - `cell/packages/organ-logic/src/persistence/*`
  - `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts`
  - `vendor/depa-actor/ACTOR-FOR-AI-AGENTS.md`
  - backend/terminal 相关测试与 fixtures
