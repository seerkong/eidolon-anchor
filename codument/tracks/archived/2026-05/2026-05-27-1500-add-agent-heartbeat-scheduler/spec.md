## ADDED Requirements

### Requirement: 系统必须提供非阻塞 Agent Heartbeat Scheduler
系统 SHALL 提供 Agent Heartbeat Scheduler，用于注册一次性 timeout 与周期性 interval，并在到期后触发新的 actor/fiber turn，而不是阻塞当前 LLM 调用轮次。

#### Scenario: timeout 创建后当前 turn 可结束
- **GIVEN** actor 正在等待后台任务、外部状态变化或未来检查点
- **WHEN** actor 创建一个 timeout
- **THEN** scheduler SHALL 记录该 timeout
- **AND** 创建 API SHALL 立即返回调度句柄
- **AND** 当前 LLM turn SHALL NOT 因等待该 timeout 而阻塞

#### Scenario: interval 创建后周期性触发
- **GIVEN** actor 需要周期性检查某项状态
- **WHEN** actor 创建一个 interval
- **THEN** scheduler SHALL 按配置间隔重复触发唤醒
- **AND** 每次触发 SHALL 进入新的 actor/fiber turn 或 mailbox item
- **AND** 当前 LLM turn SHALL NOT 通过 sleep 或 polling loop 保持占用

### Requirement: Timeout 创建 API 必须采用 setTimeout 风格
系统 SHALL 提供 `create_timeout` API，语义类似 JavaScript `setTimeout`：在指定延迟后触发一次唤醒事件。

#### Scenario: 创建合法 timeout
- **GIVEN** 调用方提供 `name`、`description`、`delay_seconds` 与唤醒 payload
- **WHEN** 调用 `create_timeout`
- **THEN** 系统 SHALL 创建一个 `timeout` 类型调度项
- **AND** 返回稳定 `schedule_id`
- **AND** 该调度项 SHALL 在触发一次后自动进入 completed 状态

#### Scenario: timeout 缺少名称或详细描述
- **GIVEN** 调用方未提供 `name`，或未提供足够说明唤醒目的、检查动作、完成条件的 `description`
- **WHEN** 调用 `create_timeout`
- **THEN** 系统 SHALL 拒绝创建
- **AND** 返回明确的参数错误
- **AND** 不得产生半创建的调度项

### Requirement: Interval 创建 API 必须采用 setInterval 风格
系统 SHALL 提供 `create_interval` API，语义类似 JavaScript `setInterval`：按固定间隔重复触发唤醒事件，直到被取消、完成、过期或达到系统限制。

#### Scenario: 创建合法 interval
- **GIVEN** 调用方提供 `name`、`description`、`interval_seconds` 与唤醒 payload
- **WHEN** 调用 `create_interval`
- **THEN** 系统 SHALL 创建一个 `interval` 类型调度项
- **AND** 返回稳定 `schedule_id`
- **AND** 该调度项 SHALL 在每个间隔到期时触发一次唤醒

#### Scenario: interval 参数非法
- **GIVEN** 调用方缺少 `name` 或 `description`，或提供超出系统允许范围的 `interval_seconds`
- **WHEN** 调用 `create_interval`
- **THEN** 系统 SHALL 拒绝创建
- **AND** 错误信息 SHALL 说明缺失字段或允许的时间范围
- **AND** 不得产生半创建的调度项

### Requirement: 调度项必须包含可审计元数据
系统 SHALL 为每个 timeout / interval 保存可审计元数据，至少包含 id、kind、name、description、owner actor、target actor、状态、创建时间、下次触发时间、触发次数与取消信息。

#### Scenario: list 返回 timeout 与 interval 元数据
- **GIVEN** scheduler 中存在 pending timeout 与 active interval
- **WHEN** 调用 `list_schedules`
- **THEN** 返回结果 SHALL 同时包含 timeout 与 interval 列表
- **AND** 每个条目 SHALL 包含 `schedule_id`、`kind`、`name`、`description`、`status`、`next_fire_at` 与 `fire_count`

#### Scenario: 默认列表隐藏终态项
- **GIVEN** scheduler 中存在 active、cancelled、completed 与 expired 调度项
- **WHEN** 调用 `list_schedules` 且未要求包含历史项
- **THEN** 系统 SHALL 默认只返回未终止的调度项
- **AND** 调用方 SHALL 能通过参数请求包含 cancelled / completed / expired 历史项

### Requirement: 系统必须提供 cancel API
系统 SHALL 提供 `cancel_schedule` API，用于按 `schedule_id` 取消 timeout 或 interval。

#### Scenario: 取消 active interval
- **GIVEN** 存在 active interval
- **WHEN** 调用 `cancel_schedule` 并传入该 interval 的 `schedule_id`
- **THEN** 系统 SHALL 将该 interval 标记为 cancelled
- **AND** 后续 SHALL NOT 再触发该 interval
- **AND** list API SHALL 能展示其取消状态或在默认列表中隐藏它

#### Scenario: 取消 pending timeout
- **GIVEN** 存在尚未触发的 pending timeout
- **WHEN** 调用 `cancel_schedule`
- **THEN** 系统 SHALL 将该 timeout 标记为 cancelled
- **AND** 到期后 SHALL NOT 投递唤醒事件

#### Scenario: 取消不存在的调度项
- **GIVEN** 调用方传入不存在的 `schedule_id`
- **WHEN** 调用 `cancel_schedule`
- **THEN** 系统 SHALL 返回明确的 not found 错误
- **AND** 不得影响其他调度项

### Requirement: 调度触发必须通过 actor mailbox 与 fiber orchestration 主链
系统 SHALL 在 timeout / interval 到期时，通过 actor mailbox 与 depa-actor fiber orchestration 主链投递唤醒事件，不得绕开 actor loop 直接调用模型。

#### Scenario: timeout 到期投递唤醒 item
- **GIVEN** 某 timeout 到期且仍处于 pending 状态
- **WHEN** scheduler 处理到期事件
- **THEN** 系统 SHALL 向目标 actor 投递 heartbeat wake item 或等价 control item
- **AND** 该 item SHALL 携带 `schedule_id`、`kind`、`name`、`description`、`message`、`payload` 与 `fire_count`
- **AND** actor/fiber loop SHALL 在新 turn 中处理该 item

#### Scenario: interval 到期时目标 actor 正忙
- **GIVEN** 某 interval 到期
- **AND** 目标 actor 当前已有 active foreground turn 或队列繁忙
- **WHEN** scheduler 尝试触发
- **THEN** 系统 SHALL 按策略跳过、延后或合并该次触发
- **AND** SHALL 记录 skip/defer/coalesce diagnostics
- **AND** 不得并发启动多个互相冲突的同一 actor heartbeat turn

### Requirement: heartbeat 工具暴露必须受上下文策略控制
系统 SHALL 将 timeout / interval / list / cancel 工具纳入 actor tool policy、builtin tool registry 与执行器防御性校验，避免不合适的上下文暴露长期调度能力。

#### Scenario: 允许的后台或长期任务上下文可创建 heartbeat
- **GIVEN** actor 正在执行允许后台等待的 invocation、detached task 或明确允许调度的上下文
- **WHEN** tool policy 允许 heartbeat 调度
- **THEN** 模型工具列表 MAY 暴露 `create_timeout`、`create_interval`、`list_schedules`、`cancel_schedule`

#### Scenario: 不允许调度的上下文隐藏创建 API
- **GIVEN** 当前 tool policy 或 runtime context 不允许创建 heartbeat 调度
- **WHEN** 系统构建工具列表
- **THEN** `create_timeout` 与 `create_interval` SHALL 被隐藏
- **AND** tool executor SHALL 对 stale tool call 做防御性拒绝

### Requirement: scheduler 必须提供安全与成本保护
系统 SHALL 对 heartbeat 调度提供最小间隔、最大间隔、最大 active 数、触发次数限制、过期清理与重复触发保护。

#### Scenario: 创建过多 active 调度项
- **GIVEN** 某 actor 或 session 已达到 active schedule 数量上限
- **WHEN** 调用方继续创建 timeout 或 interval
- **THEN** 系统 SHALL 拒绝创建
- **AND** 错误信息 SHALL 指出当前上限

#### Scenario: interval 达到最大触发次数
- **GIVEN** 某 interval 配置或系统默认限制了最大触发次数
- **WHEN** 该 interval 达到最大触发次数
- **THEN** 系统 SHALL 自动停止该 interval
- **AND** 将其状态标记为 completed 或 expired

#### Scenario: 重复 tick 不导致重复投递
- **GIVEN** scheduler 恢复或 tick 循环重复扫描同一个到期调度项
- **WHEN** 同一个 fire attempt 已被处理
- **THEN** 系统 SHALL 通过 fire token、状态版本或等价机制避免重复投递

### Requirement: heartbeat 必须可诊断与可追踪
系统 SHALL 为 schedule 创建、触发、跳过、取消、完成、失败和恢复记录 trace / diagnostics，并通过既有 observability surface 暴露可消费事实。

#### Scenario: 创建调度项记录 trace
- **GIVEN** 调用方成功创建 timeout 或 interval
- **WHEN** scheduler 持久化该调度项
- **THEN** trace SHALL 记录 owner actor、target actor、schedule_id、kind、name 与 next_fire_at

#### Scenario: 触发失败记录 diagnostics
- **GIVEN** scheduler 到期触发某调度项
- **AND** 投递 mailbox 或恢复 fiber 调度失败
- **WHEN** 系统处理该失败
- **THEN** diagnostics SHALL 记录 schedule_id、失败原因与下一步状态
- **AND** interval SHALL 按失败策略 retry、defer 或停止

### Requirement: heartbeat 状态必须支持单机持久化恢复
系统 SHALL 在第一阶段支持单机持久化恢复，使 shell/runtime 重启后能恢复未完成的 timeout 与 interval，或按过期策略处理它们。

#### Scenario: runtime 重启恢复 pending timeout
- **GIVEN** runtime 关闭前存在 pending timeout
- **WHEN** runtime 重启并加载 scheduler state
- **THEN** 系统 SHALL 恢复该 timeout
- **AND** 若其已过期，系统 SHALL 按 missed-fire 策略触发、跳过或标记 expired

#### Scenario: runtime 重启恢复 active interval
- **GIVEN** runtime 关闭前存在 active interval
- **WHEN** runtime 重启并加载 scheduler state
- **THEN** 系统 SHALL 恢复该 interval 的下一次触发计划
- **AND** 不得一次性补发无限数量的历史 missed ticks

## Acceptance Criteria

- `create_timeout`、`create_interval`、`list_schedules`、`cancel_schedule` 的合同、工具定义和执行路径可测试。
- timeout/interval 创建后当前 turn 不被阻塞。
- scheduler 到期触发通过 actor mailbox/fiber orchestration 主链进入新 turn。
- schedule 元数据、状态转换、取消、恢复、去重、配额与 diagnostics 均有单元或集成测试覆盖。
- 文档说明 LLM 不负责 sleep，runtime 负责未来唤醒，并提示 interval token 成本风险。

## Out of Scope

- 分布式 scheduler、跨机器高可用定时服务。
- cron 表达式、复杂日历调度、时区 active hours。
- 长期驻留 LLM、后台思考或模型内 sleep。
- 完整 UI 管理页面。
