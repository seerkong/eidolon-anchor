## ADDED Requirements

### Requirement: Runtime Formal Work Context
系统应当为 AI agent 维护正式的 runtime 工作上下文，而不是仅在 prompt 渲染时临时推导执行形态。

#### Scenario: Turn start resolves work context
- **GIVEN** 某个 actor 即将开始新的用户 turn
- **WHEN** runtime 收到本轮用户输入并开始调度 prompt assembly
- **THEN** 系统 SHALL 解析并写入正式的 `work_mode` 与 `task_phase`
- **AND** SHALL 记录它们的 source 与 updated timestamp
- **AND** SHALL 让后续 prompt assembly、compaction、runtime bridge 共享同一份 work context

#### Scenario: Tool round advances task phase
- **GIVEN** 当前 turn 已进入工具执行回合
- **WHEN** runtime 完成本轮工具调用并获得 round 级结果
- **THEN** 系统 SHALL 根据工具种类与 round 结果推进或保留当前 `task_phase`
- **AND** SHALL 将这次推进记录为正式 runtime state change，而不是只停留在局部变量中

### Requirement: Prompt Truth Must Be Plan And Transform Driven
系统应当以结构化 prompt plan / generation / transform 管理模型输入，而不是只保留最终字符串。

#### Scenario: Prompt request creates formal prompt truth
- **GIVEN** runtime 即将向模型发起一次新请求
- **WHEN** 系统完成本轮 prompt 装配
- **THEN** 系统 SHALL 先形成结构化 `PromptPlan`
- **AND** SHALL 把这次请求记录为正式 `PromptGeneration`
- **AND** SHALL 将其与当前 history basis 建立关联

#### Scenario: Prompt overlays and summaries are stored as transforms
- **GIVEN** runtime 需要叠加 overlay、compaction summary 或上下文块
- **WHEN** 这些内容被加入模型输入
- **THEN** 系统 SHALL 将它们记录为正式 `PromptTransform`
- **AND** SHALL 使其可被 runtime-first materialization 解释
- **AND** SHALL 不把这些 prompt-only 内容误写为 formal history truth

### Requirement: Prompt Assembly Must Be Gated By Work Context
系统应当根据当前 `work_mode` 与 `task_phase` 动态控制 prompt assembly、能力路由和工具面。

#### Scenario: Work context shapes prompt routing
- **GIVEN** 当前 turn 已解析出 `work_mode` 与 `task_phase`
- **WHEN** 系统选择 prompt modules、routing candidates、skills 或 subagents
- **THEN** 系统 SHALL 使用当前 work context 作为正式 gating 输入
- **AND** SHALL 在短路径执行或实现阶段收缩不必要的广域能力暴露

#### Scenario: Prompt metadata records work context
- **GIVEN** 系统已经生成本轮 prompt plan
- **WHEN** 该 plan 被送入编译或 materialization
- **THEN** 系统 SHALL 在 metadata 中保留当前 `work_mode`、`task_phase` 与相关 routing 决策

### Requirement: Compaction Must Be Phase-Aware
系统应当按当前工作上下文决定是否压缩、如何压缩，以及压缩时保护哪些证据。

#### Scenario: Compaction policy consumes current work state
- **GIVEN** runtime 触发手动或自动压缩
- **WHEN** compaction policy 计算决策
- **THEN** 系统 SHALL 显式消费 `work_mode`、`task_phase`、token pressure、baseline epoch 和近期证据特征
- **AND** SHALL 产出结构化 policy context 与 policy decision

#### Scenario: Verification phase protects verification evidence
- **GIVEN** 当前 `task_phase` 为 `verification`
- **WHEN** 系统执行压缩
- **THEN** 系统 SHALL 优先保护 verification evidence、patch rationale 与 command/result continuity
- **AND** SHALL 不得把这些关键信息压缩成不可追溯的泛化摘要

### Requirement: Compaction Rewrite Must Reset Continuation Baseline
系统应当在 compaction 改写 replay 基线后正式重置 continuation 身份与相关缓存。

#### Scenario: Rewrite bumps baseline epoch
- **GIVEN** 一次 compaction 实际改写了 runtime replay 历史
- **WHEN** 系统提交 compaction 结果
- **THEN** 系统 SHALL 提高正式 continuation baseline epoch
- **AND** SHALL 清空或失效当前 continuation identity
- **AND** SHALL 使相关缓存和后续 replay 逻辑感知这次 baseline 切换

### Requirement: Upper Consumers Must Prefer Runtime-First Context Views
系统应当让上层消费面优先读取 runtime work context、prompt truth 和相关视图。

#### Scenario: Runtime-first prompt and session consumption
- **GIVEN** runtime 中已经存在有效的 conversation / prompt / work context raw state
- **WHEN** TUI、headless 或 runtime bridge 需要获取当前会话的模型输入视图或上下文状态
- **THEN** 系统 SHALL 优先读取 runtime-first 视图
- **AND** 仅在 runtime 不可用或无状态时才回退 `.eidolon` persistence-first loader
