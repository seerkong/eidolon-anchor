# 参考项目阶段事件对齐清单

本文件用于支撑任务 `T1.1`，记录参考项目阶段事件、字段和 transcript naming 在本项目中的对齐目标。

## Lexical Event Types

1. `lexical_turn_start`
2. `lexical_thinking_start`
3. `lexical_thinking_delta`
4. `lexical_thinking_end`
5. `lexical_content_start`
6. `lexical_content_delta`
7. `lexical_content_end`
8. `lexical_unquote_start`
9. `lexical_unquote_delta`
10. `lexical_unquote_end`
11. `lexical_tool_call_start`
12. `lexical_tool_call_delta`
13. `lexical_tool_call_end`
14. `lexical_usage`
15. `lexical_stop`
16. `lexical_error`

### Lexical Shared Fields

1. `trace`
2. `actor`
3. `team`
4. `lexical`
5. `event_type`

### Lexical Context Fields

1. `provider_name`
2. `adapter_name`
3. `model_name`
4. `protocol`
5. `response_id`
6. `stop_reason`
7. `chunk_index`

### Lexical Event-specific Fields

- `lexical_turn_start`
  - 仅包含 shared fields 与 `lexical`
- `lexical_thinking_start`
  - 仅包含 shared fields 与 `lexical`
- `lexical_thinking_delta`
  - `text`
- `lexical_thinking_end`
  - 仅包含 shared fields 与 `lexical`
- `lexical_content_start`
  - 仅包含 shared fields 与 `lexical`
- `lexical_content_delta`
  - `text`
- `lexical_content_end`
  - 仅包含 shared fields 与 `lexical`
- `lexical_unquote_start`
  - 仅包含 shared fields 与 `lexical`
- `lexical_unquote_delta`
  - `text`
- `lexical_unquote_end`
  - 仅包含 shared fields 与 `lexical`
- `lexical_tool_call_start`
  - 仅包含 shared fields 与 `lexical`
- `lexical_tool_call_delta`
  - `tool_call_delta`
- `lexical_tool_call_end`
  - 仅包含 shared fields 与 `lexical`
- `lexical_usage`
  - `usage`
- `lexical_stop`
  - `stop_reason`
- `lexical_error`
  - `error`

### Lexical Construction Rules

1. `lexical_turn_start` 在新 turn 的 provider 响应开始时产生。
2. `lexical_thinking_*` 仅对 thinking channel 的 chunk 边界和增量建模。
3. `lexical_content_*` 仅对 content channel 的 chunk 边界和增量建模。
4. `lexical_unquote_*` 仅对 unquote channel 的 chunk 边界和增量建模。
5. `lexical_tool_call_*` 仅对 provider tool-call delta 流的开始、增量和结束建模。
6. `lexical_usage` 仅在 provider 返回 usage 元数据时产生。
7. `lexical_stop` 在 provider 明确给出 stop reason 时产生，并携带同名 `stop_reason` 字段。
8. `lexical_error` 在 provider / adapter 将错误归一化后产生，并携带 `error` 结构。

## Syntactic Event Types

1. `syntactic_thinking_start`
2. `syntactic_thinking_delta`
3. `syntactic_thinking_end`
4. `syntactic_content_start`
5. `syntactic_content_delta`
6. `syntactic_content_end`
7. `syntactic_tool_text`
8. `syntactic_quote`
9. `syntactic_structured_node`
10. `syntactic_tool_call`
11. `syntactic_error`

### Syntactic Shared Fields

1. `trace`
2. `actor`
3. `team`
4. `event_type`

### Syntactic Event-specific Fields

- `syntactic_thinking_start`
  - 仅包含 shared fields
- `syntactic_thinking_delta`
  - `text`
  - `source`
- `syntactic_thinking_end`
  - 仅包含 shared fields
- `syntactic_content_start`
  - 仅包含 shared fields
- `syntactic_content_delta`
  - `text`
  - `source`
- `syntactic_content_end`
  - 仅包含 shared fields
- `syntactic_tool_text`
  - `text`
  - `source`
- `syntactic_quote`
  - `source`
  - `text`
- `syntactic_structured_node`
  - `source`
  - `raw_text`
  - `nodes`
  - `errors`
- `syntactic_tool_call`
  - `tool_call`
  - `source`
- `syntactic_error`
  - `source`
  - `errors`
  - `raw_text`

### Syntactic Construction Rules

1. `syntactic_thinking_start/delta/end` 由 lexical thinking 流直接投影，`source` 固定为 `thinking`。
2. `syntactic_content_start/delta/end` 由 lexical content 流直接投影，`source` 固定为 `content`。
3. `syntactic_tool_text` 由 tool channel 中未被解释为 tool-call / structured node 的文本产生，`source` 固定为 `tool`。
4. `syntactic_quote` 只在 `!quote_start ... !quote_end` 闭合后产生，不暴露半成品 quote。
5. `syntactic_structured_node` 只在 `!unquote_start ... !unquote_end` 闭合并完成结构解析后产生。
6. `syntactic_tool_call` 只在 lexical tool-call delta 完整聚合并归一化为 canonical `tool_call` 后产生。
7. `syntactic_error` 在 parser / executor / system 归一化错误后产生，保留 `source`、`errors` 与 `raw_text`。

## Semantic Event Types

1. `semantic_user_input`
2. `semantic_turn_start`
3. `semantic_turn_end`
4. `semantic_think_start`
5. `semantic_think_delta`
6. `semantic_think_end`
7. `semantic_content_start`
8. `semantic_content_delta`
9. `semantic_content_end`
10. `semantic_quote`
11. `semantic_tool_call_planned`
12. `semantic_tool_call_start`
13. `semantic_tool_call_result`
14. `semantic_questionnaire_request`
15. `semantic_questionnaire_result`
16. `semantic_actor_spawned`
17. `semantic_actor_state`
18. `semantic_mailbox_message`
19. `semantic_inbox_snapshot`
20. `semantic_task_state`
21. `semantic_task_board`
22. `semantic_plan_approval_request`
23. `semantic_plan_approval_result`
24. `semantic_shutdown_request`
25. `semantic_shutdown_result`
26. `semantic_background_result`
27. `semantic_team_status`
28. `semantic_notice`
29. `semantic_error`

### Semantic Shared Fields

1. `trace`
2. `actor`
3. `team`
4. `event_type`

### Semantic Event-specific Fields

- `semantic_user_input`
  - `text`
  - `input_source`
- `semantic_turn_start`
  - `turn_label`
- `semantic_turn_end`
  - `reason`
- `semantic_think_start`
  - 仅包含 shared fields
- `semantic_think_delta`
  - `text`
- `semantic_think_end`
  - 仅包含 shared fields
- `semantic_content_start`
  - 仅包含 shared fields
- `semantic_content_delta`
  - `text`
- `semantic_content_end`
  - 仅包含 shared fields
- `semantic_quote`
  - `source`
  - `text`
- `semantic_tool_call_planned`
  - `tool_call`
- `semantic_tool_call_start`
  - `tool_call`
- `semantic_tool_call_result`
  - `tool_call`
  - `output_text`
  - `is_error`
- `semantic_questionnaire_request`
  - `questionnaire_request`
  - `tool_call`
- `semantic_questionnaire_result`
  - `questionnaire_id`
  - `response_text`
  - `approved`
- `semantic_actor_spawned`
  - `parent_actor`
  - `spawn_reason`
- `semantic_actor_state`
  - `state`
  - `reason`
- `semantic_mailbox_message`
  - `message`
  - `direction`
- `semantic_inbox_snapshot`
  - `inbox`
- `semantic_task_state`
  - `task`
  - `transition`
- `semantic_task_board`
  - `board`
- `semantic_plan_approval_request`
  - `request_id`
  - `plan_text`
- `semantic_plan_approval_result`
  - `request_id`
  - `approved`
  - `feedback_text`
- `semantic_shutdown_request`
  - `request_id`
  - `target_name`
  - `reason_text`
- `semantic_shutdown_result`
  - `request_id`
  - `target_name`
  - `approved`
  - `reason_text`
- `semantic_background_result`
  - `background_result`
- `semantic_team_status`
  - `team_status`
- `semantic_notice`
  - `message`
  - `level`
- `semantic_error`
  - `error`

### Semantic Construction Rules

1. `semantic_user_input` 由人类输入、questionnaire 回答或系统注入的用户侧文本产生，`input_source` 保持原始 surface 语义。
2. `semantic_turn_start` / `semantic_turn_end` 在 runtime 明确进入和结束 assistant turn 时产生，不与 lexical block 边界混用。
3. `semantic_think_*` 和 `semantic_content_*` 由 syntactic thinking/content 事件提升而来，不直接读取 raw chunk。
4. `semantic_quote` 由闭合后的 `syntactic_quote` 提升而来，保留 `source` 与 `text`。
5. `semantic_tool_call_planned` 在 `syntactic_tool_call` 被解释为正式可执行工具调用时产生。
6. `semantic_tool_call_start` 在 runtime 真正开始执行工具调用时产生。
7. `semantic_tool_call_result` 在工具调用完成后产生，保留 `output_text` 和 `is_error`。
8. `semantic_questionnaire_request/result` 在 questionnaire 生命周期的请求与回填节点产生，可附带触发该问卷的 `tool_call`。
9. `semantic_actor_spawned`、`semantic_actor_state`、`semantic_mailbox_message`、`semantic_inbox_snapshot`、`semantic_task_state`、`semantic_task_board`、`semantic_team_status` 均由 runtime 协调层状态变化产生。
10. `semantic_plan_approval_request/result` 与 `semantic_shutdown_request/result` 由正式审批/停机流程驱动产生，而非普通 notice 文本。
11. `semantic_background_result` 仅在后台任务完成并形成结构化结果时产生。
12. `semantic_notice` 用于正式的非错误提示信息；`semantic_error` 用于已归一化的错误结构。

## Transcript Naming

### Stages

1. `lexical`
2. `syntactic`
3. `semantic`

### Lexical Streams

1. `lexicalThinkingStart`
2. `lexicalThinkingDelta`
3. `lexicalThinkingEnd`
4. `lexicalContentStart`
5. `lexicalContentDelta`
6. `lexicalContentEnd`
7. `lexicalUnquoteStart`
8. `lexicalUnquoteDelta`
9. `lexicalUnquoteEnd`
10. `lexicalToolCallStart`
11. `lexicalToolCallDelta`
12. `lexicalToolCallEnd`

### Syntactic Streams

1. `syntacticThinkingStart`
2. `syntacticThinkingDelta`
3. `syntacticThinkingEnd`
4. `syntacticContentStart`
5. `syntacticContentDelta`
6. `syntacticContentEnd`
7. `syntacticQuote`
8. `syntacticStructuredNode`
9. `syntacticToolCall`
10. `syntacticToolText`
11. `syntacticError`

### Semantic Streams

1. `semanticThinkStart`
2. `semanticThinkDelta`
3. `semanticThinkEnd`
4. `semanticContentStart`
5. `semanticContentDelta`
6. `semanticContentEnd`
7. `semanticQuote`
8. `semanticToolCallPlanned`
9. `semanticToolCallStart`
10. `semanticToolCallResult`
11. `semanticNotice`
12. `semanticError`

## Emission Timing Rules

1. lexical event 在 provider chunk 到达时立即产生，只建模 provider / adapter 看到的原始块级边界。
2. syntactic event 在 parser 完成结构识别或 canonical 聚合时产生，不提前暴露未闭合的 quote / unquote / tool-call。
3. semantic event 在 syntactic event 被解释为产品语义，或 runtime 协调状态发生正式变化时产生。
4. `!quote_start ... !quote_end` 只在闭合后形成 `syntactic_quote`，随后才允许提升为 `semantic_quote`。
5. `!unquote_start ... !unquote_end` 只在闭合后形成 `syntactic_structured_node`。
6. tool-call delta 需要先在 lexical 层完整聚合，随后才允许生成 `syntactic_tool_call`，再由语义层解释为 `semantic_tool_call_planned/start/result`。
7. semantic 层不得直接读取 lexical raw chunk；projector 不得绕过 semantic 直接读取 parser state。
