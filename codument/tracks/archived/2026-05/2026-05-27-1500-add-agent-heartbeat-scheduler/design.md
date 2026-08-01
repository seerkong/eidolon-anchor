# 设计：Agent Heartbeat Scheduler

## 上下文

本项目已有 `AiAgentVm`、`AiAgentActor`、depa-actor fiber orchestration、session snapshot recovery、observability Rx streams、terminal runtime bridge 与 built-in tool registry。Heartbeat 机制应作为 runtime 调度能力接入这些主链，而不是新增一套平行 agent loop，也不能在 shell 或 LLM turn 中 sleep。

用户要求在本项目中加入与源 commit heartbeat track 同等的能力。这里的“同等”定义为：提供 setTimeout/setInterval 风格非阻塞唤醒、list/cancel、可审计元数据、单机恢复、工具暴露策略、安全限制、trace/diagnostics 与测试文档。

## 方案概览

1. Contract 层新增 heartbeat 类型
  - 在 runtime contract 中定义 `HeartbeatSchedule`、`HeartbeatScheduleKind`、`HeartbeatScheduleStatus`、`HeartbeatWakePayload`、创建/list/cancel 输入输出与错误类型。
  - schedule 字段包含 `scheduleId`、`kind`、`name`、`description`、`ownerActorKey/id`、`targetActorKey/id`、`status`、`createdAt`、`updatedAt`、`nextFireAt`、`delaySeconds`、`intervalSeconds`、`fireCount`、`maxFires`、`lastFireAt`、`cancelledAt`、`cancelReason`、`message`、`payload`、`version`、`lastFireToken`。
  - `name` 和 `description` 为必填；`description` 必须能说明唤醒目的、检查动作、完成条件或停止条件。

2. Actor mailbox / control schema 增加 heartbeat wake
  - 推荐新增 `heartbeatWake` mailbox queue，优先级低于 `control` / `childDone`，高于普通 `humanInput`。
  - wake item 携带 `scheduleId`、`kind`、`name`、`description`、`message`、`payload`、`fireCount`、`firedAt`。
  - actor 执行器在 materialize turn input 时，把 heartbeat wake 转成清晰的 system/user-like 输入，保留目的、上下文与停止条件。

3. VM runtime context 挂载 scheduler runtime
  - 在 `VmRuntimeContext` 或 VM facet 中增加 session-scoped heartbeat runtime/store 入口。
  - 避免 process-global singleton 成为唯一真相源；同一进程多 session 并存时，schedule 查询与触发只作用于当前 VM/session。
  - runtime store 支持 in-memory 操作，snapshot/persistence 层负责 durable save/load。

4. Scheduler core
  - 实现 `createTimeout`、`createInterval`、`listSchedules`、`cancelSchedule`、`tickDueSchedules`、`recoverSchedules`。
  - create 阶段校验 name/description、delay/interval 范围、active 配额、target actor 存在性与 max_fires。
  - tick 阶段扫描到期 schedule，通过 version/fire token 进入 firing attempt，投递 wake item 后更新状态。
  - timeout 成功投递后 completed；interval 成功投递后增加 fire_count 并计算 next_fire_at，到达 max_fires 后 completed/expired。

5. Orchestrator 集成
  - scheduler 不直接调用模型。
  - 到期后向目标 actor mailbox 投递 wake item，并通过 orchestrator driver 的 resume/tick 路径推进。
  - 若目标 actor 正在 foreground active turn 或同一 schedule 已有 pending wake，采用 defer/coalesce 策略并记录 diagnostics。
  - terminal runtime 或 shell facade 在每次 turn 结束、runtime bootstrap/recovery 后启动或触发 scheduler worker/tick。

6. 持久化与恢复
  - 第一阶段使用 session-scoped durable state；可落在 VM snapshot durable subset 或独立 heartbeat state 文件，但恢复入口必须绑定当前 session。
  - 恢复 pending timeout：未过期则恢复 next fire，已过期则按 missed-fire 策略 skip+diagnostics 或触发一次，默认优先保守 skip+diagnostics。
  - 恢复 active interval：计算下一次 future fire，不无限补发 missed ticks。
  - terminal/completed/cancelled/expired 可保留用于 list history 与 diagnostics，默认 list 隐藏。

7. Built-in tools 与执行策略
  - 新增 `create_timeout`、`create_interval`、`list_schedules`、`cancel_schedule` tool defs 与 tool funcs。
  - 工具注册接入 built-in tool 列表和 `ToolFuncRegistry`。
  - `actor.toolPolicy`、computed disabled tools 或等价上下文策略控制工具可见性；executor 对 stale tool call 再做防御性拒绝。
  - 默认建议后台/detached/明确允许的长期任务上下文可创建；前台 direct chat 至少允许 list/cancel，create 由 profile 或 tool policy 开启。

8. Observability 与 diagnostics
  - create/fire/defer/coalesce/cancel/complete/expire/fail/recover 写入统一 diagnostics。
  - 优先使用 VM observability private stream；必要时同时记录 orchestration history。
  - sink 失败不得影响 scheduler 状态转换和 actor 执行。

9. 文档与示例
  - 增加 heartbeat 使用说明，强调 LLM 不 sleep，runtime 负责未来唤醒。
  - 示例包含后台 build 检查、timeout 链式退避、interval 周期检查、list/cancel 与成本风险。

## 影响范围与修改点（Impact）

- Contract:
  - `cell/packages/ai-core-contract/src/runtime/AiAgentActor.ts`
  - `cell/packages/ai-core-contract/src/runtime/AiAgentVm.ts`
  - `cell/packages/ai-core-contract/src/runtime/RuntimeSnapshotTypes.ts`
  - 新增 heartbeat contract 文件并从 package surface 导出
- Core logic:
  - `cell/packages/ai-core-logic/src/runtime/actor.ts`
  - `cell/packages/ai-core-logic/src/runtime/runtime.ts`
  - `cell/packages/ai-core-logic/src/runtime/snapshot/*`
  - 新增 scheduler core/store helper
- Organ logic:
  - `cell/packages/ai-organ-logic/src/OrchestratorDriver.ts`
  - `cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts`
  - `cell/packages/ai-organ-logic/src/runtime/ShellRuntimeBootstrap.ts`
  - `cell/packages/ai-organ-logic/src/runtime/ShellRuntimeFacade.ts`
  - `cell/packages/ai-organ-logic/src/persistence/RuntimeSnapshots.ts`
  - `cell/packages/ai-organ-logic/src/composer/AIAgent/ToolFuncBuiltin.ts`
  - 新增 heartbeat tools、tool funcs、scheduler runtime ops
- Terminal/tests/docs:
  - `terminal/packages/organ/src/AIAgent/TerminalRuntime.ts`
  - `cell/packages/ai-organ-logic/tests/AIAgent/**`
  - `terminal/packages/**/tests/**`
  - 新增 heartbeat how-to 文档

## 决策摘要

- 当前关键结论：
  - 采用 `add-agent-heartbeat-scheduler` 作为 track ID。
  - 采用新增 `heartbeatWake` mailbox queue 作为首选设计；实现阶段如发现 depa-actor schema 约束更适合 control subtype，可在不改变外部行为的前提下用等价 control item 实现。
  - Scheduler store 必须 session-scoped，并可从 VM/session durable state 恢复；不得依赖 process-global singleton 作为唯一真相源。
  - 默认 `commit_mode=manual`，`validation_mode=yield-gap-loop`，仅最后 phase 后做 gap-loop 验证。

## 风险 / 权衡

- token 成本风险：interval 过短会反复唤醒模型。缓解：最小间隔、max_fires、active 配额、busy coalesce、list/cancel 可见。
- 重复触发风险：tick 重入或恢复扫描可能重复投递。缓解：version/fire token 和状态转换原子化。
- 调度绕行风险：scheduler 如果直接调用模型会破坏 fiber orchestration。缓解：强制 mailbox + orchestrator 主链。
- 恢复突发风险：重启后大量 missed ticks 可能集中触发。缓解：默认不无限补发，pending timeout 过期时保守 skip+diagnostics。
- 工具暴露风险：前台上下文不当创建 runaway interval。缓解：tool policy 过滤与 executor 防御性校验。

## 兼容性设计

- 无 active schedule 且未启用 heartbeat tools 时，现有 actor/fiber execution 行为不应变化。
- schedule store 字段新增应采用可选/默认值恢复策略，避免旧 snapshot 加载失败。
- 若 mailbox schema 增加 `heartbeatWake`，snapshot mailbox 序列化必须为缺失队列提供空数组默认值。
- 对 terminal/headless runtime，scheduler worker 应随 runtime dispose 清理，避免跨 session 泄漏。

## 迁移计划

1. 添加 contract 与测试，保证旧 actor snapshot 缺少 heartbeat 字段时仍可加载。
2. 添加 scheduler core/store 与单元测试。
3. 接入 actor mailbox、orchestrator tick 与 runtime bootstrap。
4. 注册工具并加工具策略测试。
5. 加入 persistence/recovery、observability、terminal smoke 和文档。

## 待解决问题

- 实现阶段需要基于 depa-actor mailbox API 确认 `heartbeatWake` queue 与 control subtype 的最小侵入实现方式。
- 实现阶段需要确认 schedule durable state 最终落入 VM snapshot 还是独立 session-scoped scheduler store；外部行为必须保持一致。
