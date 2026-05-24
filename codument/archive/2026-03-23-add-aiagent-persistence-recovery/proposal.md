# 变更：为 AIAgent 增加 Actor-centric 持久化与保守恢复

## 背景和动机

`add-aiagent-background-teams-protocols-autonomy` 已经补齐了：

- background tasks
- agent teams
- team protocols
- autonomy runner
- `orchestration_history.txt` 审计日志

但该 Track 明确排除了“进程重启后的恢复”。当前一旦进程退出，AIAgent runtime 中绝大多数运行态都会丢失。

上一版 persistence 设计偏向“几个业务模块的 metadata 持久化”，例如：

- teammate roster
- teammate inbox
- background task metadata
- protocol records
- autonomy metadata

这不够符合当前系统的抽象边界。根据 `vendor/depa-actor/ACTOR-FOR-AI-AGENTS.md` 中已经明确的心智模型：

- actor 负责状态归属、mailbox、身份边界、控制语义
- fiber 负责调度推进、挂起恢复、执行时机
- workload 负责具体运行的任务类型

因此本 Track 需要升级为 **Actor-centric snapshot + Fiber scheduling snapshot + Vm durable subset**，而不是继续只做零散的业务特例持久化。

首轮实现与修复后，核心能力已经基本落地：

- transcript-first message recovery
- actor/fiber snapshot 去消息化
- derived indexes 降级为 projection/cache
- unfinished background task -> `interrupted`

但 post-review 表明该 Track 还没有完全收口。当前仍存在几类残留问题：

- team / autonomy / protocol 仍有 process-scoped 单例语义残留
- 恢复后的 teammate 可见视图仍可能停留在旧消息副本
- 若干 session runtime state 仍通过 VM 外挂 registry 或 metadata 魔法字段持有
- transcript 边界降级与 background terminal state 的恢复证明仍不充分

因此本 Track 的目标不只是“让恢复能工作”，还需要把 **strict session-scoped semantics + single source of truth + DOP state ownership** 收口到位。

## 当前同步状态

- 该 track 的补充收口已在当前 track 内继续完成，没有新开 follow-up track。
- `plan.xml` 中的 `P15` 与 `P16` 已完成：
  - `P15`：收口 stale background index fallback 与 team activity timestamp
  - `P16`：收口 transcript 单源化、typed recovery report、schema contract 与 `logs/` 日志布局
- 当前实现与设计主轴已基本对齐；执行状态以 `plan.xml` 为准。
- 在 `P17` 的 natural-language autonomy dispatch 之外，本轮还继续收口 spawn UX：
  - 新增 `/autonomy spawn-leader|spawn-worker [name] [@agent_name] [:: <prompt>]`
  - 新增 `/team spawn-leader|spawn-worker <name> [@agent_name] [:: <prompt>]`
  - `@agent_name` 作为已加载 agent config 的显式选择器，省略时默认回落到 `code`

## 用户确认的关键决策

- unfinished background task：统一标记为 `interrupted`，不自动恢复执行
- teammate 未读消息：必须恢复
- durable state scope：严格 `session-scoped`
- 持久化应尽量面向数据建模：actor 中可持久化的数据要整体考虑，AiAgentVm 中可持久化的数据也要一起设计
- 恢复目标是“完整恢复可序列化运行态”，不是恢复到某个 in-flight LLM stream 的半中间状态

## 目标 / 非目标

**目标**
- 为每个 session 提供 durable runtime snapshot store
- 持久化 `AiAgentVm` 中可序列化、可恢复的 durable subset
- 持久化每个 actor 的 durable state，而不是只持久化 `teammate inbox`
- 持久化每个 actor 的全部 mailboxes
- 持久化 fiber 的调度态元数据，并恢复 actor ↔ fiber 的绑定关系
- 恢复 team/background/protocol/autonomy 等上层能力，但恢复源来自 actor/vm/fiber snapshot，而不是分散的 ad-hoc 结构
- 重启后从安全边界重建运行时，并在 tools / TUI 中暴露恢复后的状态
- 收口 team / autonomy / protocol 的严格 session-scoped 查询、恢复与调度语义
- 收口恢复后 team / TUI 可见视图，使其持续派生自 actor / vm 当前真相源，而不是恢复时刻的副本
- 将关键 session runtime state 收敛到 `AiAgentVm` / `AiAgentActor` 或显式 typed runtime context，避免 module singleton、VM 外挂 registry 与 metadata 魔法字段继续充当主真相源
- 补齐 transcript 边界降级、mixed-layout 兼容与 indexes 缺失时 background terminal state 的恢复证明

**非目标**
- 不做 instruction-pointer / continuation 级恢复
- 不恢复 in-flight LLM stream、tool stream、bash 执行现场
- 不自动 replay 外部副作用
- 不做 process-global durability
- 不把 `orchestration_history.txt` 当作恢复主数据源
- 不对所有 runtime service object 做无差别重写；仅收口与 session truth source、查询边界和恢复语义直接相关的状态承载点

## 核心设计转向

本 Track 的最关键变化是：

- 从“业务模块 metadata durability”
- 调整为“runtime durable snapshot”

即恢复主对象变成三层：

1. `AiAgentVmSnapshot`
2. `ActorSnapshot[]`
3. `FiberSnapshot[]`

其中：

- mailbox 属于 actor
- fiber 保存调度态与 actor 绑定关系
- 上层 team/background/protocol/autonomy 只是这些 snapshot 的投影视图

## 第一里程碑定义

第一里程碑的恢复语义是：

- 恢复 actor 的 durable state
- 恢复 actor 的全部 mailboxes
- 恢复 fiber 的调度态元数据
- 恢复 `AiAgentVm` 的 durable subset
- 从安全边界重新调度

但不做：

- LLM 半流式中断点恢复
- tool 执行现场恢复
- bash 子进程现场恢复

换句话说，系统重启后：

- actor 作为实体完整恢复
- mailbox 消息完整恢复
- fiber 作为调度对象被保守重建
- unfinished background task 仍标记为 `interrupted`
- protocol/autonomy/team/bg 状态以 snapshot 投影的形式恢复可见

第一里程碑补充收口要求：

- team / autonomy / protocol 的恢复与查询路径必须严格绑定当前 session
- projection/cache 不能继续持有独立演化的长期真相源
- 恢复后 runtime 继续推进时，可见状态必须与 actor/vm/fiber 当前真相保持同步
- indexes 缺失、transcript 损坏或兼容布局混合时，系统仍需给出定义明确的保守恢复行为

## 本次补充收口范围

本次补充收口纳入范围：

- team / autonomy / protocol 的 session-scoped 语义收口
- teammate / TUI 可见视图与 actor 真相源同步
- `BackgroundTaskRegistry`、runtime metadata 等隐藏状态承载点的 DOP 边界收口
- transcript / compat / indexes-missing 边界恢复证明补齐

本次补充收口不纳入范围：

- exact resume / continuation 级恢复
- 全量重写所有 runtime service object
- 将 projection/cache 提升为新的 durable truth source

## 变更内容

- 新增 session-scoped runtime snapshot store
- 新增 `AiAgentVmSnapshot` / `ActorSnapshot` / `FiberSnapshot` schema
- 为 actor 增加 durable serialization / hydration 能力
- 为 orchestrator runtime 增加 fiber scheduling snapshot / hydration 能力
- 将 team/background/protocol/autonomy 的恢复建立在 runtime snapshot 之上
- 启动时执行 recovery bootstrap：先恢复 VM/actors/fibers，再恢复 runtime indices
- TUI / tools 读取恢复后的 actor/fiber/vm 投影状态
- 将 team / autonomy / protocol 的查询、恢复与调度路径收口到当前 `AiAgentVm` 上下文
- 收口 roster / view 的消息可见性来源，避免长期依赖独立 `messages` 副本
- 补齐 transcript 降级、旧布局兼容与 background terminal state 无 indexes 恢复测试
- 逐步消除 module singleton、sidecar registry 与 metadata 魔法字段作为主真相源的残留用法

## 影响范围

- `backend/packages/core/src/modules/AIAgent/runtime/runtime.ts`
- `backend/packages/core/src/modules/AIAgent/runtime/actor.ts`
- `backend/packages/organ/src/AIAgent/OrchestratorDriver.ts`
- `backend/packages/organ/src/AIAgent/team/TeamManager.ts`
- `backend/packages/organ/src/AIAgent/background/BackgroundTaskRegistry.ts`
- `backend/packages/organ/src/AIAgent/protocol/ProtocolEngine.ts`
- `backend/packages/organ/src/AIAgent/autonomy/AutonomyRunner.ts`
- `backend/packages/organ/src/AIAgent/agent/SubAgent.ts`
- `backend/packages/core/src/modules/AIAgent/runtime/*`
- `backend/packages/composer/src/modules/AIAgent/tools/_primaryRuntime.ts`
- `terminal/packages/tui/src/runtime/TuiRuntime.ts`
- `terminal/packages/tui/src/runtime/TuiSdkFacade.ts`
- `terminal/packages/minimal/src/app.ts`

## 风险

- actor 全 mailbox 持久化后，恢复边界将从“业务状态”升级为“runtime state”，实现复杂度明显上升
- `AiAgentVm` 中可持久化与不可持久化字段必须严格区分，否则容易把 callback / effect / client handle 错误写入 snapshot
- fiber snapshot 若建模过深，容易误导为 exact resume；需要明确它只保存调度态而非 continuation
- 如果 team / autonomy / protocol 继续残留 process-scoped 读取路径，多 session 并存与顺序恢复仍会串写 / 串读
- 如果 projection/view 继续持有独立副本，恢复后查询结果会与 runtime 实际推进分叉
- 如果 `BackgroundTaskRegistry` / metadata 魔法字段继续扩散，后续恢复、调试和架构演进都会持续依赖隐式状态

## 推荐实施策略

- 先收敛 durable schema：`vm / actors / fibers / indexes`
- 先实现 actor-centric snapshot，不再把 `teammate inbox` 当作唯一重点
- 坚持 side-effect `no_replay`
- 使用 snapshot 作为恢复主数据源，日志继续只用于审计
- 在此基础上继续收口 team / autonomy / protocol 的 session-bound service access
- 将恢复后可见视图统一回收到 actor / vm / fiber 的单一真相源
- 用多 session、损坏 transcript、无 indexes terminal state 等回归测试证明恢复语义已闭环
