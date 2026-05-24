## 上下文

上一轮 AIAgent actor 模型重构已经完成 formal surface 收口，但从当前实现与 `depa-actor` 推荐边界对照看，仍有四类关键残留：

1. detached/background 仍主要是 lane/workload 语义，不是真正的 `actor.type = detached`
2. collective 仍依赖 `RuntimeCollectiveController`、`CollectiveTaskRunner`、tool polling 与 VM 全局 ownership 表
3. formation 仍主要是 leader proxy，没有真正的 formation actor
4. `protocol` 仍是 VM helper + tool 内同步状态推进，既不贴切，也不符合 actor mailbox ownership

同时，`vendor/depa-actor/ACTOR-FOR-AI-AGENTS.md` 与引擎实现已经明确了推荐边界：

- actor 拥有状态、mailbox、watched、control/coordination 等控制语义
- fiber 拥有 lane、等待原因、暂停/恢复/取消/超时/重试
- bridge、registry、projection、writer 不应反客为主成为业务真相源

因此本 Track 的目标不是再添加一层 wrapper，而是把剩余未完成的 actor ownership 真正收回到 actor/fiber 模型里，并把 `protocol` 正名为 `coordination`。

## 方案概览

1. detached actor 真正落地
  - detached/background 创建路径直接产出 `actor.type = detached`
  - detached actor 自身持有运行态与终态
  - detached registry 仅保留索引与查询辅助
  - child execution factory 使用中性命名，避免把 `delegate` / `detached` 两类并列 execution semantics 混成单一 delegate helper

2. collective actor 化
  - 为 collective 提供真正的 actor / fiber / mailbox
  - collective actor 持有 task board、ownership、watch state、成员路由
  - collective 通过成员回报消息完成状态归并，不再依赖 tool polling 补完成

3. formation actor 化
  - formation 是轻量 leader 路由与回流 actor
  - formation actor 持有 leader 指针、成员表、watch state、回流路由关联
  - formation 接收 `assign` 后原样转给当前 leader
  - leader 的总结与阶段事件先回到 formation，再由 formation 回路由给原始发起者
  - streamed route-and-return 只补最小必要事件面：
    - 增加 formation route event envelope，用于承载 `leader_received` / 最小阶段事件
    - formation route state 记录 eventCount / lastEventText / lastEventAt 等最小推进信息
    - 仅在 `reply_mode = stream` 时把阶段事件继续回路由给 initiator，避免 final/none 路径被额外中间事件污染
  - formation 不扩展成复杂 fan-out 协调器

4. protocol -> coordination
  - 正式命名统一切换为 `coordination`
  - 每个业务 actor 拥有自己的 `coordination` mailbox
  - `plan approval`、`shutdown handshake` 等 request/review/done 在 actor mailbox / actor state 中推进
  - 不引入独立 coordination actor

5. runtime bridge 清理
  - `TerminalRuntime` 降级为 I/O bridge 与 orchestrator bridge
  - collective/background 的推进权回到 actor/fiber
  - runtime queue/pump/deferred resume 只保留 bridge 必需语义，不再承担业务真相源职责

## 影响范围与修改点

### Runtime / Actor Ownership
- `cell/packages/core-logic/src/runtime/actor.ts`
- `cell/packages/core-logic/src/runtime/runtime.ts`
- `cell/packages/organ-logic/src/agent/DelegateActor.ts`
- `cell/packages/organ-logic/src/OrchestratorDriver.ts`
- `cell/packages/organ-logic/src/lane/*`

### Collective / Formation
- `cell/packages/organ-logic/src/organization/OrganizationManager.ts`
- `cell/packages/organ-logic/src/organization/RuntimeCollectiveController.ts`
- `cell/packages/organ-logic/src/organization/CollectiveTaskRunner.ts`
- `cell/packages/organ-logic/src/composer/AIAgent/tools/_collectiveAssignCore.ts`
- `cell/packages/organ-logic/src/composer/AIAgent/tools/ActorAssign/Logic.ts`
- `cell/packages/organ-logic/src/composer/AIAgent/tools/ActorStatus/Logic.ts`
- `cell/packages/organ-logic/src/composer/AIAgent/tools/Formation*`
- `cell/packages/organ-logic/src/composer/AIAgent/tools/Collective*`

### Coordination Rename
- `cell/packages/organ-logic/src/protocol/` -> `cell/packages/organ-logic/src/coordination/`
- `ProtocolEngine` -> `CoordinationEngine`
- `ProtocolStatus` -> `CoordinationStatus`
- `protocolRecords` -> `coordinationRecords`
- runtime snapshot / recovery / status query / docs / tests / fixtures 中的正式命名同步替换

### Persistence / Recovery
- `cell/packages/organ-logic/src/persistence/RuntimeSnapshots.ts`
- `cell/packages/core-logic/src/runtime/snapshot/*`
- detached / collective / formation / coordination 相关 snapshot schema 与恢复路径

### Terminal Bridge
- `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts`
- terminal/tui/minimal 相关 runtime tests

## 决策

- 决策：coordination 采用每个 actor 自有 mailbox，而不是独立 coordination actor
  - 理由：control-like 协作语义本就应与 actor 自身状态、mailbox priority、selective receive、cancel/shutdown 等控制语义并列

- 决策：formation 是 leader 路由与回流 actor，不是复杂协调器
  - 理由：有 leader / 无 leader 的语义边界本就不同；formation 不应和 collective 混成同一类自治编排器

- 决策：formation stage event 只引入最小必要 route-event schema
  - 理由：当前 track 只需要补齐 streamed route-and-return 的 actor 闭环，不需要把 formation 扩展成完整 event-sourcing 协调器

- 决策：collectiveTaskOwnership 收回 collective actor
  - 理由：ownership 属于 collective 组织本身，不应继续停留在 VM 全局表

- 决策：OrganizationManager / DetachedActorRegistry / CoordinationEngine 只保留辅助角色
  - 理由：factory/index/parser-helper 不应承担长期业务真相源

- 决策：child execution factory 使用 `spawnChildExecutionActor` 命名
  - 理由：该 helper 同时承担 `delegate` 与 `detached` 两类 child execution actor 的创建；继续保留 `runDelegateActor` 命名会误导实现边界，并弱化 `control / delegate / detached` 的并列语义

- 决策：TerminalRuntime 保持 bridge 身份，不 actor 化
  - 理由：其职责是 I/O bridge，不是业务对象；真正要 actor 化的是 collective/formation/detached/coordination 语义

## 风险 / 权衡

- 风险：ownership 收口会影响 collective、formation、detached、snapshot、status query 多条路径
  - 缓解：先锁定 spec 与 focused tests，再迁移 query/persistence

- 风险：coordination rename 影响文件名、目录名、类型名、测试名与文档名，改动面大
  - 缓解：统一在同一 Track 中完成正式命名收口，避免 `protocol` / `coordination` 双命名长期并存

- 风险：formation 回流路由如果设计过重，会滑向复杂协调器
  - 缓解：只允许 formation 持有最小必要的 leader 路由和结果回流关联，不引入复杂 fan-out 汇总状态

- 风险：runtime pump 清理不当会破坏 terminal 交互稳定性
  - 缓解：保留必要 bridge 语义，用 focused tests 锁定 foreground settle、background settle、deferred resume 的边界

## 兼容性设计

- 本 Track 按 breaking-change 路线执行
- 不保留 `protocol` 作为正式命名 alias
- 若必须兼容历史 `protocol` payload，只允许保留在显式 legacy parse fallback；不得继续作为公开 helper、test bridge 或正式写入 API 的并列入口
- 不保留 detached registry / organization manager / tool polling 作为正式业务真相源
- legacy `RuntimeCollectiveController` 若仍存在，只允许停留在 direct-path 测试辅助层，不再通过 `@cell/organ-logic` 顶层正式导出面暴露
- 不新增新的一级命令面；formal surface 仍保持 `/actor /member /collective /formation`

## 迁移计划

1. 先冻结 detached / collective / formation / coordination 的 actor ownership 边界
2. 再完成 `protocol -> coordination` 的命名迁移与 mailbox schema 调整
3. 然后实现 detached actor / collective actor / formation actor
4. 再清理 query、snapshot、recovery 与 runtime bridge
5. 最后补全 focused tests、文档与 fixtures

## 待解决问题

- formation 回流关联的最小状态字段：仅 `request_id` / `initiator_actor`，还是还需要 `tool_call_id` / `task_id`
- coordination mailbox 的 priority 排位：相对 `control`、`childDone`、`memberInbox` 的具体优先级顺序
- collective actor 的 completion 消息格式：仅 final summary，还是结构化 status/event/result 分层
