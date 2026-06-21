## 上下文

项目吸引子要求底层以 actor/fiber/mailbox/selective receive、append-only event log、ordered timeline、reducer projection、persistence ports 为核心。现有 persistence spec 已把 actor message history 归属到 actor-scoped transcript，把 VM snapshot 定义为 durable subset。

当前问题是 VM control signal store 泄漏了 message/content 层数据：LLM/tool completion payload 被作为 durable signal payload 写进 `vm.json`。这让 control truth、content truth、projection/cache 的边界变得不清晰，并导致长期运行 session 的 `vm.json` 持续增长。

## 方案概览

1. 分离 signal runtime form 与 snapshot form
  - runtime 内部可以继续通过 `emitFiberSignal` 完成“持久化调度事实 + enqueue mailbox payload”的原子操作。
  - snapshot 中的 durable control signal 必须是 bounded form。
  - full mailbox payload 不再直接进入 VM-level `controlSignals.events[*].payload`。

2. 引入 payload ref / tombstone 语义
  - 对 consumed signals，保留 `eventId`、`idempotencyKey`、`signalKind`、`signalClass`、`actorKey`、`fiberId`、`mailboxKind`、`opId`、`toolCallId`、`createdAt`、`priority`、small digest/status。
  - 对 pending signals，保证恢复可重新投递：优先依赖 actor mailbox snapshot 中的 payload；必要时使用 payload ref 指向 artifact/conversation generation。
  - 对 legacy full-payload signals，hydrate 时接受，save 时输出新 bounded format。

3. 保持 actor mailbox durability
  - 未消费 mailbox payload 属于 actor-owned queue，继续写入 actor mailbox snapshot。
  - 如果 payload 已进入 transcript/conversation/artifact，mailbox 和 control signal 不再重复长期保存完整内容。

4. Control signal compaction
  - consumed signal records 不再无限保留完整 event。
  - 设计一个 idempotency tombstone window 或 checkpoint 结构，满足近期去重和恢复审计。
  - pending signals 不能被剪掉。

5. Guard tests
  - 构造 LLM/tool/MCP completion fixture。
  - 断言 `vm.json` 不含 `reasoning_content`、完整 `tool_done.outputText`、完整工具 schema。
  - 断言 consumed 历史增加不会让 `vm.json` 按 payload 字节线性增长。

6. Questionnaire durable table
  - Questionnaire is a first-class runtime state table, not actor snapshot payload.
  - Runtime memory truth is `VmSessionState.questionnaires`; `actorSurface` must remain a reducer/projection for UI interaction and must not own the questionnaire table.
  - Durable rows live in `runtime_state/questionnaires.xnl`; the file contains repeated `QuestionnaireRow` data nodes directly, without an outer wrapper node.
  - XNL read/write must use `xnl-core` AST helpers (`parseXnl`, `XNL.stringify`, `DataElementNode`, `TextElementNode`) and must not use XML syntax or ad hoc string manipulation.
  - Actor runtime may keep transient pending-questionnaire caches for executor compatibility, but `RuntimeSnapshotActor` and actor `state.json` must not persist questionnaire request payloads.
  - Recovery loads `questionnaires.xnl` into `VmSessionState.questionnaires`, rebuilds pending surface projection, and repopulates transient actor caches by filtering `QuestionnaireRow.status === "pending"`.
  - Actor surface submit/answer paths update the VM session table; surface reads never create or mutate questionnaire rows as a side effect.

## 影响范围与修改点（Impact）

- Contract:
  - `DurableControlSignalData` / snapshot equivalent
  - `RuntimeSnapshotVm`
  - `QuestionnaireRow` / questionnaire table snapshot fields
- Logic:
  - durable control signal emit/consume/pending projection
  - VM snapshot serialize/hydrate
  - recovery redelivery for pending signals
  - legacy signal normalization
- Support:
  - local runtime snapshot repository writes `runtime_state/questionnaires.xnl` beside `vm.json`
  - TUI local session loading reads pending questionnaires from `questionnaires.xnl`
- Tests:
  - durable control signal tests
  - runtime recovery tests
  - snapshot repository tests
  - targeted guard tests for forbidden fields and bounded growth

## 决策摘要

- 详见 `decisions.md`
- 当前建议：
  - control signal snapshot should use bounded payload metadata plus payload refs.
  - legacy full payloads should be accepted on hydrate and normalized on next save.
  - consumed signal compaction should keep a bounded idempotency tombstone window.

## 风险 / 权衡

- 风险：过早移除 pending signal payload 会导致 recovery 无法 redeliver mailbox messages。
  - 缓解措施：pending redelivery must use actor mailbox snapshot or explicit payload refs; add recovery tests.
- 风险：旧 session 中 full-payload signal 被直接丢弃导致恢复失败。
  - 缓解措施：legacy hydrate accepts old payload; save path normalizes after recovery.
- 风险：tombstone window 太短导致 idempotency 重复。
  - 缓解措施：先使用 conservative window and tests; record decision in `decisions.md`.
- 风险：projection/cache 被误当成 truth source。
  - 缓解措施：tests must prove derived indexes can be rebuilt or explicitly modeled.
- 风险：actorSurface 被误提升为 questionnaire table 的 truth source。
  - 缓解措施：questionnaire table 归属 `VmSessionState.questionnaires`；actorSurface 只从 VM table 和 transient actor cache 构建显示投影。

## 兼容性设计

- `hydrateVM` supports old `controlSignals.events[*].payload` full payload shape.
- New `serializeVM` writes bounded shape only.
- Existing actor mailbox snapshots remain readable.
- Existing transcript/conversation recovery remains the message-history source.
- Existing runtime execution paths that temporarily keep `actor.pendingQuestionnaires` remain usable, but that field is no longer durable actor snapshot truth.
- `actorSurface.pendingQuestionnaires` / `answeredQuestionnaires` remain UI projection fields; durable questionnaire truth comes from `VmSessionState.questionnaires` and `runtime_state/questionnaires.xnl`.

## 迁移计划

1. Add failing tests for forbidden fields and bounded VM snapshot growth.
2. Add bounded signal snapshot contract and serializer helpers.
3. Update `emitFiberSignal` to separate control metadata from mailbox payload persistence.
4. Update recovery redelivery to work with actor mailbox snapshots and payload refs.
5. Add legacy full-payload normalization on save.
6. Add compaction/checkpoint for consumed signals.
7. Run focused recovery tests against synthetic legacy snapshots.

## 待解决问题

- Exact tombstone retention policy.
- Exact payload ref target for rare pending async completions that are not yet in transcript/conversation.
- Whether to provide a one-shot migration/cleanup command for existing session directories.
