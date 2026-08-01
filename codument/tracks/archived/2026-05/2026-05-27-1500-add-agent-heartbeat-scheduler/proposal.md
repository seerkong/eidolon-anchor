# 变更：添加 Agent Heartbeat Scheduler

## 背景和动机 (Context And Why)

当前 agent 在等待后台 bash、detached task、外部状态变化或周期性自检时，容易退化为阻塞式 `sleep`、轮询循环或长时间占用一次 LLM 调用轮次。用户希望实现 heartbeat 功能，在本项目中加入同等的非阻塞 heartbeat/timer 机制：创建后当前 turn 可以结束，runtime 在到期后再唤醒 actor/fiber 执行后续工作。

## “要做”和“不做” (Goals / Non-Goals)

**目标:**
- 新增 Agent Heartbeat Scheduler 能力，用于创建一次性 timeout 与周期性 interval。
- 提供 `create_timeout`、`create_interval`、`list_schedules`、`cancel_schedule` 工具/API。
- 创建 timeout / interval 时强制提供 `name` 与详细 `description`，使未来唤醒具备人类可读目的、检查动作与停止条件。
- 调度触发时通过 actor mailbox 与 depa-actor fiber orchestration 主链进入新的 actor turn。
- 调度项持久化为 session-scoped runtime state，支持单机恢复、missed-fire 策略与终态查询。
- 加入最小/最大间隔、active 数量上限、`max_fires`、重复触发保护与 diagnostics。
- 通过既有 observability/runtime history surface 记录 create/fire/cancel/skip/fail/recover 事实。

**非目标:**
- 不实现分布式 scheduler 或跨机器高可用定时服务。
- 不实现 cron 表达式、复杂日历调度、时区窗口或 UI 管理页面。
- 不让 LLM 自身长期驻留、sleep 或后台思考。
- 不把所有确定性轮询都交给 LLM；能由脚本或后台进程完成的检查仍应优先由脚本/后台任务完成。
- 不破坏现有 actor/fiber orchestration、snapshot recovery、tool policy 与 terminal runtime 行为。

## 变更内容（What Changes）

- 新增 heartbeat schedule contract，覆盖 `timeout`、`interval`、状态机、wake payload、fire token、owner/target actor、创建/取消/恢复元数据。
- 扩展 actor mailbox 或 control item schema，支持结构化 heartbeat wake item，并明确其优先级和调度语义。
- 在 runtime/organ logic 中新增 scheduler runtime 与 session-scoped store，支持 create/list/cancel/tick/fire/recover。
- 将 scheduler tick 接入 actor mailbox 与 orchestrator driver，确保到期后进入新 actor/fiber turn，而不是直接调用模型。
- 注册 built-in heartbeat 工具，并在 tool policy / executor 层做可见性过滤和 stale tool call 防御。
- 为 schedule 生命周期写入 observability facts、runtime history 或 diagnostics。
- 增加单元测试、集成测试和一份使用说明，覆盖后台检查、timeout 链式退避、interval 周期检查、list/cancel 与成本注意事项。
- 无 **BREAKING** 变更；新增能力应保持默认兼容，未启用工具或无 active schedule 时不改变现有路径。

## 影响范围（Impact）

- 受影响的功能规范：新增 `agent-heartbeat-scheduler` 能力；关联 `aiagent-fiber-orchestration`、`aiagent-persistence-recovery`、`ai-runtime-observability-rx-sinks`、`ai-agent-vm-runtime-shape`、`detached-actor-observability`。
- 受影响的代码区域：`cell/packages/ai-core-contract` runtime contract、`cell/packages/ai-core-logic` runtime/actor/snapshot、`cell/packages/ai-organ-logic` scheduler/tool/orchestrator/persistence/observability、`terminal/packages` runtime bridge 与相关测试。
- 用户可见影响：agent 可用非阻塞 timeout/interval 等待后台任务或周期检查，并可查询、取消当前调度项。
