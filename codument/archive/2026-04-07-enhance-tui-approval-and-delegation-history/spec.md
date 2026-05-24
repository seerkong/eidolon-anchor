## ADDED Requirements

### Requirement: Approval History And Summaries

系统应当（SHALL）在保留当前 approval pane 的同时，补充审批历史与摘要展示。

#### Scenario: Show structured approval summaries in conversation history

- **GIVEN** 会话中出现 permission request 或 questionnaire request
- **WHEN** 这些请求被用户处理完成
- **THEN** TUI 在消息历史中保留相应的结构化摘要
- **AND** 用户可以回看当时的审批或回答结果

#### Scenario: Approval pane and history stay consistent

- **GIVEN** 当前会话仍存在活动中的审批请求
- **WHEN** 用户查看 approval pane 和消息历史
- **THEN** 活动请求由 pane 展示
- **AND** 已完成请求由历史摘要展示
- **AND** 两者不出现重复或状态冲突

### Requirement: Interactive Approval And Questionnaire Replies

系统应当（SHALL）在新的 prototype TUI 中继续提供可直接操作的 permission / questionnaire 交互，而不是只显示阻塞提示或纯文本结果。

#### Scenario: Reply to permission requests from the approval pane

- **GIVEN** 当前会话存在活动中的 permission request
- **WHEN** 用户在 approval pane 中处理该请求
- **THEN** 系统提供 allow once、allow always 和 reject 等直接操作
- **AND** permission pane 展示足够的上下文信息，帮助用户做出决策

#### Scenario: Answer questionnaire requests with structured interaction

- **GIVEN** 当前会话存在活动中的 questionnaire request
- **WHEN** 用户在 approval pane 中回答问题
- **THEN** 系统支持选项选择、多题切换、自定义答案输入、提交和 reject
- **AND** 未明确选择的问题组保持为空，而不是自动填充默认选项

### Requirement: Delegation And Question Cards

系统应当（SHALL）为 delegation、question 和 task tree 类型工具调用提供结构化卡片，而不是仅保留摘要信息。

#### Scenario: Render delegation task cards

- **GIVEN** assistant 发起 delegated task
- **WHEN** TUI 渲染对应工具调用
- **THEN** 系统展示结构化 task card
- **AND** 用户可看到 delegated task 的摘要与当前进展

#### Scenario: Render question and task tree cards

- **GIVEN** assistant 产生 question、tasktreewrite 或 tasktreeread 类型工具调用
- **WHEN** TUI 渲染这些工具 part
- **THEN** 系统使用专用卡片展示问题答案或任务树内容
- **AND** 用户无需从原始输出文本中手动还原语义
