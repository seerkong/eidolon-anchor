# Design: repair-responses-canonical-replay

Responses replay 必须直接消费 Conversation materialization，使用独立的 `OpenAIResponsesCanonicalReplayCompiler` 生成 native items。它不能调用 `normalizeOpenAIChatMessages` 或 `repairOpenAIChatToolCallAdjacency`。

编译器按历史顺序处理每个 assistant tool call 和 tool result，维护 call/output lineage，并返回完整 projection receipt。只有完整闭合的 request 才能进入 `planResponsesRequest`。

Checkpoint 只是 canonical projection 的优化窗口。rewind/fork/history head movement 后应清除 replay checkpoint 和 continuation baseline，下一请求从 canonical compiler 全量重建。

Rewind/head movement 的持久 authority 与 context epoch 由 mission 的独立 `bind-rewind-context-epoch` track 承担。本 track 只保证 checkpoint 失效后的 canonical rebuild 完整正确，不修改 TUI revert 或 safepoint transaction 边界。
