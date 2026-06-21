# 变更：重做 append-only XNL 文件存储

## 背景和动机 (Context And Why)

原归档 track 将一批 append-only 存储改成了 `.xnl` 文件，但设计没有充分使用 XNL 的结构优势，也没有系统区分“append-only record stream”和“replace-written state file”。这会导致两类风险：一类是历史记录被写成 replace 形态，失去 append-only 恢复与审计语义；另一类是所有 `.xnl` 被一刀切，误伤本来应当 replace 的 bounded state。

本 track 回炉重做：先定义 `.xnl` 文件写入分类规则，再把所有应当 append-only 的 XNL 写入场景纳入改造范围。

## “要做”和“不做” (Goals / Non-Goals)

**目标:**
- 将所有 session 目录内应当 append-only 的 XNL 文件统一设计成“一个 top-level XNL record 一次 append”的格式。
- 纳入实际已经写 `.xnl` 的 append-only 场景：conversation history、prompt generation audit、runtime-control effects、orchestration history、ingress logs、diagnostics logs。
- 删除独立的 `actors/<actor-dir>/transcript.xnl` 持久化面，将 actor 来源信息收敛到 `conversation/history.xnl` 的 generation/message metadata。
- 纳入 observability 中实际写 `.xnl` 且语义为 append-only 的场景：trace sinks、scene events。
- 明确 replace-written XNL 的边界：manifest、head、index、checkpoint marker、bounded current-state table 可以 replace，但不能包含历史记录正文。
- 对当前 replace-written `runtime_state/questionnaires.xnl` 做语义审查：如果它只是 current-state row table，则保留 replace；如果存在 lifecycle/audit 需求，则拆出 append-only stream。
- 强化测试，防止 root-wrapper XNL、JSONL/plain text 回退、replace-growing-history 等格式退化。

**非目标:**
- 不把 prompt asset 源文件 `Tool.brief.xnl` / `Tool.detail.xnl` 纳入运行时存储改造。
- 不强制把所有 `.xnl` 文件都改成 append-only。
- 不在 VM snapshot JSON 中恢复大段消息、工具输出或 provider-private payload。
- 不把 bounded head/index JSON 改造成 XNL，除非它们实际承载历史记录正文。

## 变更内容（What Changes）

- **BREAKING**：新建或升级后的 session 不再把 append-only 历史事实写入 JSON/JSONL/plain text 或 replace-growing XNL wrapper。
- `appendXnlRecord` / `readXnlRecords` 作为共享 append-only XNL primitive，需要覆盖所有保留的 session append-only record streams。
- `transcript.xnl` 不再作为独立 append-only stream 保留；legacy `transcript.txt` / `transcript.xnl` 只作为迁移输入或兼容提示来源。
- `SessionRuntimeXnlLogs` 的 ingress/diagnostics XNL logs 纳入正式范围，而不是只作为旁路诊断文件。
- observability trace/scene event XNL sinks 必须遵守相同 append-only record-stream 规则。
- `questionnaires.xnl` 的定位从“默认 XNL 就正确”改为“必须证明是 bounded current state；否则拆 append-only lifecycle stream”。
- `history.xnl` 改为 message-first 格式：顶层是 message，第二层是 block；`Think`/`Content` 使用 text node 且不写 `mime` 字段，其他 block 使用 data node。
- `prompts.xnl` 改为 prompt-generation-first 格式：顶层是 `PromptGeneration`，第二层拆出 `Basis`、`BasisRef`、`Transform`、`MaterializedContext`，并显式标记 audit truth 与 rebuildable cache。
- 为满足紧凑 XNL 输出，新增或调整基于 `xnl-core` 语法/AST 的自定义 formatter，确保节点名、metadata、属性块保持在同一 opening line。
- 新增或更新测试，覆盖文件格式、写入方式、迁移、读取、恢复和非目标排除。

## 影响范围（Impact）

- 受影响的功能规范：
  - `aiagent-persistence-recovery`
  - `ai-runtime-observability-rx-sinks`
- 受影响的代码：
  - `cell/packages/ai-file-store-logic/src/index.ts`
  - `cell/packages/ai-support/src/conversation/local/LocalFileConversationPersistenceRepository.ts`
  - `cell/packages/ai-support/src/runtime/LocalFileMessageHistoryEffects.ts`
  - `cell/packages/ai-support/src/runtime/LocalFileActorTranscriptStore.ts`
  - `cell/packages/ai-support/src/runtime/LocalFileOrchestrationHistoryEffects.ts`
  - `cell/packages/ai-support/src/runtime/LocalFileRuntimeSnapshotRepository.ts`
  - `cell/packages/ai-support/src/runtime/QuestionnaireXnlStore.ts`
  - `cell/packages/ai-organ-logic/src/runtime/SessionRuntimeXnlLogs.ts`
  - `cell/packages/ai-organ-logic/src/observability/SessionTraceSink.ts`
  - `cell/packages/ai-organ-logic/src/observability/SceneStore.ts`
  - `terminal/packages/organ/src/observability/SessionTraceStore.ts`
  - TUI readers that inspect `transcript.xnl` or questionnaire state
