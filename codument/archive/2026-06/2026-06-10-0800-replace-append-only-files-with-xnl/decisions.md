# Decisions

## Usage
- 用于记录需要用户确认的决策问题、选项、最终结论与理由。
- 问题标题不用字母前缀；字母只用于选项。
- 后续执行过程中出现的新决策，也继续追加到本文件，不新建分散的决策记录。

### 1. 【P0】XNL 文件分类规则
- 背景：项目中 `.xnl` 同时用于 append-only streams、replace state、prompt source assets。
- 需要决定：是否把所有 `.xnl` 统一 append-only。
- 选项：
  - A) 只要是 `.xnl` 都必须 append-only。
  - B) 按语义分类：历史/audit/replay/evidence/diagnostic/message stream 必须 append-only；manifest/head/index/current-state 可以 replace。
  - C) 其他（可填写）。
- 当前建议：B。
- 用户答复：用户要求“其中应当是 append-only 场景纳入改造范围”，并指出如果实际 replace 但应 append 的设计也要纳入。
- 最终决策：采用 B，并增加 replace-written XNL 审查任务。
- 决策理由：XNL 文件不等于 append-only 文件；`manifest.xnl` 和 bounded current-state table 不应被错误改成 append-only。
- 状态：decided

### 2. 【P0】Questionnaire XNL 的处理
- 背景：`runtime_state/questionnaires.xnl` 当前通过 replace 写入 repeated `QuestionnaireRow`，它可能是 bounded current-state table，也可能被误用为历史事实表。
- 需要决定：是否直接把它改为 append-only。
- 选项：
  - A) 直接改成 append-only questionnaire lifecycle stream。
  - B) 保留 current-state table，但实现时必须证明它不承担历史/audit/replay 语义；如需要 lifecycle history，则拆出单独 append-only stream。
  - C) 其他（可填写）。
- 当前建议：B。
- 用户答复：尚未单独确认；本 track 先按“应 append-only 才纳入”原则处理。
- 最终决策：暂按 B 写入 spec 和 plan，执行阶段验证后如发现历史语义再拆 stream。
- 决策理由：现有规范明确 `questionnaires.xnl` 是 questionnaire state row table，不应在未证明需要前扩大为历史流。
- 状态：decided

### 3. 【P1】Observability XNL sinks 是否纳入本 track
- 背景：`trace.xnl` 和 `events.xnl` 不是原旧 track 的 legacy session storage 目标，但它们也是实际写入 `.xnl` 且语义为 append-only。
- 需要决定：是否一并纳入。
- 选项：
  - A) 纳入，本 track 统一所有 append-only XNL 文件格式规则。
  - B) 不纳入，另开 observability track。
  - C) 其他（可填写）。
- 当前建议：A。
- 用户答复：用户要求搜索项目中其他 `.xnl` 写入场景，并把其中应 append-only 的纳入此 track。
- 最终决策：采用 A。
- 决策理由：trace/events 是同类 append-only record-stream 问题；统一规则可以避免重复 root-wrapper 或 replace-growing-history 反模式。
- 状态：decided

### 4. 【P0】是否保留 transcript.xnl
- 背景：`history.xnl` 的 generation 和 message ref 当前都能携带 `actorKey` / `actorId`，独立的 `actors/<actor-dir>/transcript.xnl` 会形成 actor-local history surface，与 conversation history 存在双真源风险。
- 需要决定：本次改造是否继续保留 `transcript.xnl`。
- 选项：
  - A) 保留 `transcript.xnl`，作为 actor-local audit stream。
  - B) 删除独立 `transcript.xnl`，将 actor 来源与消息历史收敛到 `conversation/history.xnl`。
  - C) 其他（可填写）。
- 当前建议：B。
- 用户答复：用户明确要求“本次改造，需要顺手将 transcript.xnl 删掉”。
- 最终决策：采用 B。
- 决策理由：`history.xnl` 已能标记 actor 来源；保留 `transcript.xnl` 会增加重复写入、重复恢复和语义冲突。
- 状态：decided

### 5. 【P0】history.xnl 的 message/block 格式
- 背景：`history.xnl` 应直接表达 message 与 block 的关系，而不是把 JS object 整体塞入单个 data attributes。
- 需要决定：history record 的层级和格式化风格。
- 选项：
  - A) 顶层仍写 generation，message 藏在 attributes 中。
  - B) 顶层写 message，body 第二层写 block；`Think`/`Content` 为 text node，其他 block 为 data node；节点名、metadata、属性块保持在同一 opening line。
  - C) 其他（可填写）。
- 当前建议：B。
- 用户答复：用户确认“我要的就是这样”，并补充 `Think` 和 `Content` 应去掉 `mime` 字段；`Think` 和 `Content` 生成时应使用 ULID 作为 marker，而不是 `think_01` / `content_01` 这类语义化 marker；实现该格式可能需要参考 `/Users/kongweixian/lang/xnl.ts/packages/core` 自定义 formatter。
- 最终决策：采用 B，并要求 `Think` / `Content` 不包含 `mime` metadata，且 text marker 必须是生成的 ULID。
- 决策理由：message-first + block-second 结构最直接表达历史记录与块的关系；text node 适合承载自然语言正文；data node 适合承载工具调用、工具结果和结构化引用。
- 状态：decided

### 6. 【P0】prompts.xnl 的 prompt generation 格式
- 背景：当前 `prompts.xnl` 把整个 `ActorPromptGenerationData` 塞进 `generation` data node attributes，`basis`、`transforms`、`materializedContext` 的结构关系没有被 XNL 表达出来。
- 需要决定：prompt generation 的层级和 audit/cache 语义。
- 选项：
  - A) 保持旧格式，将整个 generation object 放进 attributes。
  - B) 顶层写 `PromptGeneration`，第二层拆出 `Basis`、`BasisRef`、`Transform`、`MaterializedContext`；`MaterializedContext` 为 ULID marker 的 text node；显式标记 audit truth 或 rebuildable cache。
  - C) 其他（可填写）。
- 当前建议：B。
- 用户答复：用户同意该设计，并要求记录到 track。
- 最终决策：采用 B。
- 决策理由：prompt generation 是结构化 audit/recovery 事实，不应把 basis、transform 和上下文正文隐藏在一个大 object 里；materialized context 是自然语言文本，适合 XNL text node。
- 状态：decided

### 7. 【P0】runtime-control/effects.xnl 的 effect lifecycle event 格式
- 背景：当前 `effects.xnl` 已经 append-only，但每条记录是外层 `runtime-control-effect` envelope，内层再用一个 `event` data node 承载完整 `AiRuntimeEffectLifecycleEvent` object。该格式能 replay，但没有把 request/waiting/result/failed 的生命周期语义表达成 XNL 结构。
- 需要决定：effect evidence 的顶层 record 和第二层节点格式。
- 选项：
  - A) 保持旧格式，将整个 lifecycle event 放进 `<event { ... }>`。
  - B) 顶层写 `RuntimeEffectEvent`，metadata 放 `sequence`、`kind`、`effectKind`、`effectId`、`handlerKey` 以及 idempotency/result/wait/error scan 字段；因为每条 lifecycle event 只有一个事件主体，但该主体本身有标签、metadata 和 attributes 语义，事件专属内容放在 `()` unique child 块中，例如 `<Request>`、`<Wait>`、`<Result>`、`<Error>`，不使用 `[]` body。
  - C) 其他（可填写）。
- 当前建议：B。
- 用户答复：用户同意该格式，并要求记录设计和示例；随后补充如果内层只有单个主体，不应使用 `[]` body；进一步指出当原本下层主体有 tag、metadata、attributes 语义时，应使用 `()` 保留下层节点语义，而不是压平成 `{}`。
- 最终决策：采用 B。
- 决策理由：runtime-control recovery 依赖 monotonic sequence 和 effect lifecycle replay；顶层 event-first 结构便于顺序恢复和过滤。`Request`/`Wait`/`Result`/`Error` 是有类型的下层节点，用 `()` 能保留其标签、metadata 与 attributes；大 payload 应使用 artifact ref 或 digest，避免进入 metadata。
- 状态：decided

### 8. 【P0】XNL record 中 `{}`、`()` 和 `[]` 的使用规则
- 背景：append-only record 需要既表达 XNL 层级优势，又避免为了单个主体制造不必要的 child list，或把有标签的下层节点压平成普通对象而丢失语义。
- 需要决定：什么时候使用顶层自定义属性块 `{ ... }`，什么时候使用 unique child block `(...)`，什么时候使用 body list `[ ... ]`。
- 选项：
  - A) 所有结构化内容都放入 `[]` body。
  - B) 纯键值对象结构使用自定义属性块 `{ ... }`；如果单个主体本身有 tag、metadata、attributes 或 text marker 语义，使用 `()` 保留该下层节点；只有当 record 真实包含多个并列/有序子节点、多个 ordered blocks、或 text node 与 data node 混合时，才使用 `[]` body。
  - C) 其他（可填写）。
- 当前建议：B。
- 用户答复：用户明确同意，并要求将该规则宗旨写入 track；随后补充 `()` 的格式化风格应类似 `[]`，opening line 以 `(` 结束，内部 child node 独立换行，最后用 `)>` 收束。
- 最终决策：采用 B。
- 决策理由：`{}` 适合纯键值对象；`()` 适合单个有标签下层节点，例如 `Data`、`DataRef`、`Request`、`Result`、`Payload`、`PayloadRef`；`[]` 适合表达一个 record 内多个子节点之间的顺序和关系，例如 history message blocks、prompt basis/transforms/materialized context。该规则能防止重新退化成“单个 event blob 外再包一层 body”的格式，同时避免丢失下层节点类型。
- 状态：decided

### 9. 【P0】logs/orchestration_history.xnl 的 orchestration event 格式
- 背景：当前 `orchestration_history.xnl` 已经 append-only，但每条记录是 `orchestration-history-event` envelope，内层 generic `event` data node 重复存放 `stream`、`kind` 和 `payload`。事件来源包括 `detached_actor`、`coordination_event`、`runtime_hook_event`、`member_message`、`autonomous_holon_event` 等。
- 需要决定：orchestration history record 的顶层与 payload 表达方式。
- 选项：
  - A) 保持旧格式，将 `stream/kind/payload` 都放进 nested `<event { ... }>`。
  - B) 顶层写 `OrchestrationEvent`，metadata 放 `version`、`sequence`、`observedAt`、`stream`、`kind`；因为每条 orchestration event 只有一个主体，但 payload/ref 具有独立类型语义，小 payload 用 `()` 内的 `<Payload>`，大型 hook/report payload 用 `()` 内的 `<PayloadRef>`。
  - C) 其他（可填写）。
- 当前建议：B。
- 用户答复：用户同意该格式。
- 最终决策：采用 B。
- 决策理由：orchestration history 是控制面 audit stream；stream/kind 是 scan 字段，应位于顶层。payload schema 随 stream/kind 变化；`Payload`/`PayloadRef` 本身有标签和属性语义，因此用 `()` 保留下层节点类型，必要时用 artifact ref 避免大 payload 挤进 metadata。
- 状态：decided

### 10. 【P1】runtime_state/questionnaires.xnl 的 current-state table 格式
- 背景：`questionnaires.xnl` 当前通过 replace 写入 `QuestionnaireRow` rows，用于 runtime snapshot/recovery 的当前 questionnaire 状态，而不是 lifecycle audit stream。
- 需要决定：是否将 `questionnaires.xnl` 改成 append-only，或保留 replace-state table 并优化 XNL shape。
- 选项：
  - A) 改成 append-only questionnaire lifecycle stream。
  - B) 保留 replace-written current-state table；`QuestionnaireRow` 继续作为 top-level row，row 内使用 `[]` 表达 `Request`、`Result`、`Metadata` 等多个有类型 child；如果需要 lifecycle audit，另拆 `questionnaire_events.xnl`。
  - C) 其他（可填写）。
- 当前建议：B。
- 用户答复：用户同意该方案。
- 最终决策：采用 B。
- 决策理由：questionnaire row 是 bounded recovery state，不应为了 `.xnl` 扩展名强行 append-only；但 row 内部确实有多个有类型组成部分，应使用 `[]` 保留关系。
- 状态：decided

### 11. 【P1】trace.xnl 的 TraceEntry 格式
- 背景：`SessionTraceSink` 和 terminal deprecated `SessionTraceStore` 都写 `TraceEntry`，但 record 语义不同；现有 payload/error/valueSnapshot 多以 JSON text node 保存。
- 需要决定：是否拆分 trace writer，或统一为兼容 `TraceEntry` 的 typed record shape。
- 选项：
  - A) 保持旧格式。
  - B) 保留 `TraceEntry` 顶层 tag 以兼容 import/CLI；增加 `traceKind` 区分 `observability` 与 `graph`；单个有类型 child 用 `()`，多个 child 用 `[]`。
  - C) 改成完全不同的顶层 tag。
- 当前建议：B。
- 用户答复：用户同意该方案。
- 最终决策：采用 B。
- 决策理由：同名 `TraceEntry` 兼容既有读取器；`traceKind` 防止不同 trace schema 混淆；`Payload`、`Error`、`Value` 等有标签主体应保留下层节点语义。
- 状态：decided

### 12. 【P1】scenes/*/events.xnl 的 scene event 格式
- 背景：`events.xnl` 当前 append `Message` records，message body 中包含 ordered `TextPart` 和 `ToolCall` nodes，已经接近正确。
- 需要决定：scene events 是否需要大改。
- 选项：
  - A) 保持 `Message` 顶层且不加序列信息。
  - B) 改为更明确的 `SceneMessage` 顶层 record，补 `version`、`sequence`、`sessionId`、`id`、`role`；message 内部继续使用 `[]` 表达 ordered text parts/tool calls。
  - C) 其他（可填写）。
- 当前建议：B。
- 用户答复：用户同意该方案。
- 最终决策：采用 B。
- 决策理由：scene message 内部天然是 ordered children；即使只有一个 text part，也应保持 `[]`，因为 schema 表达的是有序 message parts 和 tool calls。
- 状态：decided

### 13. 【P1】SceneStore manifest/events 的落盘目录与 manifest 格式
- 背景：`SceneStore` 当前代码模型是 `{rootDir}/scenes/{sessionId}/manifest.xnl + events.xnl`，这类 replay/observability 文件不应直接污染项目根目录。
- 需要决定：如果项目工作区启用 SceneStore 落盘，应写到哪里，以及 `manifest.xnl` 如何格式化。
- 选项：
  - A) 继续允许写到 workspace root 的 `scenes/`。
  - B) 写入 `.eidolon/scenes/<sessionId>/manifest.xnl` 和 `.eidolon/scenes/<sessionId>/events.xnl`；`manifest.xnl` 保持 replace-state，使用 `SceneManifest` 顶层，内部 `SystemPrompt` 和 `ToolDefs` 用 `[]` 表达。
  - C) 其他（可填写）。
- 当前建议：B。
- 用户答复：用户明确指出即使要存储该文件，也应放到 `.eidolon` 下，不应直接放到根目录中；并同意建议的 `manifest.xnl` 格式。
- 最终决策：采用 B。
- 决策理由：SceneStore 是 replay/observability 存储，不属于源码根目录内容；`.eidolon/scenes` 与 `.eidolon/sessions` 同属运行/观测数据边界。`manifest.xnl` 是 bounded replace-state，不承载 event history。
- 状态：decided

### 14. 【P0】实施前是否先建设项目级 XNL formatter/read/append helpers
- 背景：本 track 涉及多个 writer/reader。如果每个场景各自拼接或直接使用默认 stringify，容易再次偏离约定的 `{}` / `()` / `[]` 语义和格式化风格。
- 需要决定：是否在具体文件改造前先建设可复用基础设施。
- 选项：
  - A) 每个 writer 独立实现 formatter/read/append。
  - B) 参考 `/Users/kongweixian/lang/xnl.ts/packages/core`，先建设项目级通用 formatter、基于 fs 的 append helper、read helper，再让各场景复用。
  - C) 其他（可填写）。
- 当前建议：B。
- 用户答复：用户要求实施改造前增加这些任务，以尽可能复用逻辑。
- 最终决策：采用 B。
- 决策理由：统一 formatter 能稳定输出已讨论的 compact opening line、多行 `()` / `[]`、ULID marker 等格式；text node 内部正文行与该 text node 的 opening tag 对齐、不额外添加 `depth + 1` 缩进，避免 formatter 把非语义空白写进文本内容；统一 append/read helpers 能集中处理 append newline、directory creation、multi-root parse、root-wrapper guard、typed child extraction 和 legacy fallback 边界。read helper 必须基于 XNL 库提供的 parser/helper 能力封装实现，不能绕过 xnl-core 从头实现 parser。
- 状态：decided
