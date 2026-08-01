## 上下文

当前系统已经有：

- actor mailboxes
- depa-actor fiber orchestration
- cooperative executor
- DataGraph 事件链
- `message_history.txt`
- `orchestration_history.txt`

但当前 persistence 设计若只保存：

- teammate roster
- teammate inbox
- background task metadata
- protocol records
- autonomy metadata

仍然没有准确落在真正的状态归属边界上。

根据 `ACTOR-FOR-AI-AGENTS.md` 的心智模型：

- actor 负责状态、mailbox、身份边界、控制语义
- fiber 负责调度态
- vm 负责 session 级 durable subset 与 registries 投影

因此本 Track 应升级为：

- `AiAgentVmSnapshot`
- `ActorSnapshot[]`
- `FiberSnapshot[]`
- 少量索引/投影视图

而不是继续维护一套以业务模块命名的零散恢复结构。

字段级 schema 已单独收敛在：

- `codument/tracks/add-aiagent-persistence-recovery/runtime-snapshot-schema.md`
- `codument/tracks/add-aiagent-persistence-recovery/runtime-snapshot-type-mapping.md`

`design.md` 负责整体原则、边界和组件切分；具体 JSON 结构、目录布局、命名约定和 hydration 顺序以这两份文档为准。

## 当前同步状态

- 本设计文档中的主轴能力现已在当前 track 内完成收口。
- 除 `P11` ~ `P15` 中处理的 session-scoped / projection / recovery 证明问题外，`P16` 还额外完成了：
  - transcript-first 去掉 snapshot messages fallback
  - recovery report 提升为 typed runtime output
  - manifest / vm / fiber schema contract 继续向 `version` / `updatedAt` / `workloadKind` 收口
  - `orchestration_history.txt` 迁移到 `logs/` 并保留旧布局兼容
- 在此基础上，`P17` / `P18` 继续收口 autonomy 交互：
  - `AutonomyDispatch` 允许不先知道 `task_id` 即创建并派发任务
  - slash 层新增 lane-aware spawn shorthand，将 `/team` 与 `/autonomy` 的 teammate 创建体验对齐到 `spawn-leader|spawn-worker + [@agent_name]`
- 进一步的 runtime/UX 收口还包括：
  - snapshot 保存不再把 actor transcript 当作每次 tick 都全量重写的派生物，而是保留 append-only transcript 作为消息历史主源
  - autonomy teammate 默认携带 task-tree 协议提示，降低收到 `TASK_ID=` 后长期停在 `in_progress` 的概率
  - autonomy claim 会显式回流到主 agent 可见流，避免任务一旦派发就只能去 session 文件里排查
- 因此本文件现在描述的是“当前已实现并验证”的设计基线，而不只是待实现方案。

## 目标 / 非目标

### 目标

- 建立 session-scoped durable runtime snapshot layout
- 定义 `AiAgentVm` 的 durable subset
- 为每个 actor 定义完整 durable snapshot
- 为每个 actor 定义 actor-scoped transcript，并由 transcript 恢复 `ChatMessage[]`
- 为每个 actor 持久化全部 mailboxes
- 为每个 fiber 持久化调度态元数据
- 恢复 actor ↔ fiber binding
- 基于 runtime snapshot 恢复 team/background/protocol/autonomy 可见状态

### 非目标

- exact fiber continuation
- inflight LLM/tool/bash 现场恢复
- process-global roster
- event log replay 作为恢复主机制

## 补充收口背景（Post-review）

首轮实现与修复后，核心 snapshot/transcript 路径已经落地，但 post-review 仍暴露出几类残留问题：

- team / autonomy / protocol 仍残留 process-scoped singleton 读取路径
- roster / teammate view 仍可能持有独立 `messages` 副本，导致恢复后视图滞后
- `BackgroundTaskRegistry`、`vm.outerCtx.metadata` 等位置仍承担部分 session runtime state 或 service-locator 职责
- transcript 边界降级、mixed layout compat、background terminal state 无 indexes 恢复的证明还不充分

因此本设计除定义 snapshot/transcript/recovery 主轴外，还需要补充 **session-bound service access、single source of truth、DOP ownership closure** 的收口原则。

## 状态归属原则

- session 级共享状态归 `AiAgentVm`
- actor 级状态归 `AiAgentActor`
- fiber 只持有调度态，不持有业务真相源
- team/background/protocol/autonomy/indexes 仅是 projection / cache，不得反客为主
- tool / TUI 查询必须通过当前 session runtime context 读取状态，不得绕过 `AiAgentVm` 直接访问 process-global 真相源

## 设计决策

### 决策 1：恢复主数据源是 runtime snapshot，而不是业务特例 metadata

恢复需要对齐真正的状态边界：

- VM 级状态
- Actor 级状态
- Fiber 级调度态

上层业务能力只是这些状态的投影。

### 决策 2：mailbox 属于 actor，而不是 fiber

用户提出“每个 fiber 的所有 mailbox 都要序列化然后恢复”。

在当前建模中，更准确的表达应为：

- **序列化每个 actor 的所有 mailboxes**
- **恢复 actor 与 fiber 的绑定关系**

因为：

- mailbox 存放在 actor 上
- fiber 只负责调度与执行机会

这样既符合现有抽象，也符合面向数据编程的边界划分。

### 决策 3：AiAgentVm 采用 durable subset

`AiAgentVm` 中有两类数据：

1. 可持久化的 durable data
2. 仅进程内有效的 process-local handles

建议持久化：

- `primaryActorKey`
- durable registries 索引
- session manifest / schema version
- 与恢复语义相关的 VM metadata

不持久化：

- `eventBus`
- `callbacks`
- `effects`
- `actorRuntime`
- `mcpManager` 中不可序列化句柄
- `outerCtx` 中不可安全恢复对象

### 决策 4：ActorSnapshot 只保存 actor durable state，不再把 messages 当作主数据直接落入 snapshot

建议 actor snapshot 至少包含：

- `key`
- `id`
- `type`
- `systemPrompts`
- `identity`
- `planApproval`
- `shutdownProtocol`
- `toolPolicy`
- `modelConfig`
- `ctrlOptions`
- `taskTree`
- `toolCallStreamState`
- `pendingQuestionnaires`
- `mailboxes`
- `lastTeammateResultNotifiedAt`

其中：

- actor 的普通消息历史转移到 actor-scoped transcript
- `systemPrompts` 继续保留在 actor durable state 中

不直接持久化：

- `llmClient`
- `stream`
- `llmAbortController`
- `callbacks`
- `logger`

### 决策 4.1：`AiAgentActor.messages` 的恢复主源是 actor-scoped transcript

本次整改后：

- session 内每个 actor 都拥有独立的 transcript 文件
- transcript 仅保存非 system `ChatMessage` 历史
- 恢复时先解析 transcript，再加工为 `ChatMessage[]`
- actor snapshot 与 fiber snapshot 不再承担 messages 主数据职责

### 决策 5：FiberSnapshot 只保存调度态，不保存 continuation

建议 fiber snapshot 至少包含：

- `fiberId`
- `actorKey`
- `lane`
- `status`
- `parentFiberId`
- `workloadKind`
- `waitingReason`
- `createdAt`
- `lastRunAt`
- `lastYieldAt`
- 安全边界内可恢复的 resume metadata

不保存：

- `messages`
- JS 调用栈
- generator continuation
- LLM 流中间状态
- bash 子进程句柄

### 决策 6：Background / Team / Protocol / Autonomy 是主快照与 transcript 的投影

本期不再把这些能力设计成彼此独立的恢复子系统。

而是：

- team roster 来自 actor identities + team lane actors
- teammate 未读消息来自 actor mailboxes
- background task 状态来自 background lane fibers + actor metadata
- protocol 状态来自 actor protocol fields
- autonomy 状态来自 VM durable subset + autonomy lane fibers
- 普通消息历史来自 actor-scoped transcript

derived indexes 继续允许落盘，但仅作为查询 cache，不再作为恢复主输入。这样恢复源统一，避免状态分叉。

### 决策 6.1：Team / Protocol / Autonomy 的查询与恢复作用域必须绑定当前 `AiAgentVm`

`session-scoped` 不仅适用于 snapshot 目录布局，也适用于运行时的查询、恢复和调度路径。

因此：

- `TeamManager` 若继续保留服务对象角色，也不得以 process-global roster 充当 session runtime state 真相源
- `ProtocolEngine` 若继续保留服务对象角色，也不得以 process-global record map 充当 session protocol 真相源
- tools / TUI 访问 team、protocol、autonomy 时，必须经由当前 `AiAgentVm` 对应的 runtime context
- recovery 过程中不得采用“已有全局状态 + 当前 session 恢复结果”的跨 session merge 语义

### 决策 6.2：恢复后可见视图必须持续派生自 actor / vm / fiber 当前真相源

恢复后的 team/bg/protocol/autonomy 视图不能只在 recovery 瞬间正确，还必须在 runtime 继续推进后保持同步。

因此：

- teammate 可见视图应基于 actor 当前状态计算
- 若存在摘要缓存或派生索引，它们只能作为 projection/cache
- projection 层不得长期持有独立演化的 `messages` 副本或其它业务真相源副本

### 决策 6.3：metadata 只能承载临时运行时上下文，不能继续扩展为主状态杂物箱

当前存在若干 metadata 字段用于运行时访问与恢复：

- `__autonomy_task_ownership`
- `__ai_orchestrator`
- `__ai_driver`
- `__autonomy_controller`
- `__actor_fiber_bindings`
- `__deferred_team_resumes`

这些字段在过渡期可存在，但需要区分三类边界：

1. durable business state
2. typed runtime context / handles
3. transient execution scratch

其中关键业务状态不得长期只保存在 metadata 魔法字段中；可持久化或可投影的状态应显式归属到 `AiAgentVm` / `AiAgentActor`。

### 决策 6.4：VM 外挂 sidecar registry 只允许作为过渡，不应成为最终真相源

`WeakMap<AiAgentVm, Registry>` 型 sidecar state 比 process-global singleton 更安全，但它仍不是 DOP 下的最终状态归属。

因此：

- `BackgroundTaskRegistry` 这类 VM 外挂状态容器可以作为兼容层
- 但长期目标仍应是让关键 session state 在 `AiAgentVm` 中可显式定位、可类型化、可恢复
- 若 sidecar 继续保留，也不能成为 snapshot / query / recovery 的唯一真相源

### 决策 7：unfinished external side effects 默认 no-replay

即便 actor/fiber snapshot 能恢复，也不能自动重放：

- in-flight tool side effects
- in-flight bash effects
- in-flight external writes

恢复语义仍为：

- 可见
- 可解释
- 不自动重放

## 反模式禁令

- 禁止 process-global singleton 作为 session runtime state 真相源
- 禁止 projection / cache 成为可独立演化的长期真相源
- 禁止跨 session existing-plus-restored merge 作为恢复语义
- 禁止关键业务状态长期只保存在 metadata 魔法字段中
- 禁止 roster / view 以独立消息副本驱动恢复后长期可见状态

## 建议目录结构

```text
<sessionDir>/
  runtime_state/
    manifest.json
    vm.json
    fibers/
      <fiber_id>.json
    indexes/
      actors_by_key.json
      actors_by_id.json
      fibers_by_id.json
      teamRoster.json
      backgroundTasks.json
      protocolRecords.json
      autonomyState.json
  actors/
    primary__<actor_id>/
      actor.json
      transcript.txt
      mailboxes.json
      state.json
    <actor_type>__agent__<agent_name>__<actor_id>/
      actor.json
      transcript.txt
      mailboxes.json
      state.json
    <actor_type>__teammate__<teammate_name>__<actor_id>/
      actor.json
      transcript.txt
      mailboxes.json
      state.json
  logs/
    orchestration_history.txt
```

说明：

- `vm.json` 是 durable VM subset
- `actors/*/actor.json`、`state.json`、`mailboxes.json` 共同组成 actor durable snapshot
- `actors/*/transcript.txt` 是 `AiAgentActor.messages` 的磁盘真相源
- `fibers/*.json` 是 fiber scheduling snapshots
- `indexes/*.json` 是便于查询/展示的派生索引，可重建，但建议落盘

## 组件切分

### 1. Runtime snapshot repository

建议新增统一 repository：

- `loadRuntimeSnapshot(sessionDir)`
- `saveVmSnapshot(...)`
- `saveActorSnapshot(...)`
- `saveFiberSnapshot(...)`
- `saveDerivedIndexes(...)`

职责：

- 管理 schema version
- 管理原子写入
- 统一处理容错与损坏恢复

### 2. Actor serializer / hydrator

建议新增：

- `serializeActor(actor)`
- `hydrateActor(snapshot, runtimeDeps)`

职责：

- 明确 actor durable subset
- 重新装配 process-local fields

### 3. Fiber serializer / hydrator

建议新增：

- `serializeFiber(fiberState)`
- `hydrateFiber(snapshot, runtimeState)`

职责：

- 只恢复调度态元数据
- 不触碰 continuation 级细节

### 4. Vm serializer / hydrator

建议新增：

- `serializeVm(vm)`
- `hydrateVm(snapshot, runtimeDeps)`

职责：

- 保存 session-scoped durable subset
- 恢复 registries 投影索引

### 5. Recovery bootstrap

建议新增：

- `recoverAiAgentRuntime(sessionDir, runtimeDeps)`

恢复顺序：

1. 读取 `manifest.json`
2. 恢复 `vm.json`
3. 恢复 actor durable state（`actor.json` / `state.json` / `mailboxes.json`）
4. 解析 actor transcript，并还原 `ChatMessage[]`
5. 恢复 `fibers/*.json`
6. 重建 actor ↔ fiber binding
7. 从 VM/actors/fibers/transcript 生成 derived indexes
8. 重装配 event bus / callbacks / effects / clients
9. 暴露恢复报告给 TUI / tools

## 数据一致性策略

第一阶段不追求事务级一致性，但需要：

- 单文件原子替换
- snapshot 带 `version`
- snapshot 带 `updated_at`
- 部分损坏时尽可能局部降级，不直接崩溃整个 session

## 恢复语义细化

### actor 恢复

- 恢复 durable fields
- 恢复全部 mailboxes
- 恢复 protocol state
- 恢复 pending questionnaires

### fiber 恢复

- 恢复 lane / status / workload kind / actor binding
- 若 fiber 对应 unfinished background work，则状态降级为 `interrupted`
- 从安全边界重新排入调度，而不是恢复到执行中间态

### VM 恢复

- 恢复 `primaryActorKey`
- 恢复 autonomy durable metadata
- 从主快照重建 autonomy / team / bg / protocol 的查询视图

## 测试策略

### 单元测试

- VM snapshot schema read/write
- Actor snapshot schema read/write
- 全 mailbox 序列化与恢复顺序
- Fiber scheduling snapshot read/write
- background unfinished -> `interrupted`
- transcript reducer 的尾部损坏、marker 缺失、半条 tool call、questionnaire 中断降级

### 集成测试

- 启动 runtime -> 写入 actor/fiber/vm snapshots -> dispose -> restart -> 验证恢复
- 验证恢复后 actor 继续从 mailbox drain
- 验证恢复后 `/team list`、`/team status`、`/bg list`、`/protocol status`、`/autonomy status`
- 验证多 session 并存时 team / protocol / autonomy 查询与恢复严格隔离
- 验证 completed / failed / cancelled background task 在 indexes 缺失时仍可由主快照恢复

### E2E / TUI 测试

- TUI 重启后能看到恢复后的 teammates / background tasks / protocol / autonomy 状态
- 若 actor mailbox 中有待处理消息，恢复后对应 teammate/primary actor 能继续处理
- 恢复后 teammate 继续输出时，TUI 视图会持续反映最新 actor 真相
- old layout / new layout 混合 session 仍满足兼容恢复语义

## 风险 / 权衡

- 这套设计明显比“只做 teammate inbox”更大，但它真正对齐了系统抽象
- 若 snapshot schema 设计不清晰，后续会出现 VM/actor/fiber 之间状态重复
- 若把 fiber snapshot 设计过深，会误导为 exact resume；必须明确只恢复调度态
- 若不继续收口 process-scoped singleton、metadata 杂物箱与 sidecar state，恢复逻辑会长期依赖隐式状态，难以维护与验证
- 若 query path 与 recovery path 没有严格跟随当前 `AiAgentVm`，多 session 并存时仍会出现串读 / 串写风险

## 建议分阶段实施

### Stage A：schema 与 repository

- manifest
- vm snapshot
- actor snapshot
- fiber snapshot
- derived indexes

### Stage B：actor 全状态持久化

- actor serializer/hydrator
- all mailboxes durability
- protocol / questionnaires / task tree durability

### Stage C：fiber 调度态持久化

- fiber serializer/hydrator
- actor ↔ fiber binding recovery
- background interrupted downgrade

### Stage D：runtime bootstrap

- VM/actors/fibers recovery
- runtime handles rebind
- tools / TUI visibility

### Stage E：future deferred work

- replay-safety taxonomy
- richer continuation checkpoints
- optional exact-resume research

### Stage F：post-review closure

- 收口 team / autonomy / protocol 的 session-bound service access
- 收口恢复后 projection/view 的 single source of truth
- 收口 background sidecar state 与 metadata 魔法字段的 DOP 边界
- 补齐 transcript / compat / no-index terminal state 的恢复证明
