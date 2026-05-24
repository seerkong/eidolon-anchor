# 变更规范：AIAgent Confirm 重构为 Questionnaire tool

## 概述

本 Track 将本项目 AIAgent 现有的 Confirm 机制（`ConfirmRequest/ConfirmResult` 事件、`confirm_wait` 停止原因、TUI 中的 Confirm 文本提示）重构为通用的 `Questionnaire` 工具与对应的事件流，面向未来扩展：

- 用户澄清（clarification）
- 用户审批（approval）
- 非结构化文本问答（freeform Q&A）
- 结构化表单问答（structured form，通过文本交互呈现）

设计约束：
- Track 文档与实现应当自包含，不依赖仓库外部说明文档。
- `QuestionnaireRequest` 与 `QuestionnaireResult` 必须是结构化数据（用于 data graph/事件流、历史记录、测试断言）。
- 交互在 TUI/终端中以格式化文本展示，用户以文本回复，系统再解析为结构化答案。

## ADDED Requirements

### Requirement: Questionnaire 事件替代 Confirm 事件
系统 MUST 使用 `QuestionnaireRequest` 与 `QuestionnaireResult` 事件替代 `ConfirmRequest` 与 `ConfirmResult`。

#### Scenario: AI 发起问卷请求并进入等待
- **GIVEN** AIAgent 在一次工具调用链路中需要用户输入
- **WHEN** AI 发起 `Questionnaire` 工具调用
- **THEN** 事件流中产生 `QuestionnaireRequest`（结构化）
- **AND** 执行器停止原因为 `questionnaire_wait`

#### Scenario: 用户回答后继续执行
- **GIVEN** 系统处于 `questionnaire_wait`
- **WHEN** 用户用文本回答问卷
- **THEN** 系统产生 `QuestionnaireResult`（结构化答案）
- **AND** AIAgent 获得结构化答案并继续下一轮执行

### Requirement: QuestionnaireRequest 为可扩展的结构化 schema
系统 MUST 定义结构化 `QuestionnaireRequest`，至少包含：

- `questionnaireId`（稳定 id，用于关联请求/结果）
- `toolCallId`（关联工具调用）
- `kind`（如 `clarification`/`approval`/`freeform`/`form`）
- `title`/`intro`（可选）
- `questions[]`（问题列表，包含 `id`、`prompt`、`type`、可选 `required/choices/default/helpText`）
- `suspendPolicy`（`pause_all` 或 `continue_others`）

#### Scenario: 结构化表单问卷
- **GIVEN** AI 需要用户填写多题表单
- **WHEN** AI 发出 `QuestionnaireRequest(kind=form)`
- **THEN** 请求包含多个 `questions`，每个问题都有 `id/prompt/type`

### Requirement: QuestionnaireResult 为结构化答案且保留原始文本
系统 MUST 定义结构化 `QuestionnaireResult`，至少包含：

- `questionnaireId`
- `toolCallId`
- `rawText`（用户原始回答文本）
- `answers`（按 `questionId -> value` 的结构化答案映射，或等价结构）
- `status`（如 `ok`/`invalid`）
- `errors`（当 `invalid` 时给出原因/缺失字段提示）

#### Scenario: 结构化答案可用于后续决策
- **GIVEN** 用户已回答问卷
- **WHEN** 产生 `QuestionnaireResult(status=ok)`
- **THEN** AIAgent 可直接使用 `answers` 做后续决策

### Requirement: 解析用户回答为结构化答案
系统 MUST 提供 `parseQuestionnaireAnswer()`，通过一次 LLM 调用，将 `QuestionnaireRequest` + 用户文本回答解析为 `QuestionnaireResult` 所需的结构化答案。

#### Scenario: 解析成功
- **GIVEN** 一个 `QuestionnaireRequest` 与用户文本回答
- **WHEN** 调用 `parseQuestionnaireAnswer()`
- **THEN** 返回 `status=ok` 且给出完整 `answers`

#### Scenario: 解析失败后触发再次问卷
- **GIVEN** 用户回答不完整或无法解析
- **WHEN** `parseQuestionnaireAnswer()` 返回 `status=invalid`
- **THEN** 系统产生一次新的 `QuestionnaireRequest(kind=clarification)` 用于追问缺失信息
- **AND** 原始文本与失败原因可被追踪

### Requirement: 底层 data graph 使用结构化 Questionnaire 事件类别
系统 MUST 在底层通用 data graph 中将“提出问卷/回答问卷”建模为两类结构化事件：`QuestionnaireRequest` 与 `QuestionnaireResult`。

#### Scenario: 历史记录包含问卷请求/结果
- **GIVEN** 系统产生问卷请求与结果事件
- **WHEN** 写入消息历史
- **THEN** 历史中存在可回放的结构化记录（包含 request 与 result 的 payload）

### Requirement: TUI data graph 将问卷结构化数据格式化为文本
系统 MUST 在 `terminal/packages/organ/src/AIAgent/TuiEventGraph.ts` 将 `QuestionnaireRequest` 的结构化数据转换为适于终端展示的格式化文本。

#### Scenario: 终端可读问卷文本
- **GIVEN** 一个包含多题的 `QuestionnaireRequest`
- **WHEN** TUI 消费该事件
- **THEN** 输出包含标题/说明/题号/选项提示的文本

### Requirement: Shell 以文本形式展示问卷并收集用户回复
系统 MUST 在终端 shell（`terminal/packages/minimal`、`terminal/packages/tui`）中显式展示问卷文本，并收集用户以文本形式的回答。

#### Scenario: 用户以一段文本回答多题
- **GIVEN** TUI 已展示问卷文本
- **WHEN** 用户输入一段包含多题答案的文本
- **THEN** 系统将该文本交给 `parseQuestionnaireAnswer()`

### Requirement: 等待策略可按请求配置（pause_all / continue_others）
系统 MUST 支持两种控制策略，并由每个 `QuestionnaireRequest` 通过 `suspendPolicy` 指定：

- `pause_all`：任意问卷等待期间，主 actor 与其他 sub actor 均暂停推进
- `continue_others`：仅等待中的 actor 暂停，其他 actor 正常运行

#### Scenario: pause_all 暂停所有 actor
- **GIVEN** 主 actor 与多个 sub actor 同时存在可推进任务
- **WHEN** 任意 actor 发出 `QuestionnaireRequest(suspendPolicy=pause_all)` 并进入等待
- **THEN** 调度层不再推进其他 actor
- **AND** 用户反馈后，所有挂起链路恢复推进

#### Scenario: continue_others 允许其他 actor 继续
- **GIVEN** 主 actor 与多个 sub actor 同时存在可推进任务
- **WHEN** 任意 actor 发出 `QuestionnaireRequest(suspendPolicy=continue_others)` 并进入等待
- **THEN** 其他 actor 仍可继续被推进

## REMOVED Requirements

### Requirement: ConfirmRequest/ConfirmResult 与 confirm_wait
系统 SHALL 不再产生 `ConfirmRequest/ConfirmResult` 事件，也 SHALL 不再使用 `confirm_wait` 停止原因。

#### Scenario: 不再发出 Confirm 事件
- **GIVEN** 工具调用链路需要用户输入
- **WHEN** 系统发出问卷
- **THEN** 事件为 `QuestionnaireRequest/QuestionnaireResult`
- **AND** 不出现 `ConfirmRequest/ConfirmResult`

## 验收标准

- AIAgent 不再依赖 Confirm 事件/停止原因，改为 Questionnaire 事件/停止原因。
- `QuestionnaireRequest/QuestionnaireResult` 为结构化数据，并贯穿底层 data graph、消息历史与测试断言。
- TUI 层可将 Questionnaire 结构化数据格式化为可读问卷文本。
- 用户以文本回答后，系统通过 `parseQuestionnaireAnswer()` 得到结构化答案。
- 支持 `pause_all` / `continue_others` 两种等待策略并有测试覆盖。
- 新增/修改代码测试覆盖率 >80%，项目测试通过。

## 范围外事项

- 不实现图形化表单 UI（本 Track 以文本交互为主）。
- 不实现跨进程/分布式的人机审批系统。
- 不改变 LLM 供应商或引入新的外部依赖作为硬要求（除非设计明确并获批）。
