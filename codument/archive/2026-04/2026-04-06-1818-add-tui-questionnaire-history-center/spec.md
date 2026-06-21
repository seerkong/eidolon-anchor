## ADDED Requirements

### Requirement: Questionnaire Status Bar Entry

系统应当（SHALL）在 TUI 底部状态栏提供一个 questionnaire 聚合入口，用于同时显示已完成 questionnaire 数量和当前待处理 questionnaire 数量。

#### Scenario: Show completed and pending questionnaire counts in the footer

- **GIVEN** 当前会话中存在 questionnaire 历史
- **WHEN** TUI 渲染底部状态栏
- **THEN** 状态栏显示 questionnaire 聚合入口
- **AND** 该入口同时表达已完成数量和待处理数量
- **AND** 当存在待处理 questionnaire 时，该入口有清晰的待处理提示

### Requirement: Questionnaire History Uses Modal Surface Instead Of Mutating Message History

系统应当（SHALL）通过独立 modal surface 查看 questionnaire 历史，而不是在主消息历史中展开旧 questionnaire 内容。

#### Scenario: Open questionnaire history without changing the transcript layout

- **GIVEN** 用户在状态栏点击 questionnaire 聚合入口
- **WHEN** 系统打开 questionnaire history
- **THEN** 使用独立弹窗展示 questionnaire 历史列表
- **AND** 主消息历史的布局、滚动锚点和可见消息顺序不被改写

### Requirement: Questionnaire History Modal Shows Pending First And Summary Rows

系统应当（SHALL）在 questionnaire history 弹窗中优先展示待处理 questionnaire，并以摘要行展示每个 questionnaire，而不是直接展示整份问卷内容。

#### Scenario: History modal prioritizes pending items and summary metadata

- **GIVEN** 会话中同时存在已完成和待处理 questionnaire
- **WHEN** 用户打开 questionnaire history 弹窗
- **THEN** 待处理 questionnaire 排在已完成 questionnaire 之前
- **AND** 每条记录至少展示标题、状态、时间、answered/total 与摘要答案
- **AND** 列表默认不直接展开完整题目内容

#### Scenario: Rehydrate questionnaire center when reopening an existing session

- **GIVEN** 某个会话在当前 TUI 进程之外已经产生过已完成或待处理 questionnaire
- **WHEN** 用户重新打开该会话
- **THEN** footer questionnaire done/pending 计数会从已存在的 runtime questionnaire 记录中恢复
- **AND** questionnaire history modal 仍可列出这些已存在的 questionnaire 摘要与详情
- **AND** 待处理 questionnaire 仍保持优先展示

### Requirement: Questionnaire Detail View Uses A Second-Level Modal

系统应当（SHALL）允许用户从 questionnaire history 列表继续进入 questionnaire 详情弹窗，以查看完整题目、选项和回答。

#### Scenario: Open a specific questionnaire detail from history

- **GIVEN** 用户已打开 questionnaire history 列表弹窗
- **WHEN** 用户选中某条 questionnaire 记录并执行查看详情
- **THEN** 系统打开该 questionnaire 的详情弹窗
- **AND** 详情弹窗展示完整题目、选项、用户原始回答与结构化结果
- **AND** 关闭详情后返回 questionnaire history 列表，而不是跳回主消息历史

#### Scenario: Escape from questionnaire detail returns to history list

- **GIVEN** 用户当前位于 questionnaire detail 弹窗
- **WHEN** 用户按下 `esc`
- **THEN** 系统返回 questionnaire history 列表
- **AND** questionnaire history 弹窗保持打开

### Requirement: New Assistant Output Remains Primary In The Main Conversation View

系统应当（SHALL）让问卷历史查看行为与主对话视口解耦，使新 assistant 输出继续保持在主消息流中的优先可见性。

#### Scenario: Reviewing questionnaire history does not compete with new assistant content

- **GIVEN** 某个 questionnaire 已完成且 assistant 继续生成新的内容
- **WHEN** 用户没有主动打开 questionnaire history modal
- **THEN** 主对话视图继续以最新 assistant 内容为主
- **AND** 已完成 questionnaire 不依赖在历史底部展开来维持可回看能力

## MODIFIED Requirements

### Requirement: TUI questionnaire 历史展示不再依赖消息历史展开

系统 MUST 将历史 questionnaire 的回看入口从“消息历史中的长内容常驻”转为“状态栏入口 + modal 查看”。消息历史中可以保留 questionnaire 摘要或普通历史记录，但不得再依赖直接展开旧 questionnaire 来承担完整回看职责。

#### Scenario: Message history stays stable while questionnaire history remains accessible

- **GIVEN** 用户会话中已经出现多个 questionnaire
- **WHEN** 用户继续普通对话或浏览主消息历史
- **THEN** 主消息历史保持稳定
- **AND** 用户仍可通过 questionnaire history modal 查看任意旧 questionnaire 的完整细节
