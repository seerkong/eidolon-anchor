# 变更：AIAgent Confirm 重构为 Questionnaire tool

## 背景和动机 (Context And Why)

当前 AIAgent 的 Confirm 机制只能表达“是否确认”这类单一交互，并且事件流与终端展示层对 Confirm 有硬编码（`ConfirmRequest/ConfirmResult`、`confirm_wait`、`confirm_pending`）。随着业务需要增加“澄清/审批/非结构化文本问答/结构化表单问答”等能力，现有 Confirm 语义与数据结构已不足以承载。

本变更将 Confirm 重构为通用的 Questionnaire tool：以结构化 `QuestionnaireRequest/QuestionnaireResult` 贯穿底层 data graph、消息历史与 TUI 格式化展示，并在用户文本回答后通过一次 LLM 调用解析为结构化答案，便于未来扩展和复用。

## “要做”和“不做” (Goals / Non-Goals)

**目标:**
- 用 `QuestionnaireRequest/QuestionnaireResult`（结构化）替代 `ConfirmRequest/ConfirmResult`。
- 以 `questionnaire_wait` 替代 `confirm_wait` 停止原因。
- 在底层 data graph 中提供“提出问卷/回答问卷”两类结构化事件。
- 在 `terminal/packages/organ/src/AIAgent/TuiEventGraph.ts` 将结构化问卷格式化为可读文本。
- 在 `backend/packages/organ/src/AIAgent/questionnaire/` 实现 `parseQuestionnaireAnswer()`：用提示词 + 问卷结构 + 用户回答，解析为结构化答案。
- 支持每个问卷请求指定等待策略 `pause_all/continue_others`，用于决定等待期间是否暂停其他 actor。

**非目标:**
- 不实现图形化表单 UI（本 Track 以文本交互为主）。
- 不实现跨进程/分布式审批服务与权限系统。
- 不承诺一次性覆盖所有字段类型与校验规则（优先落地最小可扩展 schema）。

## 变更内容（What Changes）

- 新增 `QuestionnaireRequest/QuestionnaireResult` 事件类型与对应 graph API、消息历史映射。
- 新增 Questionnaire tool（由 LLM 触发的工具调用），携带结构化问卷定义。
- 执行器在 tool 输出触发等待时，发出 `QuestionnaireRequest` 并停止为 `questionnaire_wait`。
- 用户文本回答后，通过 `parseQuestionnaireAnswer()` 解析并发出 `QuestionnaireResult`，随后继续 Agent loop。
- TUI 层将 `QuestionnaireRequest` 格式化为多题文本（标题/说明/题号/选项提示）。
- **BREAKING**：移除/停止发出 `ConfirmRequest/ConfirmResult` 与 `confirm_wait`。

## 影响范围（Impact）

- 受影响的功能规范：新增/更新 `aiagent-questionnaire`（归档时落入 `codument/specs/`）。
- 受影响的代码路径（预计）：
  - `backend/packages/core/src/modules/AIAgent/StreamEvents.ts`
  - `backend/packages/core/src/modules/AIAgent/stream/AgentEventGraph.ts`
  - `backend/packages/core/src/modules/AIAgent/stream/MessageHistoryGraph.ts`
  - `backend/packages/core/src/modules/AIAgent/runtime/actor.ts`
  - `backend/packages/organ/src/AIAgent/exec/AiAgentExecutor.ts`
  - `terminal/packages/organ/src/AIAgent/TuiEventGraph.ts`
  - `terminal/packages/minimal/src/app.ts`
  - `terminal/packages/tui/*`（若存在同等输入路由/控制消息处理）
