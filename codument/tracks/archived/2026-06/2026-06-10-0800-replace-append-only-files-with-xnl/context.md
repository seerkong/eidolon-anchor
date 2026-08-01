# Context

## Knowledge Sync

- Checked project attractors: `codument/attractors/project.md` and `codument/attractors/product.md`.
- Decision: do not write long-lived `codument/specs` or external knowledge docs during implementation.
- Reason: this track already carries active design, decisions, and spec deltas; durable registry/doc promotion should happen during archive or explicit docs-sync so the active track remains the change source of truth until final validation.

## Reopened After Archive

- The track was restored from `codument/archive/2026-06/2026-06-07-1930-replace-append-only-files-with-xnl/` back to `codument/tracks/replace-append-only-files-with-xnl/`.
- Archive-time spec registry changes were reverted so the active track remains the source of truth until the new P5 rework is complete.
- Reopen reason: current `effects.xnl` output wraps the only `Request`/`Wait`/`Result` subject in a generic `payload` field, and current `ingress.xnl` output uses `IngressEvent` -> `Data` -> `payload` nesting. The desired format removes meaningless payload wrapping and makes ingress records directly readable, with text streams stored as typed XNL text nodes.

## P5 Design Decisions

- `logs/ingress.xnl` is a raw ingress event stream. It MUST preserve provider/token delta records exactly as events arrive: no aggregation, no coalescing, no chunking, and no extra text processing for readability.
- Ingress readability comes from typed top-level XNL nodes, not from transforming the event stream. Think/content deltas use text nodes such as `ThinkDelta` and `ContentDelta` whose body is the original delta text. Data/control/tool events use typed top-level data nodes without `IngressEvent` -> `Data` -> `payload` wrappers.
- `runtime-control/effects.xnl` records runtime effect lifecycle evidence. New writes MUST unwrap meaningless `{ payload = ... }` fields when `Request`/`Wait`/`Result`/`Error` already represents the single event subject.
- Long tool output in `effects.xnl` SHOULD use `outputTextRef` to point at an artifact-backed text body. This keeps the lifecycle record scannable while preserving the full output out of line.

## P5 Implementation Notes

- `runtime-control/effects.xnl` new writes now expand object payload fields directly onto `Request`/`Wait`/`Result` children. Legacy records with `{ payload = ... }` remain readable and are normalized back to the runtime lifecycle event payload.
- `logs/ingress.xnl` new writes no longer use `IngressEvent` -> `Data` -> `payload`. `think` and `content` timeline events are appended as top-level `ThinkDelta` / `ContentDelta` text records whose text is exactly the incoming `StreamEvent.data`. Tool/control/other events are appended as typed top-level data records with the raw `data` string.
- The shared append/read helper now supports top-level XNL text records so ingress text deltas can use XNL text-node semantics without an artificial data wrapper.
- Focused tests passed for file-store effect/replay behavior, session runtime XNL logs, and conversation repository regression.
- Historical session `history-generations/*.json` migration now writes compact `HistoryMessage` records with message-level metadata and block children only. It no longer stores the old generation object, full message object, or `sourceRecords.payload` in `HistoryMessage` attributes, because that duplicated the same text already stored in `Content` / `Think` text blocks.
- `HistoryMessage` records and `ActorCommittedMessageRef` no longer carry `transcriptPath`. New design does not generate actor `transcript.txt`, so transcript paths are not part of conversation history truth. Legacy transcript file paths remain only inside old actor transcript read/backup compatibility code.

## Gap-Loop Round 3 Fixes

- Gap: `LocalFileConversationPersistenceRepository.writeHistoryGeneration` still persisted transcript-shaped `sourceRecords` (`{ stream, payload }` arrays whose payload duplicates block text) into `HistoryMessage` attributes. The file-store migration path was clean, but the runtime/TUI bootstrap path that converts transcript-only legacy sessions into `history.xnl` (`bootstrapConversationHistoryFromMessages` -> `chatMessagesToCommittedHistoryRefs`) and the compaction path both flowed `sourceRecords` into persisted attributes, violating AC-T5.3-history-migration-compact.
- Fix: `writeHistoryGeneration` no longer persists `sourceRecords` for any write; block children remain the only text carrier. Readers keep accepting `sourceRecords` attributes from legacy records (tool-call-id recovery, user-input history). TUI `hydrateUserInputHistoryFromPersistence` now derives `user_input` records from the committed message via `committedHistoryRefsToTranscriptRecords` when persisted `sourceRecords` are absent, so user input history survives without the redundant blob. The stray `transcriptPath` argument passed to `bootstrapConversationHistoryFromMessages` in `TuiRuntimeClient` was removed (the function never accepted it).
- Stale test repaired: `terminal/packages/tui/tests/local-runtime-facade-config.test.ts` "bootstraps transcript-only legacy sessions" used `LocalFileActorTranscriptStore.writeMessages`, which is intentionally inert after T2.2 (new sessions never write transcripts), so the fixture produced an empty session and the test failed even before this round. The fixture now writes legacy `transcript.txt` directly as migration input and the test passes.
- In-memory `sourceRecords` on `ActorCommittedMessageRef` are intentionally kept: they back tool-call-id normalization and transcript-record reduction inside a process; only the persistence boundary strips them.
