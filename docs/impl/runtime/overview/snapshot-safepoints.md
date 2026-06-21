---
knowledge_system: impl
knowledge_plane: runtime
doc_role: guide
status: active
last_verified: 2026-06-05
---

# Snapshot Safepoints Overview

## Purpose

Runtime snapshots are crash boundaries. If snapshot save completes and the process exits immediately, recovery must resume from a usable state without unmatched tool calls, orphan tool outputs, lost tool starts, or duplicate tool execution.

## Mental Model

A snapshot safepoint is stronger than "no fiber is currently running". A fiber can be idle from the scheduler's immediate view while still holding mandatory continuation work that must run before the provider message protocol is recoverable.

The critical examples are `start_tool` and pending wake mailbox work. After an LLM response appends an assistant message with tool calls, the runtime must start the corresponding tool operation or reach a typed external wait before saving a recoverable snapshot. Persisting `ready + start_tool` without a matching tool result or durable tool operation proof creates a half-step state: history requires a tool result, but recovery has no durable evidence that the tool was started.

Likewise, persisting `ready + wait_llm` while the actor mailbox already contains the matching `asyncCompletion` means the LLM result has arrived but the cooperative `agent_step` has not consumed it. That state is not settled: it must advance through the executor before the snapshot can be considered a stable crash boundary.

## Main Components

- `AiAgentExecutor.ts` owns the cooperative phases such as `wait_llm`, `start_tool`, and `wait_tool`.
- `OrchestratorDriver.ts` schedules `agent_step` continuations after cooperative `yield`.
- `AiAgentRuntimeCoordinator.ts` owns save-before-progress: before saving, it checks the safepoint and performs a bounded foreground settle when mandatory continuation work is present.
- `ai-runtime-control-logic` owns the runtime-side safepoint checker and AI wake mailbox classification. Callers import it through `@cell/ai-runtime-control-logic`; the old `ai-organ-logic/src/runtime/AiRuntimeSnapshotSafepoint.ts` compatibility path is removed.
- `RuntimeSnapshots.ts` is the persistence boundary. It evaluates safepoints, writes recoverable snapshots, or returns `skipped_non_safepoint` while preserving the previous known-good snapshot.
- `ConversationDomainRuntime.ts` buffers the runtime conversation head in VM memory during a turn. `RuntimeSnapshots.ts` flushes that raw state to the conversation repository only after the same safepoint check passes.
- `LocalFileMessageHistoryEffects.ts` still writes actor transcript records immediately as append-only runtime evidence, but it no longer advances `conversation/history-generations`, `history.index.json`, or `session.index.json` from the append callback.
- `ResponsesInputItems.ts` and `OpenAIResponsesNodejsFetchAdapter.ts` normalize canonical tool call shapes so provider replay keeps assistant tool calls paired with tool outputs.

## Boundaries

Do not treat recovery wake patches as the primary fix for new runtime states. Recovery can diagnose or repair historical bad snapshots, but the save path must avoid producing new non-safepoint snapshots.

Do not prove a safepoint by storing full provider responses, tool output, or tool arguments in `runtime_state/vm.json`. Safepoint blockers returned from the checker must stay bounded and should include only fiber id, actor id/key, status, phase, mailbox kind, and reason.

Do not classify `ready + start_tool` as snapshot-safe unless the matching assistant tool call already has a tool result or the runtime has durable operation/wait proof that can deterministically continue after recovery.

Classify every wake mailbox type when evaluating a safepoint. The wake mailbox set is `control`, `toolResult`, `asyncCompletion`, `childDone`, `memberCoordination`, `humanInput`, `memberChatInbox`, and `heartbeat`.

Do not classify a fiber as snapshot-safe when a completion mailbox entry has already arrived for work the current cooperative state is waiting on. `asyncCompletion` blocks safepoint when it matches the current inflight op, such as `ready + wait_llm + asyncCompletion`. `childDone` blocks safepoint for synchronous child waits. Ordinary external inputs such as `humanInput`, `memberChatInbox`, `memberCoordination`, `heartbeat`, ordinary `toolResult`, and control messages can remain as recoverable mailbox inputs. `control.questionnaire_pending` is a human-wait marker and does not block safepoint by itself.

Mailbox blocker details can exist in the AI runtime's safepoint result for tests and callers. Do not expand the core VM schema just to record diagnostics, mailbox types, or payloads.

`saveAiAgentRuntimeSnapshot` must not call scheduler or tick APIs. Code that wants the runtime to make progress before persistence should go through the runtime coordinator so the scheduling responsibility stays outside the snapshot writer.

Keep safepoint classification outside the persistence writer. The current implementation lives in `ai-runtime-control-logic` and uses `depa-actor-control` work classification/barrier primitives through the AI runtime control layer.

Conversation persistence is part of the same crash-consistency boundary as the runtime snapshot. If the runtime has not reached a safepoint, committed conversation messages remain in the VM conversation domain runtime and are not written as the durable conversation head. This prevents recovery from combining an older runtime snapshot with a newer conversation tail.

Recovery may use actor transcript as a fallback when no conversation head exists. Once conversation files exist, they represent the latest safepoint-flushed head, not every transcript append observed during an unsafe half-step.

Pending durable `humanInput` signals are idempotent across recovery. If the input has already been committed into actor messages, recovery consumes the durable signal and removes the matching stale mailbox payload instead of replaying the same user input.

## Related Implementation Docs

- `docs/impl/runtime/overview/durable-control-signals.md`
