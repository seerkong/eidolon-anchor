## 上下文

本项目 AIAgent 当前通过 Questionnaire 机制实现“需要用户输入才能继续”的交互：

- Questionnaire tool 在 tool run 期间写入 actor `pendingQuestionnaires`，并发送 control mailbox `questionnaire_pending`
- Questionnaire tool 同步发出 `QuestionnaireRequest/QuestionnaireResult` 事件（不依赖 tool 输出字符串 sentinel）
- 执行器根据 `questionnaire_pending` 控制状态进入停止原因 `questionnaire_wait`
- TUI 层将 `QuestionnaireRequest` 格式化为提示文本
- 终端接收用户输入后，根据 pending 状态把输入转为 `toolResult` 或 `humanInput`

旧 Confirm 机制只能表达单一的“确认”交互；本 Track 目标是以 Questionnaire 作为统一入口，覆盖澄清/审批/多题问卷/结构化表单等场景。

本 Track 将 Confirm 重构为 Questionnaire tool，并在事件流、TUI 展示、用户回答解析链路中提供通用的结构化模型。

约束：
- Track 文档与实现自包含，不依赖仓库外部说明文档。
- 交互入口依然是文本（terminal/minimal、terminal/tui），但事件/历史必须结构化。

## 方案概览

1. 事件模型重构（底层 data graph）
  - 新增 `QuestionnaireRequest/QuestionnaireResult` 结构化事件。
  - 移除 `ConfirmRequest/ConfirmResult`。
  - `AgentEventGraph` 提供 emit API：emitQuestionnaireRequest / emitQuestionnaireResult。
  - `MessageHistoryGraph` 将其映射为可回放的 history stream（例如 `questionnaire_request` / `questionnaire_result`）。

2. 执行器与停止原因重构（backend AIAgent）
  - 执行器不再产生 `confirm_wait`，改为 `questionnaire_wait`。
  - 当 tool 需要用户输入时，执行器发出 `QuestionnaireRequest` 并停下。
  - control mailbox 从 `confirm_pending` 重构为 `questionnaire_pending`（包含 toolCallId 与 questionnaireId 等）。

3. TUI 层问卷文本格式化
  - `terminal/packages/organ/src/AIAgent/TuiEventGraph.ts` 消费 `QuestionnaireRequest`。
  - 将结构化问题格式化为显式的文本提示（标题/说明/题号/选项/填写示例）。

4. 用户回答解析（LLM parseQuestionnaireAnswer）
  - 在 `backend/packages/organ/src/AIAgent/questionnaire/` 新增 `parseQuestionnaireAnswer()`。
  - 输入：QuestionnaireRequest + 用户 rawText。
  - 输出：结构化 answers + status + errors，并保留 rawText。
  - 解析失败时返回 `status=invalid`，并由执行器发出新的澄清问卷（kind=clarification）。

5. 等待策略（pause_all / continue_others）
  - `QuestionnaireRequest` 携带 `suspendPolicy`：`pause_all` 或 `continue_others`。
  - `pause_all`：等待期间主 actor 与其他 sub actor 均暂停推进。
  - `continue_others`：仅等待中的 actor 暂停，其他 actor 可继续。
  - 策略的实际落点依赖当前运行时是否存在多 actor 并行推进；实现上优先把策略做成可测试的“调度门控”逻辑。

## 影响范围与修改点（Impact）

- backend（核心事件/历史）
  - `backend/packages/core/src/modules/AIAgent/StreamEvents.ts`
  - `backend/packages/core/src/modules/AIAgent/stream/AgentEventGraph.ts`
  - `backend/packages/core/src/modules/AIAgent/stream/MessageHistoryGraph.ts`

- backend（执行器与 actor mailbox）
  - `backend/packages/core/src/modules/AIAgent/runtime/actor.ts`
  - `backend/packages/organ/src/AIAgent/exec/AiAgentExecutor.ts`
  - `backend/packages/organ/src/AIAgent/questionnaire/*`

- terminal（TUI graph 与 shell 路由）
  - `terminal/packages/organ/src/AIAgent/TuiEventGraph.ts`
  - `terminal/packages/minimal/src/app.ts`
  - `terminal/packages/tui/*`（若存在同等 input/control 路由，需要同步改造）

## 决策

- 决策：Hard replace Confirm -> Questionnaire
  - 说明：不保留 `ConfirmRequest/ConfirmResult` 与 `confirm_wait` 作为长期兼容层。
  - 原因：避免语义分裂，确保事件流统一为 Questionnaire；新能力扩展不再被 Confirm 绑死。

- 决策：Questionnaire schema 采用最小可扩展结构（questions[] + typed field）
  - 说明：使用 `questions[]` 描述多题，类型包含 text/yes_no/single_select/multi_select/number/json 等。
  - 原因：兼顾可扩展性与终端文本交互成本，避免一次性引入 JSONSchema/UISchema 的复杂度。

- 决策：解析失败返回 invalid，并触发再问卷
  - 说明：`QuestionnaireResult` 保留 rawText 并包含 errors；执行器按 errors 生成新的澄清问卷。
  - 原因：提升交互确定性与可追踪性，避免静默 fallback 造成歧义。

- 决策：等待策略按每次 request 配置
  - 说明：`QuestionnaireRequest.suspendPolicy` 支持 `pause_all/continue_others`。
  - 原因：不同业务（审批 vs 澄清）对并行推进的需求不同，且应由发起方显式选择。

## 风险 / 权衡

- Hard replace 会影响现有 Confirm 测试与终端交互脚本 → 需要同步更新测试与示例。
- 解析依赖 LLM，输出必须可控 → 需要严格提示词、强约束 JSON 输出、并为 invalid 分支提供可恢复路径。
- `pause_all` 的准确语义依赖“是否存在多 actor 并行推进” → 需要先梳理 AIAgent 运行时调度边界，并在测试中模拟。

## 兼容性设计

- 本 Track 不提供 Confirm 兼容层；若存在外部依赖 Confirm 的调用方，需要在同一次变更中完成迁移。

## 迁移计划

1. 新增 Questionnaire 事件、Graph API、历史映射。
2. 执行器与控制 mailbox 迁移到 questionnaire_pending / questionnaire_wait。
3. TUI 格式化 QuestionnaireRequest。
4. 接入 parseQuestionnaireAnswer 并完成 invalid->re-ask 流程。
5. 删除 Confirm 相关类型与测试，并全量跑通 backend/terminal 测试。

## 待解决问题

- AIAgent 当前是否存在“多 actor 并行推进”的真实场景（主 agent + subagent 同时运行）？若不存在，需要在测试中构建一个可验证的最小调度模拟，以验证 `pause_all/continue_others` 的语义。

## Terminal 输入路由（Orchestrator 驱动下）

在使用 actor orchestrator driver（fiber 调度）推进时，terminal 的“一次输入”语义为：投递 mailbox 消息后推进 orchestrator，直到进入 idle 或 human wait。

- 关键点：当存在 `control.kind="questionnaire_pending"` 时，用户输入必须被视为“问卷回答”而不是普通对话输入。
- 典型实现：
  - `terminal/packages/minimal/src/app.ts`
  - `terminal/packages/tui/src/runtime/TuiRuntime.ts`
- 路由规则（简化描述）：
  - 若 actor 当前有 pending control 且包含 `questionnaire_pending`：
    - 将 input 作为 `{ toolCallId, questionnaireId, content }` 投递到 `toolResult` mailbox
  - 否则：
    - 将 input 投递到 `humanInput` mailbox
- 随后：调用 `driver.resumeFiber(...)` 并 `tickUntilBlocked(...)`，让 cooperative step 处理该输入并产生新的 BizEvent/TUI 输出。

此处强调 `control` 优先级必须最高（或不低于其它输入），以避免用户输入在 pending 被处理前被错误路由。
