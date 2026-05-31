# AIAgent Fiber Orchestration 规范

## 概述

该能力规范定义 AIAgent 已完成的 fiber orchestration 调度模型，包括 orchestrator 成为唯一调度权威、subagent 的 child-fiber 语义、Questionnaire 等待策略，以及 cooperative step state machine。

### Requirement: Fiber orchestration 成为唯一调度权威
系统 MUST 使用 depa-actor fiber orchestration 决定下一个运行的 actor 或 fiber，而不是由外部调用方循环直接推进。

#### Scenario: 调度权从调用方转移到 orchestrator
- **GIVEN** 当前存在 main actor 与多个 sub actor
- **WHEN** 系统需要推进执行
- **THEN** 系统通过 `scheduleOne()` 选择下一条 fiber
- **AND** 通过 `dispatchEffects()` 将本次 step 投递到目标 actor
- **AND** 调用方不再直接调用 `aiAgentLoopStreaming()` 作为推进手段

### Requirement: Stage 1 调度迁移已完成
系统 MUST 通过 orchestrator driver 驱动执行，并完成对 legacy 直接推进调用点的 hard replace。

#### Scenario: Terminal minimal 不再直接调用 aiAgentLoopStreaming
- **GIVEN** 用户启动 terminal minimal
- **WHEN** 用户输入一条消息
- **THEN** minimal 将输入投递到 actor mailbox
- **AND** 触发 orchestrator tick 推进
- **AND** 不直接调用 `aiAgentLoopStreaming()`

#### Scenario: Questionnaire 等待与恢复由 orchestrator 控制
- **GIVEN** 某 actor 发出 `QuestionnaireRequest(suspendPolicy=pause_all)` 并进入等待
- **WHEN** orchestrator 调度下一步
- **THEN** 进入 `pause_all` 门控
- **AND** 当用户回答到达并恢复等待 fiber 后，调度恢复

#### Scenario: continue_others 不阻塞其他 actor
- **GIVEN** 某 actor 发出 `QuestionnaireRequest(suspendPolicy=continue_others)` 并进入等待
- **WHEN** orchestrator 调度下一步
- **THEN** 其他 ready fiber 仍可被选择并推进

### Requirement: cancel tag 已迁移为 control 信号
系统 MUST 不再使用 AIAgent actor mailbox schema 中的 `cancel` tag，而是使用 `control.kind=cancel_requested` 表达取消信号。

#### Scenario: control 统一承载取消信号
- **GIVEN** actor 需要接收取消请求
- **WHEN** 系统发出取消控制消息
- **THEN** 该信号通过 `control` tag 传递
- **AND** 其处理优先级不低于迁移前的 `cancel`

### Requirement: SubAgent 作为 child fiber 运行
系统 MUST 让 SubAgent 以 child fiber 形式运行，并在完成时向 parent actor 发送高优先级 `childDone` 消息。

#### Scenario: sync_wait 模式恢复父流程并注入结果
- **GIVEN** parent actor 触发 `RunSubAgent` 且 `mode=sync_wait`
- **WHEN** child fiber 完成
- **THEN** child 发送完成消息到 parent
- **AND** parent 优先处理完成消息
- **AND** parent 将子结果注入对话历史
- **AND** parent 流程继续推进

#### Scenario: background 模式不阻塞 parent 但仍回注结果
- **GIVEN** parent actor 触发 `RunSubAgent` 且 `mode=background`
- **WHEN** child fiber 完成
- **THEN** child 发送完成消息到 parent
- **AND** parent 优先处理完成消息
- **AND** parent 将子结果注入对话历史

### Requirement: childDone mailbox 优先级高于常规输入
系统 MUST 在 AIAgent mailbox schema 中定义 `childDone`，并保证其优先级高于 `humanInput` 与 `toolResult`。

#### Scenario: parent 在下一次 step 优先处理 childDone
- **GIVEN** parent actor 同时拥有 child 完成消息与其他普通待处理输入
- **WHEN** orchestrator 调度该 actor
- **THEN** `childDone` 优先被消费

### Requirement: Cooperative step state machine 成为执行模型
系统 MUST 将执行器表达为 cooperative step state machine，每个 fiber step 执行一个可界定量子，并在外部等待期间通过 suspend/resume 交回调度权。

#### Scenario: LLM 调用等待期间调度其他 fiber
- **GIVEN** fiber A 在一次 LLM 调用期间进入等待状态
- **AND** 存在其他 ready fiber
- **WHEN** orchestrator 调度下一步
- **THEN** 其他 fiber 可继续推进

#### Scenario: WaitingAnswer 以 suspend 和 resume 表达
- **GIVEN** 当前 fiber 进入 `WaitingAnswer`
- **WHEN** cooperative step 状态机进入等待阶段
- **THEN** fiber 进入 `suspended`
- **AND** `waitingReason` 映射为 `human_answer`
- **AND** 在收到用户回答后，fiber 通过 `resume` 回到可调度状态并继续推进

### Requirement: depa-actor orchestration 支持 per-fiber human suspend policy
系统 MUST 支持按 fiber 或按一次 suspend 动作携带 human suspend policy，并在 scheduler 中生效。

#### Scenario: scheduler 仅在存在 pause_all human-wait fiber 时全局暂停
- **GIVEN** orchestrator 中存在多个 suspended fiber，且仅部分 fiber 标记为 `pause_all`
- **WHEN** 调用 `selectNextFiberId()`
- **THEN** 当且仅当存在 `pause_all` 的 human-wait fiber 时返回 `undefined`
- **AND** 仅有 `continue_others` 的 human-wait fiber 时，ready fiber 仍可被调度

#### Scenario: 混合策略保持可预测
- **GIVEN** fiber A 的等待策略为 `pause_all`
- **AND** fiber B 的等待策略为 `continue_others`
- **WHEN** orchestrator 调度下一步
- **THEN** `pause_all` 等待阻塞整个 orchestrator
- **AND** 当 pause_all 的等待 fiber 恢复后，`continue_others` 等待不应阻塞其他 ready fiber

### Requirement: 调度改造保持可测试性与终端可用性
系统 MUST 为公平性、等待策略、subagent parent/child 链路提供可重复、可断言的测试，并保持 semantic runtime 与终端展示链路稳定。

#### Scenario: 相同输入序列得到一致调度轨迹
- **GIVEN** 固定的时间序列与相同输入消息
- **WHEN** 重复执行测试
- **THEN** 可得到一致的可断言结果

#### Scenario: 终端关键回归保持通过
- **GIVEN** 现有 terminal tui 的 stream 或 tui fixtures
- **WHEN** 完成调度改造
- **THEN** 关键回归测试保持通过或按规范更新

### Requirement: Runtime bridge 不得继续承担 collective/background 的业务推进责任
系统 MUST 让 business progression 回到 actor/fiber，而不是继续由 terminal runtime 的外挂 pump、controller 或 tool polling 驱动。

#### Scenario: TerminalRuntime 退化为 I/O bridge
- **GIVEN** 当前 `TerminalRuntime` 仍会通过 queue、background pump、deferred resume 等机制承担部分业务推进
- **WHEN** actor/fiber orchestration 收口完成
- **THEN** `TerminalRuntime` MUST 主要负责输入输出桥接与 orchestrator bridge
- **AND** holon/background 的业务循环 MUST 由 actor 自己的 mailbox、fiber 与 completion signal 推进

### Requirement: Autonomous holon scheduler protocol SHALL 使用治理显式命名
系统 MUST 让 autonomous holon 的调度 lane、workload 与 task-tree scope marker 使用治理显式、holon-first 的正式协议名。

#### Scenario: lane 与 workload 使用 autonomous holon 语义
- **GIVEN** autonomous holon actor 与成员 fiber 会进入调度器
- **WHEN** orchestrator 为其选择 lane 与 workload
- **THEN** 系统 MUST 使用 `autonomous_holon` 作为正式 lane
- **AND** MUST 使用 `autonomous_holon_task` 作为正式 workload

#### Scenario: activeForm 使用 governance-explicit holon scope marker
- **GIVEN** 任务树需要表达任务属于 autonomous 或 leader-led holon
- **WHEN** 系统写入或解析 activeForm
- **THEN** autonomous holon MUST 使用 `holon:autonomous:<id>`
- **AND** leader-led holon MUST 使用 `holon:leader_led:<id>`
