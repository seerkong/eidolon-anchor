## ADDED Requirements

### Requirement: Session-scoped durable runtime snapshot store
系统 MUST 为每个 session 提供独立的 durable runtime snapshot store，用于保存 `AiAgentVm` durable subset、actor durable state、actor-scoped message transcript、fiber scheduling metadata 以及其上层投影视图。

#### Scenario: 状态严格属于单个 session
- **GIVEN** 存在两个不同的 session
- **WHEN** 每个 session 分别运行 primary actor、teammate、background task 或 autonomy
- **THEN** 系统 MUST 将 durable snapshot 写入各自 session 的 runtime state 目录
- **AND** 一个 session 的恢复不得读取另一个 session 的 snapshot

#### Scenario: 恢复主数据源不是 orchestration_history
- **GIVEN** session 同时存在 `orchestration_history.txt` 与 durable runtime snapshot
- **WHEN** 系统执行恢复
- **THEN** 系统 MUST 以 durable snapshot 为主恢复源
- **AND** `orchestration_history.txt` 仅作为审计与调试输入

#### Scenario: team coordination autonomy 查询与恢复路径保持 session-scoped
- **GIVEN** 两个不同 session 在同一进程中并存，且各自拥有 teammate、coordination records 与 autonomy workers
- **WHEN** 用户查询 `/team list`、`/coordination status`、`/autonomy status` 或系统恢复其中一个 session
- **THEN** 系统 MUST 只读取并暴露当前 session 的 runtime state
- **AND** 系统 MUST NOT 合并或泄漏来自其他 session 的 process-global team、coordination 或 autonomy 状态

### Requirement: AiAgentVm durable subset
系统 MUST 为 `AiAgentVm` 定义明确的 durable subset，只持久化可序列化且恢复后仍有语义的数据。

#### Scenario: VM 仅持久化 durable subset
- **GIVEN** `AiAgentVm` 同时包含 durable data 与 process-local handles
- **WHEN** 系统写入 VM snapshot
- **THEN** 系统 MUST 持久化 durable subset
- **AND** 系统 MUST NOT 持久化 eventBus、callbacks、effects、actorRuntime、client handle 等不可安全恢复对象

#### Scenario: 重启后恢复 VM durable subset
- **GIVEN** session 已存在 VM snapshot
- **WHEN** runtime 重建该 session
- **THEN** 系统 MUST 恢复 `primaryActorKey`、durable registries 索引、schema version 与其他 durable VM metadata

#### Scenario: VM snapshot 正式持久化 holon store
- **GIVEN** 当前组织运行态已经统一为 `member / holon`
- **WHEN** 系统写入 VM snapshot
- **THEN** session durable subset MUST 使用 `sessionState.holons`
- **AND** 系统 MUST NOT 再将旧组织字段视为当前正式 snapshot 结构

### Requirement: Session runtime state has explicit ownership
系统 MUST 让 session 级共享状态显式归属于 `AiAgentVm`，让 actor 级状态显式归属于 `AiAgentActor`；module singleton、VM 外挂 sidecar registry 与未类型化 metadata 字段 MUST NOT 成为这些状态的唯一主真相源。

#### Scenario: 关键 session 状态不能只存在于 singleton 或 metadata 杂项字段
- **GIVEN** runtime 暴露 background tasks、autonomy ownership、actor-fiber bindings、deferred resumes 或其他关键 session 运行态
- **WHEN** 系统持久化、恢复或查询该 session
- **THEN** 这些状态 MUST 可从 `AiAgentVm`、`AiAgentActor`、`FiberSnapshot`、actor transcript 或绑定到当前 `AiAgentVm` 的 typed runtime context 推导
- **AND** 系统 MUST NOT 要求 process-global singleton、sidecar registry 或 metadata 魔法字段作为唯一真相源

#### Scenario: actor-owned state 仍由 actor 真相源驱动
- **GIVEN** teammate、coordination、questionnaire 或消息可见性依赖 actor 当前状态
- **WHEN** 系统恢复 actor 或投影查询视图
- **THEN** actor-owned state MUST 从当前 actor 真相源读取
- **AND** projection 或 cache 层 MUST NOT 变成可独立演化的长期真相源

### Requirement: Actor durable snapshot
系统 MUST 为每个 actor 提供 durable snapshot，完整覆盖该 actor 中所有可持久化字段。

#### Scenario: actor durable fields 被完整保存
- **GIVEN** actor 具有身份、systemPrompts、tool policy、coordination state、task tree、pending questionnaires 与 all mailboxes 等 durable data
- **WHEN** 系统写入 actor snapshot
- **THEN** 系统 MUST 保存这些 durable fields
- **AND** 恢复后这些字段与退出前保持一致

#### Scenario: actor process-only fields 不进入 snapshot
- **GIVEN** actor 同时包含 `llmClient`、`stream`、`llmAbortController`、`callbacks`、`logger` 等 process-only fields
- **WHEN** 系统写入 actor snapshot
- **THEN** 系统 MUST NOT 直接序列化这些字段
- **AND** 这些字段应在恢复时由 runtime bootstrap 重新装配

#### Scenario: holon actor snapshot 使用统一 holonState
- **GIVEN** 当前组织 actor 已统一为 `identity.kind = "holon"`
- **WHEN** 系统写入 actor snapshot
- **THEN** holon actor durable state MUST 写入统一的 `holonState`
- **AND** governance-specific 差异 MUST 通过 `governance` 与 `holonId` 表达

### Requirement: All actor mailboxes durability
系统 MUST 持久化每个 actor 的全部 mailboxes，而不是只持久化特定业务 inbox。

#### Scenario: 全 mailbox 被序列化
- **GIVEN** actor 拥有 `control`、`childDone`、`coordination`、`memberInbox`、`humanInput`、`toolResult`、`aiGenerated` 等 mailboxes
- **WHEN** 系统写入 actor snapshot
- **THEN** 系统 MUST 序列化所有 mailbox 的当前队列内容

#### Scenario: mailbox 在恢复后保持顺序
- **GIVEN** 某 actor 的 mailbox 中存在多条待消费消息
- **WHEN** session 被恢复
- **THEN** 系统 MUST 恢复这些消息
- **AND** 同一 mailbox 内的消费顺序 MUST 与持久化前一致

#### Scenario: 恢复后 actor 仍可从 mailbox drain
- **GIVEN** actor 的 mailbox 已被恢复
- **WHEN** runtime 重新调度该 actor
- **THEN** actor MUST 能按既有 `drainMailbox(...)` 语义继续消费恢复后的消息

### Requirement: Actor message history is recovered from actor-scoped transcript
系统 MUST 将每个 actor 的非 system `ChatMessage` 历史保存在 actor-scoped transcript 中，并在恢复时通过 transcript reducer 重建 `AiAgentActor.messages`。

#### Scenario: 每个 actor 拥有独立 transcript 文件
- **GIVEN** session 中存在 primary actor、subagent tool/task agent 或 teammate
- **WHEN** 系统持久化该 actor 的消息历史
- **THEN** 系统 MUST 将 transcript 写入该 actor 对应的 session 目录
- **AND** transcript 路径 MUST 与 actor 身份稳定对应

#### Scenario: transcript 不包含 system prompts
- **GIVEN** actor 同时具有 `systemPrompts` 与普通 `ChatMessage` 历史
- **WHEN** 系统写入 transcript
- **THEN** transcript MUST NOT 直接写入 system prompts
- **AND** `systemPrompts` MUST 继续由 actor durable state 单独持久化

#### Scenario: 恢复时由 transcript reducer 重建 messages
- **GIVEN** session 已存在 actor transcript
- **WHEN** 系统恢复该 actor
- **THEN** 系统 MUST 先解析 transcript
- **AND** 系统 MUST 将 transcript 记录加工为 `ChatMessage[]`
- **AND** `AiAgentActor.messages` MUST 以该 reducer 结果为主恢复源

#### Scenario: transcript 缺失时不得回退到 snapshot messages
- **GIVEN** actor transcript 与 legacy message history 都不存在
- **WHEN** 系统恢复该 actor 的消息历史
- **THEN** 系统 MUST NOT 将 actor 或 fiber snapshot 中的旧消息副本当作新的 `AiAgentActor.messages` 真相源
- **AND** 系统 MUST 以空消息历史或显式兼容路径结果完成保守恢复

#### Scenario: transcript 尾部损坏时保守降级
- **GIVEN** actor transcript 的尾部存在不完整或损坏记录
- **WHEN** 系统恢复该 actor 的消息历史
- **THEN** 系统 MUST 尽可能保留可解析的最大良构前缀
- **AND** 系统 MUST NOT 因尾部损坏而导致整个 session 恢复失败

#### Scenario: transcript 中的半条 tool 或 questionnaire 记录按保守规则降级
- **GIVEN** actor transcript 中存在 marker 缺失、半条 tool call、`tool_call_error` 或被中断的 questionnaire 记录
- **WHEN** 系统将 transcript reducer 为 `ChatMessage[]`
- **THEN** 系统 MUST 应用确定性的保守降级规则
- **AND** 降级后的消息历史 MUST 仍可被恢复与查询

#### Scenario: legacy layout 与新 actor transcript layout 保持兼容恢复
- **GIVEN** session 中存在旧 `message_history` 布局或 old/new layout 混合目录
- **WHEN** 系统恢复 actor 消息历史
- **THEN** 系统 MUST 使用定义明确的兼容路径恢复可恢复历史
- **AND** 兼容恢复 MUST NOT 静默丢弃本可恢复的历史消息

### Requirement: Fiber scheduling metadata durability
系统 MUST 为每个 fiber 持久化可安全恢复的调度态元数据，但 MUST NOT 伪装成 instruction-pointer 级恢复。

#### Scenario: fiber 调度态元数据被保存
- **GIVEN** fiber 具有 `fiberId`、`actorKey`、`lane`、`status`、`parentFiberId`、`workloadKind`、`waitingReason` 等调度态信息
- **WHEN** 系统写入 fiber snapshot
- **THEN** 系统 MUST 保存这些调度态元数据

#### Scenario: actor 与 fiber 的绑定关系可恢复
- **GIVEN** actor 与 fiber 在退出前已建立绑定关系
- **WHEN** session 被恢复
- **THEN** 系统 MUST 恢复 actor ↔ fiber binding
- **AND** 调度器后续可据此从安全边界重新推进

#### Scenario: 不恢复 instruction pointer
- **GIVEN** 进程退出前 fiber 正处于某个 in-flight LLM、tool 或 bash 执行边界
- **WHEN** session 被恢复
- **THEN** 系统 MUST NOT 伪装恢复到该执行点
- **AND** 系统只恢复安全的调度态元数据

### Requirement: Background task state derives from actor/fiber snapshot
系统 MUST 让 background task 的恢复建立在 actor/fiber snapshot 之上；未完成 background task 统一恢复为 `interrupted`。

#### Scenario: 已完成任务保持终态
- **GIVEN** 某 background task 在退出前已处于 `completed|failed|cancelled`
- **WHEN** session 被恢复
- **THEN** 系统 MUST 保持其终态不变

#### Scenario: 未完成任务恢复为 interrupted
- **GIVEN** 某 background task 在退出前处于 `pending|running|suspended`
- **WHEN** session 被恢复
- **THEN** 系统 MUST 将其恢复为 `interrupted`
- **AND** 系统 MUST NOT 自动重新执行该任务

#### Scenario: terminal background task 在 indexes 缺失时仍可从主快照恢复
- **GIVEN** 某 background task 在退出前已处于 `completed|failed|cancelled`
- **AND** session 的 derived indexes 缺失、损坏或过期
- **WHEN** 系统恢复该 session
- **THEN** 系统 MUST 从主快照恢复该 task 的 terminal state
- **AND** 系统 MUST NOT 依赖 derived indexes 作为该 terminal state 的唯一恢复输入

### Requirement: Team state derives from actor snapshot
系统 MUST 让 team roster、teammate status、未读消息与最近结果可见性建立在 actor snapshot 之上，而不是单独维护一套脱节的恢复模型。

#### Scenario: teammate roster 从 actor snapshot 恢复
- **GIVEN** session 中存在多个 teammate actors
- **WHEN** session 被恢复
- **THEN** 系统 MUST 从 actor snapshot 恢复 roster 可见性
- **AND** 用户通过 team 相关工具或 TUI 能再次看到这些 teammate

#### Scenario: teammate mailbox 恢复未消费消息
- **GIVEN** teammate actor 的 mailbox 中存在待消费消息
- **WHEN** session 被恢复
- **THEN** 系统 MUST 恢复这些 mailbox 消息
- **AND** teammate 后续执行时仍能按 mailbox 语义 drain 到这些消息

#### Scenario: team 查询在多 session 并存时不串读
- **GIVEN** 两个不同 session 在同一进程中各自拥有 teammate actors
- **WHEN** 用户在其中一个 session 查询 `/team list` 或 `/team status`
- **THEN** 系统 MUST 只返回当前 session 的 teammates
- **AND** 系统 MUST NOT 从其他 session 的 roster 投影出结果

#### Scenario: 恢复后 teammate 可见视图持续跟随 actor 当前输出
- **GIVEN** session 已恢复，且 teammate actor 在恢复后继续产生新的 assistant 输出
- **WHEN** 用户再次查询 `/team status` 或 TUI 渲染 teammate 视图
- **THEN** 系统 MUST 反映该 actor 的最新可见结果
- **AND** 系统 MUST NOT 长期停留在恢复时刻的消息副本上

### Requirement: Coordination and autonomy state derive from actor/vm snapshot
系统 MUST 让 coordination records 与 autonomy metadata 的恢复建立在 actor snapshot、fiber snapshot 与 VM durable subset 之上。

#### Scenario: 恢复 shutdown / plan approval 记录
- **GIVEN** actor 在退出前持有 shutdown 或 plan approval 的 coordination 状态
- **WHEN** session 被恢复
- **THEN** 系统 MUST 恢复 request_id、状态与关键决策信息
- **AND** coordination 状态查询工具可返回恢复后的结果

#### Scenario: 恢复 autonomy metadata
- **GIVEN** VM 或 actor/fiber snapshot 中存在 autonomy 配置、worker metadata、task ownership metadata
- **WHEN** session 被恢复
- **THEN** 系统 MUST 恢复这些 autonomy metadata
- **AND** 系统 MUST NOT 假装恢复 in-flight autonomy 执行步骤

#### Scenario: coordination 查询与恢复在多 session 并存时保持隔离
- **GIVEN** 两个不同 session 在同一进程中各自拥有 coordination records
- **WHEN** 用户在其中一个 session 查询 `/coordination status` 或 `/shutdown-status`，或系统恢复其中一个 session
- **THEN** 系统 MUST 只读取当前 session 的 coordination state
- **AND** 系统 MUST NOT 采用跨 session 的 existing-plus-restored merge 作为恢复语义

#### Scenario: autonomy claim 只作用于当前 session roster
- **GIVEN** 两个不同 session 在同一进程中各自拥有 autonomy workers
- **WHEN** autonomy controller 在其中一个 session 中为任务选择 teammate
- **THEN** 系统 MUST 只从当前 session 的 roster 中选择 worker
- **AND** 该任务 MUST NOT 被派发到另一个 session 的 teammate

#### Scenario: autonomy dispatch 可仅凭任务描述创建并派发任务
- **GIVEN** 当前 session 已存在至少一个 autonomy teammate
- **WHEN** 用户通过显式 autonomy dispatch 入口提交一段自然语言任务描述
- **THEN** 系统 MUST 能在当前 session 中创建新的 pending task，而不要求用户预先知道 task_id
- **AND** 系统 MUST 将该任务交给当前 session 的 autonomy 流程推进，而不是默认让主 agent 直接接手执行

#### Scenario: slash spawn shorthand 可按 lane 创建 team 或 autonomy teammate
- **GIVEN** 当前 session 已加载可用的 agent config，且用户不希望重复输入 role / agent_type 样板
- **WHEN** 用户使用 `/team spawn-leader <name> [@agent_name] [:: <prompt>]`、`/team spawn-worker <name> [@agent_name] [:: <prompt>]`、`/autonomy spawn-leader [name] [@agent_name] [:: <prompt>]` 或 `/autonomy spawn-worker [name] [@agent_name] [:: <prompt>]`
- **THEN** 系统 MUST 将其映射为显式 `TeamSpawn` 参数，而不是要求用户手工拼装旧的 `<role> <agent_type>` 语法
- **AND** `/autonomy spawn-*` MUST 自动使用 `lane=autonomy` 与 `share_task_tree=true`
- **AND** 省略 `@agent_name` 时 MUST 默认使用 `agent_type=code`
- **AND** 省略 `:: <prompt>` 时 MUST 仍能创建 teammate，并将初始 prompt 视为空字符串

### Requirement: Conservative recovery bootstrap
系统 MUST 在恢复时采用 conservative recovery：恢复可序列化运行态，但从安全边界重新装配 runtime。

#### Scenario: 先恢复 snapshots，再重装配 runtime handles
- **GIVEN** session 已存在 VM、actor、fiber snapshots
- **WHEN** runtime bootstrap 恢复该 session
- **THEN** 系统 MUST 先恢复 durable snapshots
- **AND** 再重建 event bus、callbacks、effects、LLM client、actor runtime 等 process-local handles

#### Scenario: 恢复后从安全边界继续调度
- **GIVEN** session 已恢复 actor 与 fiber snapshots
- **WHEN** orchestrator 开始重新运行
- **THEN** 系统 MUST 从安全边界重新创建可运行调度态
- **AND** 系统 MUST NOT 依赖 continuation 级恢复

#### Scenario: 当前恢复只接受 current snapshot schema 与 split layout
- **GIVEN** runtime snapshot repository 负责加载 manifest、VM、actor 与 fiber snapshots
- **WHEN** 系统恢复 session
- **THEN** 系统 MUST 只接受当前 schema version 与当前 split actor snapshot layout
- **AND** manifest MUST 提供当前 `actorFiles / fiberFiles / indexFiles`
- **AND** runtime MUST NOT 为历史命名或历史文件布局长期保留专门兼容分支

### Requirement: Recovered state visibility in tools and TUI
系统 MUST 让恢复后的 durable runtime state 可被现有 tools 和 TUI 读取与展示。

#### Scenario: 恢复后 team/bg/coordination/autonomy 状态可查询
- **GIVEN** session 已恢复
- **WHEN** 用户使用 `/team list`、`/team status`、`/bg list`、`/bg status`、`/coordination status`、`/autonomy status`
- **THEN** 系统 MUST 返回由恢复后的 runtime snapshot 投影出的状态
- **AND** 返回结果应与持久化快照一致

#### Scenario: derived indexes 缺失时仍可从主快照重建状态
- **GIVEN** session 的 derived indexes 缺失、损坏或过期
- **WHEN** 系统恢复该 session
- **THEN** 系统 MUST 仍可从 VM snapshot、actor snapshot、fiber snapshot 与 actor transcript 重建 team/bg/coordination/autonomy 状态
- **AND** 系统 MUST NOT 因 indexes 缺失而静默丢失恢复后的可见状态

#### Scenario: 恢复后 runtime 继续推进时查询视图保持同步
- **GIVEN** session 已恢复，且恢复后的 actor、fiber 或 VM 状态在运行中继续推进
- **WHEN** 用户再次通过 tools 或 TUI 查询 team、background、coordination 或 autonomy 状态
- **THEN** 系统 MUST 返回与当前 actor/vm/fiber 真相一致的投影视图
- **AND** projection 或 cache MUST NOT 长期停留在 recovery-time snapshot 上

#### Scenario: snapshot 保存不得反复全量重写 actor transcript
- **GIVEN** actor transcript 已通过 append-only message history 写入到 `actors/<actor>/transcript.txt`
- **WHEN** 系统因前台 turn、后台 pump 或 autonomy tick 再次保存 runtime snapshot
- **THEN** 系统 MUST NOT 为了保存 snapshot 而全量覆盖该 transcript
- **AND** 现有 transcript marker / 记录顺序 MUST NOT 因 snapshot 保存而无关漂移

### Requirement: Recovery Must Restore Runtime Context Control State
系统 MUST 在恢复 runtime 时一并恢复正式的 work context、continuation baseline 与相关 prompt truth metadata，而不是只恢复旧快照视图。

#### Scenario: Recovery restores work context and continuation baseline from prompt truth metadata
- **GIVEN** conversation prompt truth metadata 中已记录 `work_mode`、`task_phase`、continuation baseline 与相关 compaction metadata
- **WHEN** 系统执行 session recovery
- **THEN** 系统 MUST 将这些 context-control 状态回填到恢复后的 actor/runtime 状态
- **AND** 恢复后的继续执行路径 MUST 与当前 prompt truth 保持一致，而不是回退到陈旧 snapshot 偏见
