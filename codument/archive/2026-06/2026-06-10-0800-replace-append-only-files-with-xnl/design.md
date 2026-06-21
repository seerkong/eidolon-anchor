## 上下文

本 track 重做 append-only XNL 文件存储设计。问题不是“是否使用 `.xnl` 扩展名”，而是是否把历史事实写成 XNL 的 append-only record stream，并用 XNL 的节点、metadata、text body、parser 校验来服务恢复、审计、诊断和 replay。

## 方案概览

1. 建立 XNL 文件分类规则
   - Append-only record stream：历史、audit、replay、diagnostic、evidence、message history、prompt materialization history、orchestration history。
   - Replace state：manifest、index、head、cursor、checkpoint marker、projection metadata、bounded current-state table。
   - Source asset：tool prompt `.xnl` 文件，只读，不属于运行时存储。

2. 统一 append-only XNL stream 形态
   - 每条记录写成一个 top-level XNL element。
   - 每次 append 写一条完整 XNL record 加换行。
   - 禁止单 root wrapper 包住持续增长的 child records。
   - metadata 放可扫描字段，例如 id、sequence、kind、actor、timestamp。
   - 大 payload 使用 XNL text element 或 artifact reference，避免在 metadata 塞大正文。
   - `{}` / `()` / `[]` 使用宗旨：纯键值对象结构使用 `{ ... }`；如果单个主体本身有 tag、metadata、attributes 或 text marker 语义，使用 `()` 保留下层节点；只有当 record 内真实存在多个并列子节点、ordered blocks、或 text node 与 data node 混合时，才使用 `[]` body。
   - 典型 `[]` 场景：`HistoryMessage` 下多个 block、`PromptGeneration` 下 basis refs/transforms/materialized context。
   - 典型 `()` 场景：单条 effect lifecycle event 下的 `Request`/`Result`，单条 orchestration event 下的 `Payload`/`PayloadRef`，单条 diagnostic event 下的 `Event`/`EventRef`。
   - 典型 `{}` 场景：节点自身的小型结构化属性，例如 `source`、`usage`、`output`、`authority`。不要把唯一主体无意义地再包成 `{ payload = ... }`；只有当 `payload` 确实需要与同级语义字段共存时才使用 payload 字段名。
   - `()` formatter 风格和 `[]` 一致：parent opening line 以 `(` 结束，内部 child node 独立换行，closing line 使用 `)>`。
   - 实施前先建设项目级通用 XNL 基础设施，参考 `/Users/kongweixian/lang/xnl.ts/packages/core` 的 AST/parser/stringify 语义：
     - formatter：稳定输出节点名、metadata、attribute block 同 opening line，`()`/`[]` block 内 child 独立换行，text node 使用 ULID marker；text node 内部正文行与该 text node 的 opening tag 对齐，不额外添加 `depth + 1` 缩进。
     - fs append helper：创建目录、一次 append 一个完整 top-level record 加换行、必要时串行化同文件并发 append。
     - read helper：基于 xnl-core 提供的 parser/helper 能力封装实现，parse multi-root append stream、拒绝 root-wrapper growing stream、按 tag/kind 读取 metadata/attributes/body/extend/text，提供 typed child extraction；禁止绕过 XNL 库从头实现 parser。

3. Session 目录 append-only 范围
   - `conversation/history.xnl`
   - `conversation/prompts.xnl`
   - `runtime-control/effects.xnl`
   - `logs/orchestration_history.xnl`
   - `logs/ingress.xnl`
   - `logs/diagnostics.xnl`

4. `history.xnl` message-first record format
   - 顶层 record 是单条 `HistoryMessage`，不是 generation wrapper。
   - `HistoryMessage` metadata 记录 message 级字段：`id`、`sessionId`、`actorKey`、`actorId`、`role`、`committedAt`、`sequence`、`generationId`、`blockCount`。
   - `HistoryMessage` attributes 记录 message 级小型结构化字段：`source`、`usage`、policy/provenance metadata。
   - `HistoryMessage` attributes 不持久化 transcript 形态的 `sourceRecords` payload blob（`{ stream, payload }` 数组，payload 与 block 正文重复）；该规则覆盖运行时写入、compaction 写入、history-generations JSON 迁移和 transcript-only legacy session 的 bootstrap 转换。读取侧继续兼容旧 records 中已存在的 `sourceRecords` attributes（例如 legacy tool_call_id 恢复和 user_input 历史提示）。
   - `HistoryMessage` body 第二层记录 blocks。
   - `Think` 和 `Content` 使用 XNL text node，不写 `mime` 字段。
   - `Think` 和 `Content` 的 text marker 使用生成的 ULID，不使用 `think_01` / `content_01` 这类语义化 marker。
   - 其他 block 使用 XNL data node，例如 `ToolCall`、`ToolResult`、`ArtifactRef`、`QuestionnaireRef`。
   - formatter 需要输出紧凑 opening line：节点名、metadata、属性块保持同一行。
   - 推荐样式：

```xnl
<HistoryMessage version=1 id="msg_01" sessionId="session_01" actorKey="primary" actorId="actor-main" role="assistant" committedAt=1770000000000 sequence=42 generationId="hist_primary_001" blockCount=4 { source = { kind = "runtime" provider = "openai" model = "gpt-5" } usage = { inputTokens = 1200 outputTokens = 320 } } [
  <Think id="msg_01.b0" index=0 ?01K2H7M9Q4W8ZP3N6B5C1D0EFA>
  我需要先检查用户的问题，再决定是否调用工具。
  </?01K2H7M9Q4W8ZP3N6B5C1D0EFA>

  <Content id="msg_01.b1" index=1 ?01K2H7M9Q4W8ZP3N6B5C1D0EFB>
  我会先读取当前文件，然后给出修改建议。
  </?01K2H7M9Q4W8ZP3N6B5C1D0EFB>

  <ToolCall id="msg_01.b2" index=2 toolCallId="call_abc" name="Read" { input = { filePath = "src/app.ts" } }>

  <ToolResult id="msg_01.b3" index=3 toolCallId="call_abc" status="ok" { output = { kind = "artifact_ref" artifactId = "artifact_123" bytes = 4096 sha256 = "..." } }>
]>
```

5. `prompts.xnl` prompt-generation-first record format
   - 顶层 record 是单条 `PromptGeneration`。
   - `PromptGeneration` metadata 记录 prompt generation 级字段：`id`、`sessionId`、`actorKey`、`actorId`、`reason`、`sealed`、`createdAt`、`updatedAt`。
   - `PromptGeneration` attributes 记录 authority/cache 分类，例如 `{ authority = { kind = "audit" recoverable = true cache = false } }`。
   - body 第二层拆出 `Basis`、`BasisRef`、`Transform`、`MaterializedContext`。
   - `MaterializedContext` 使用 XNL text node，并使用生成的 ULID marker。
   - `Basis`、`BasisRef`、`Transform` 使用 XNL data node。
   - 推荐样式：

```xnl
<PromptGeneration version=1 id="prompt_01" sessionId="session_01" actorKey="primary" actorId="actor-main" reason="request_build" sealed=false createdAt="2026-06-07T03:00:00.000Z" updatedAt="2026-06-07T03:00:01.000Z" { authority = { kind = "audit" recoverable = true cache = false } } [
  <Basis version=1 { historyGenerationIds = ["hist_01"] messageRecordIds = ["msg_01" "msg_02"] }>

  <BasisRef index=0 kind="history_generation" refId="hist_01" { metadata = { reason = "active_history" } }>

  <BasisRef index=1 kind="message" refId="msg_01" { metadata = { role = "user" } }>

  <Transform id="prompt_01.t0" index=0 kind="history_compaction_summary" appliedAt="2026-06-07T03:00:00.500Z" { payload = { sourceHistoryGenerationId = "hist_00" targetHistoryGenerationId = "hist_01" } }>

  <MaterializedContext id="prompt_01.ctx" ?01K2H8CE7S3Z9Y6T4A1B2C3D4E>
  这里是最终 materialized prompt context 或 summary/context 内容。
  </?01K2H8CE7S3Z9Y6T4A1B2C3D4E>
]>
```

6. `runtime-control/effects.xnl` effect-lifecycle-event-first record format
   - 顶层 record 是单条 `RuntimeEffectEvent`，代表一个 effect lifecycle event，而不是 envelope + nested `event` object blob。
   - `RuntimeEffectEvent` metadata 记录 replay/scan 关键字段：`version`、`sequence`、`kind`、`effectKind`、`effectId`、`handlerKey`。
   - request/waiting 事件额外记录 `idempotencyKey`、`sourceCommandId`、`waitReason` 等可扫描字段。
   - result 事件额外记录 `resultId`。
   - failed 事件额外记录 `retryable`；错误正文放 `Error` data node。
   - 每条 lifecycle event 只有一个事件主体，因此不使用 `[]` body；但事件主体本身有 tag、metadata 和 attributes 语义，因此使用 `()` 保留下层节点，例如 `Request`、`Wait`、`Result`、`Error`。
   - 小型结构化主体直接展开到对应下层节点 attributes 中；不要默认包一层 `payload`。例如 bash result 直接写 `exitCode/stdoutRef/stderrRef`，permission wait 直接写 `scope/action`。
   - 只有当事件主体同时存在多个同级语义分区，且其中一个分区明确名为 payload 时，才允许出现 `payload` 字段；否则 `payload` wrapper 是无意义嵌套。
   - 大型正文、provider/tool 原始输出应写 artifact ref、digest 或 bounded summary，不进入顶层 metadata。
   - 工具长输出支持使用 `outputTextRef` 指向 artifact；短输出可以 inline 为 `OutputText` text child 或小型 `outputText` attribute，但不得再包入 `payload`。
   - 推荐样式：

```xnl
<RuntimeEffectEvent version=1 sequence=1 kind="request" effectKind="bash" effectId="effect-1" handlerKey="bash" idempotencyKey="fiber:effect-1" sourceCommandId="cmd-1" (
  <Request { command = "ls" cwd = "/repo" }>
)>

<RuntimeEffectEvent version=1 sequence=2 kind="waiting" effectKind="permission" effectId="effect-permission-1" handlerKey="permission:local" idempotencyKey="fiber:permission-1" waitReason="requires_user_approval" (
  <Wait { scope = "filesystem" action = "write" }>
)>

<RuntimeEffectEvent version=1 sequence=3 kind="result" effectKind="bash" effectId="effect-1" handlerKey="bash" resultId="result-1" (
  <Result toolCallId="call_01" exitCode=0 outputTextRef="artifact_123" stderrTextRef=null>
)>

<RuntimeEffectEvent version=1 sequence=4 kind="failed" effectKind="mcp_tool" effectId="effect-2" handlerKey="mcp:filesystem.read" retryable=false (
  <Error { message = "missing_ai_runtime_effect_handler:mcp:filesystem.read" retryable = false }>
)>
```

7. `logs/ingress.xnl` typed ingress stream format
   - `ingress.xnl` 是原始 ingress 事件流，必须保留 token delta 语义，不做聚合、合并、flush chunk 或额外文本处理。
   - `ingress.xnl` 的目标是接近旧 `transcript.txt` 的直接可读性，同时保留 XNL 节点标签、metadata、属性和 parser 语义。
   - 不再使用 `IngressEvent` 顶层节点 + `Data` child + `{ payload = ... }` 的多层通用包装。
   - 顶层节点直接表达 ingress 类别：文本 delta 类使用 `ThinkDelta`、`ContentDelta` 等 XNL text nodes；结构化类使用具体 data node，例如 `ToolCallDelta`、`ToolResultDelta`、`StreamStart`、`StreamEnd`。
   - think/content 正文直接写在 text node 内容里，便于人工打开文件查看，不再作为 JSON string 或 payload 字段嵌套。
   - 每个 provider/token delta 对应一条 XNL record；不得为了可读性合并多个 delta。可读性通过去掉 `IngressEvent/Data/payload` 包装和使用 text node 正文实现。
   - 顶层 metadata 记录 `version`、`sequence`、`observedAt`、`sessionId`、`agentKey`、`agentActorId`、`stream`、`event` 等扫描字段。
   - 结构化事件如果只有纯键值字段，直接用顶层 `{}`；如果有单个带自身语义的主体，才使用 `()`。
   - 推荐样式：

```xnl
<ThinkDelta version=1 sequence=1 observedAt=1770000000000 sessionId="session_01" agentKey="primary" agentActorId="actor-main" stream="think" event="delta" ?01K2H8CE7S3Z9Y6T4A1B2C3D4F>
我
</?01K2H8CE7S3Z9Y6T4A1B2C3D4F>

<ContentDelta version=1 sequence=2 observedAt=1770000000100 sessionId="session_01" agentKey="primary" agentActorId="actor-main" stream="content" event="delta" ?01K2H8CE7S3Z9Y6T4A1B2C3D4G>
当前
</?01K2H8CE7S3Z9Y6T4A1B2C3D4G>

<StreamStart version=1 sequence=3 observedAt=1770000000150 sessionId="session_01" agentKey="primary" agentActorId="actor-main" stream="control" event="StreamStart">

<ToolCallDelta version=1 sequence=4 observedAt=1770000000200 sessionId="session_01" agentKey="primary" agentActorId="actor-main" stream="tool" event="tool_call_start" { toolCallId = "call_01" name = "Read" arguments = { filePath = "src/app.ts" } }>

<ToolResultDelta version=1 sequence=5 observedAt=1770000000300 sessionId="session_01" agentKey="primary" agentActorId="actor-main" stream="tool" event="tool_call_result" { toolCallId = "call_01" status = "ok" outputTextRef = "artifact_123" }>
```

8. `logs/orchestration_history.xnl` orchestration-event-first record format
   - 顶层 record 是单条 `OrchestrationEvent`，代表一个 orchestration control/audit event。
   - `OrchestrationEvent` metadata 记录 `version`、`sequence`、`observedAt`、`stream`、`kind`。
   - 现有 stream/kind 样本包括 `detached_actor/detached_actor_done`、`coordination_event/coordination_ingest`、`runtime_hook_event/hook_dispatch_report`、`member_message/member_message_sent`、`autonomous_holon_event/autonomous_holon_claim`。
   - 每条 orchestration event 当前只有一个主体，因此不使用 `[]` body；但 `Payload` / `PayloadRef` 是有标签的下层节点，使用 `()` 保留其语义。
   - 小型结构化 payload 使用 `()` 中独立换行的 `<Payload { ... }>`；大型 hook report、长文本、复杂诊断对象使用 `()` 中独立换行的 `<PayloadRef ...>`。
   - 推荐样式：

```xnl
<OrchestrationEvent version=1 sequence=1 observedAt=1770000000000 stream="detached_actor" kind="detached_actor_done" (
  <Payload { taskId = "task-1" taskKind = "run_delegate_actor" status = "completed" toolCallId = "call_01" childFiberId = "fiber_child" childActorKey = "worker" childActorId = "actor_02" }>
)>

<OrchestrationEvent version=1 sequence=2 observedAt=1770000000100 stream="coordination_event" kind="coordination_ingest" (
  <Payload { from = "member_a" coordination = "shutdown" coordinationKind = "shutdown_done" requestId = "req_01" status = "done" decision = null }>
)>

<OrchestrationEvent version=1 sequence=3 observedAt=1770000000200 stream="runtime_hook_event" kind="hook_dispatch_report" (
  <PayloadRef artifactId="artifact_hook_01" bytes=2048 sha256="...">
)>
```

8. `runtime_state/questionnaires.xnl` current-state-table format
   - 该文件是 replace-written bounded current-state table，不是 append-only stream。
   - 顶层是多个 `QuestionnaireRow` rows；每次 snapshot replace 整个 table。
   - `QuestionnaireRow` metadata 记录 `version`、`questionnaireId`、`toolCallId`、`status`、`suspendPolicy`、owner/session/timestamp scan 字段。
   - row 内部包含多个有类型组成部分，因此使用 `[]` body。
   - `Request`、`Result`、`Metadata` 使用 data/text child 保留语义；如果需要 questionnaire lifecycle audit/replay，应另拆 `questionnaire_events.xnl` append-only stream。
   - 推荐样式：

```xnl
<QuestionnaireRow version=1 questionnaireId="q1" toolCallId="call1" status="answered" suspendPolicy="pause_all" updatedAt=1770000000000 [
  <Request kind="approval" questionCount=1 { title = "确认操作" questions = [{ id = "approve" type = "yes_no" required = true }] }>

  <Result status="ok" { answers = { approve = true } } (
    <RawText ?01K2HA0R5ZK8V4D3N2M1C0B9A8>
    yes
    </?01K2HA0R5ZK8V4D3N2M1C0B9A8>
  )>

  <Metadata { source = "runtime" }>
]>
```

9. `trace.xnl` TraceEntry append-only format
   - 该场景覆盖 `sessions/<sessionId>/trace.xnl` 和 terminal/caller-provided `trace.xnl`。
   - 保留顶层 tag `TraceEntry` 以兼容 trace import/CLI。
   - 使用 `traceKind="observability"` 或 `traceKind="graph"` 区分 `SessionTraceSink` 与 terminal graph trace。
   - common metadata：`version`、`traceKind`、`sequence`/`seq`、timestamp、session/request/conversation/tool/node scan 字段。
   - 单个有标签主体使用 `()`，例如 `Payload`、`Error`、`Value`；如果同时有 payload 和 error，则使用 `[]`。
   - 推荐样式：

```xnl
<TraceEntry version=1 traceKind="observability" sequence=12 eventName="semantic_content_delta" source="semantic" stage="delta" emittedAt=1770000000000 sessionId="s1" (
  <Payload { text = "hello" }>
)>

<TraceEntry version=1 traceKind="observability" sequence=13 eventName="tool_error" source="runtime" stage="error" emittedAt=1770000000100 sessionId="s1" [
  <Payload { tool = "Read" }>
  <Error code="ENOENT" { message = "file not found" }>
]>

<TraceEntry version=1 traceKind="graph" id="trace-1" seq=7 ts=1770000000200 phase="after" op="set" nodeId="n1" (
  <Value ?01K2HA1BE7ZT9X5Y4W3V2U1T0S>
  {"status":"done"}
  </?01K2HA1BE7ZT9X5Y4W3V2U1T0S>
)>
```

10. `.eidolon/scenes/<sessionId>/events.xnl` scene-message append-only format
   - 该文件是 append-only scene event stream。
   - 如果 SceneStore 在项目工作区落盘，文件必须位于 `.eidolon/scenes/<sessionId>/events.xnl`，不能直接写到 workspace root 的 `scenes/`。
   - 顶层 message record 使用 `SceneMessage`，比旧 `Message` 更明确。
   - metadata 记录 `version`、`sequence`、`id`、`sessionId`、`role`。
   - message 内部是 ordered `TextPart` 和 `ToolCall` 子节点，因此使用 `[]`；即使当前只有一个 `TextPart`，也保持 ordered list schema。
   - 推荐样式：

```xnl
<SceneMessage version=1 sequence=1 id="msg1" sessionId="s1" role="assistant" [
  <TextPart index=0 ?01K2HA2PA9QB8RC7SD6TE5VF4G>
  我会读取文件。
  </?01K2HA2PA9QB8RC7SD6TE5VF4G>

  <ToolCall id="call1" index=1 name="Read" { args = { filePath = "src/app.ts" } }>
]>
```

11. `.eidolon/scenes/<sessionId>/manifest.xnl` scene manifest replace-state format
   - 该文件是 SceneStore replay/observability 的 bounded replace-state，不是 append-only stream。
   - 如果 SceneStore 在项目工作区落盘，文件必须位于 `.eidolon/scenes/<sessionId>/manifest.xnl`，不能直接写到 workspace root 的 `scenes/`。
   - 顶层 record 使用 `SceneManifest`，metadata 记录 `version`、`sessionId`、`createdAt`、`updatedAt`、`toolCount`。
   - `SceneManifest` 内部有 `SystemPrompt` 和 `ToolDefs` 两个并列组成部分，因此使用 `[]`。
   - `SystemPrompt` 是自然语言，使用 text node 和 ULID marker。
   - `ToolDefs` 是 tool definition list，使用 `[]`；每个 `ToolDef` 如只有 description text child，使用 `()`。
   - `manifest.xnl` SHALL NOT include growing message/event history; messages remain in `events.xnl`。
   - 推荐样式：

```xnl
<SceneManifest version=1 sessionId="s1" createdAt=1770000000000 updatedAt=1770000001000 toolCount=2 [
  <SystemPrompt ?01K2HB0Q4N6Y8M3C2D1E0F9G8H>
  You are an AI assistant...
  </?01K2HB0Q4N6Y8M3C2D1E0F9G8H>

  <ToolDefs count=2 [
    <ToolDef name="Read" (
      <Description ?01K2HC0Q4N6Y8M3C2D1E0F9G8H>
      Read a file from the workspace.
      </?01K2HC0Q4N6Y8M3C2D1E0F9G8H>
    )>

    <ToolDef name="Write" (
      <Description ?01K2HD0Q4N6Y8M3C2D1E0F9G8H>
      Write content to a file.
      </?01K2HD0Q4N6Y8M3C2D1E0F9G8H>
    )>
  ]>
]>
```

12. 删除独立 actor transcript XNL
   - `actors/<actor-dir>/transcript.xnl` 不再作为独立 append-only stream 保留。
   - actor 来源必须写入 `conversation/history.xnl` 的 generation metadata 和 message metadata。
   - legacy `transcript.txt` / `transcript.xnl` 只作为迁移输入、兼容提示或 quarantine 对象，不再作为恢复真源。

13. Replace-written XNL 审查范围
   - `runtime_state/questionnaires.xnl`：默认视为 bounded current-state table；执行阶段必须用测试证明它不是历史流。
   - 如 questionnaire lifecycle 需要 audit/replay，新增单独 append-only XNL stream，而不是把 lifecycle history 混进 current-state table。
   - `.eidolon/scenes/<sessionId>/manifest.xnl`：明确为 replace state，不纳入 append-only 改造。

14. Observability XNL append-only 范围
   - `sessions/<sessionId>/trace.xnl`
   - caller-provided `trace.xnl` in terminal organ trace store
   - `.eidolon/scenes/<sessionId>/events.xnl`
   - 这些文件遵守和 session streams 相同的 top-level record rule。

15. 迁移与兼容
   - legacy JSON/JSONL/plain text append-only files 只作为 migration input。
   - migration 后隔离旧文件，运行时恢复不再把旧文件作为 authoritative source。
   - UI/TUI 可以检测 legacy 文件用于展示或提示，但不能让 legacy 文件重新成为恢复真源。

## 影响范围与修改点（Impact）

- `cell/packages/ai-file-store-logic/src/index.ts`
  - 建设共享 XNL formatter、fs append helper、read helper；强化 migration、root-wrapper guard、format tests。
- `cell/packages/ai-support/src/conversation/local/LocalFileConversationPersistenceRepository.ts`
  - history message-first formatter, prompts append-only record format, and readers。
- `cell/packages/ai-support/src/runtime/LocalFileMessageHistoryEffects.ts`
  - 停止创建 transcript.xnl，并将 actor-origin history 写入 conversation history 路径。
- `cell/packages/ai-support/src/runtime/LocalFileActorTranscriptStore.ts`
  - 删除或降级为 legacy migration/compat helper，不再作为新 session writer。
- `cell/packages/ai-support/src/runtime/LocalFileOrchestrationHistoryEffects.ts`
  - orchestration append-only event stream。
- `cell/packages/ai-support/src/runtime/LocalFileRuntimeSnapshotRepository.ts`
  - questionnaire table boundary verification。
- `cell/packages/ai-organ-logic/src/runtime/SessionRuntimeXnlLogs.ts`
  - ingress/diagnostics append-only stream tests and format checks。
- `cell/packages/ai-organ-logic/src/observability/SessionTraceSink.ts`
  - trace append-only format checks。
- `cell/packages/ai-organ-logic/src/observability/SceneStore.ts`
  - events append-only and manifest replace-state boundary。
- `terminal/packages/organ/src/observability/SessionTraceStore.ts`
  - terminal trace file append-only format consistency。

## 决策摘要

- 详见 `codument/tracks/replace-append-only-files-with-xnl/decisions.md`。
- 当前关键结论：
  - `.xnl` 文件按语义分类，不一刀切。
  - should-be-append-only 的 replace-written XNL 必须转换或拆分。
  - observability append-only XNL sinks 纳入本 track。
  - 独立 `transcript.xnl` 删除，actor 来源收敛进 `history.xnl`。
  - `history.xnl` 采用 message-first / block-second 格式，`Think` 和 `Content` 无 `mime` 字段且使用 ULID text marker。
  - `prompts.xnl` 采用 prompt-generation-first 格式，显式拆出 basis、basis refs、transforms、materialized context，并标记 audit/cache authority。
  - `effects.xnl` 采用 `RuntimeEffectEvent` lifecycle-event-first 格式，顶层 metadata 保留 replay/scan 字段；因为每条 event 只有单个有标签主体，事件专属内容使用多行 `()` 中的 `Request` / `Wait` / `Result` / `Error` 节点，不使用 `[]` body。
  - `{}` / `()` / `[]` 规则：纯键值主体用 `{}`；单个有标签/metadata/attributes/text marker 语义的下层节点用 `()`；多并列子节点、ordered blocks、text/data 混合时才使用 `[]`。
  - `orchestration_history.xnl` 采用 `OrchestrationEvent` stream-event-first 格式，单 payload/ref 使用 `()` 保留下层节点语义。
  - `questionnaires.xnl` 保留 replace-written current-state table；row 内多个有类型组成部分使用 `[]`。
  - `trace.xnl` 保留 `TraceEntry`，用 `traceKind` 区分 observability/graph trace；单 child 用 `()`，多 child 用 `[]`。
  - `events.xnl` 采用 `SceneMessage` append-only record，message 内部 ordered parts/tool calls 使用 `[]`。
  - SceneStore 落盘路径必须位于 `.eidolon/scenes/<sessionId>/...`；不得直接写 workspace root `scenes/`。
  - `manifest.xnl` 采用 `SceneManifest` replace-state 格式，内部 `SystemPrompt` / `ToolDefs` 使用 `[]`，不承载 event history。

## 风险 / 权衡

- 风险：误把 current-state table 改成 append-only，增加恢复复杂度。
  - 缓解：先写分类测试和 questionnaire boundary 测试。
- 风险：append-only stream 中 metadata 过大，导致扫描成本上升。
  - 缓解：metadata 只放扫描字段，大 payload 放 text body 或 artifact reference。
- 风险：legacy fallback 悄悄恢复为真源。
  - 缓解：迁移测试断言 legacy 文件只可 quarantine/read-for-upgrade，不可作为 new upgraded session authoritative source。

## 兼容性设计

- 保留 legacy migration input 读取。
- 保留 TUI 对 legacy 文件的检测能力，但其语义是展示/提示/兼容，不是恢复真源。
- 对已存在的 replace-written bounded XNL state 保持兼容，除非测试证明其承载历史事实。

## 迁移计划

1. 建立分类与格式测试。
2. 修正或补强 append-only writer。
3. 删除 transcript.xnl 新写入路径，并把 legacy transcript 输入迁移进 history.xnl 或隔离。
4. 审查 replace-written XNL 文件；对 should-append-only 的场景转换或拆分。
5. 更新 migration，隔离 legacy append-only files。
6. 补齐 recovery/upgrade/TUI/observability 测试。

## 待解决问题

- 是否需要新增 `runtime_state/questionnaire_events.xnl`，取决于执行阶段对 questionnaire lifecycle 需求的验证。
- 是否需要把 append-only XNL record schema 抽成共享 typed builders，取决于重复度和当前 helper 是否足够表达。
- history formatter 应优先复用或参考 `xnl-core` AST/stringify 规则，避免手写 XML 风格拼接。
