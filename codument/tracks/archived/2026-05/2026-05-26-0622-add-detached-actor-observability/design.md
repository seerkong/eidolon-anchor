## 上下文
Detached work already has task ids, task status, actor/fiber bindings, and semantic completion events. The missing piece is a focused observability surface that lets callers inspect running background work without waiting for completion or relying on terminal projection output.

`RunDetachedBash` needs stream-level stdout/stderr capture. `RunDelegateActor(mode="detached")` needs message/event capture. These should remain distinct because bash logs and delegate messages have different filtering semantics and privacy boundaries.

## 方案概览
1. Add detached observability store
   - Store per-task log chunks for bash-like sources: `stdout`, `stderr`, and `system`.
   - Store per-task message entries for delegate actors: `user`, `assistant`, `tool`, and `system_event`.
   - Use per-task monotonic sequence ids.
   - Use bounded ring buffers with `maxEntries` and `maxBytes`.
   - Track `droppedEntries`, `droppedBytes`, `firstSeq`, `nextSeq`, and `truncated`.

2. Add streaming detached bash execution
   - Preserve permission checks and sandbox backend selection.
   - Add a streaming backend beside the existing synchronous bash backend.
   - Append stdout/stderr chunks as they arrive.
   - Update detached task terminal result on exit, failure, timeout, or cancellation.
   - Keep existing normal `bash` behavior synchronous unless a later track changes it.

3. Capture detached delegate messages and tool events
   - Add observability tap points in cooperative executor phases for assistant output, tool call start, tool result, and errors.
   - Associate entries with `task_id` through the child actor/fiber binding created by `RunDelegateActor`.
   - Do not expose system prompts or hidden reasoning.

4. Add query tools
   - `DetachedActorLogs`: query bash log chunks by task id, sources, range, and limits.
   - `DetachedActorMessages`: query delegate message/event entries by task id, roles, kinds, range, and limits.
   - `DetachedActorResult`: query terminal result and optionally include bounded logs or message tail.
   - Preserve `DetachedActorStatus` as a compatibility/status-only tool.

5. Preserve event and status compatibility
   - Keep existing detached completion event semantics.
   - Improve `outputText` derivation so `RunDetachedBash` terminal result can use the last relevant tool/log output instead of only the last assistant message.
   - Keep existing tests passing and add focused observability tests.

## 影响范围与修改点（Impact）
- `cell/packages/ai-core-contract/src/runtime/AiAgentVm.ts`: detached observability record types and task metadata.
- `cell/packages/ai-organ-logic/src/detached/DetachedActorRegistry.ts`: per-task observability access and terminal result updates.
- `cell/packages/ai-organ-logic/src/composer/AIAgent/tools/RunDetachedBash`: `RunDetachedBash` streaming entry behavior.
- `cell/packages/ai-organ-logic/src/composer/AIAgent/tools/DetachedActorStatus`: compatibility preservation and possible output derivation updates.
- `cell/packages/ai-organ-logic/src/composer/AIAgent/tools`: new query tools.
- `cell/packages/ai-organ-logic/src/sandbox`: streaming sandboxed bash backend.
- `cell/packages/ai-organ-logic/src/exec/AiAgentExecutor.ts`: message/tool event tap points.
- `cell/packages/ai-organ-logic/src/OrchestratorDriver.ts`: child fiber/task id association and terminal result handling.
- `cell/packages/ai-core-logic/src/runtime/snapshot`: bounded observability metadata persistence if needed for terminal results.
- Tests under `cell/packages/ai-organ-logic/tests/AIAgent` and `terminal/packages/organ/tests/AIAgent`.

## 决策摘要
- No separate `decisions.md` is required at track creation time because the user has already clarified the key product requirements: source-scoped bash logs, range control, rolling discard, delegate message range control, and result retrieval.
- If implementation discovers durable log retention or default limit choices that require product confirmation, append decisions to this track before coding that behavior.

## 风险 / 权衡
- Streaming bash may duplicate sandbox backend logic -> keep the sync and streaming backend selection shared.
- Large logs can pressure memory -> enforce count and byte limits from the first implementation.
- Delegate message capture can leak system context -> filter out system prompts and hidden reasoning by design.
- Completion result semantics can drift from existing `output_text` -> preserve status compatibility and add dedicated result tool for richer output.

## 兼容性设计
- Existing `bash` remains synchronous.
- Existing `DetachedActorStatus` and `DetachedActorList` remain status-oriented and compatible.
- New tools are additive.
- Existing semantic background result events continue to be emitted.

## 迁移计划
1. Add observability structures and tests without changing public behavior.
2. Add query tools and verify empty/running/terminal states.
3. Switch `RunDetachedBash` to streaming path while preserving task id behavior.
4. Add delegate message capture and result query behavior.
5. Update completion output derivation and regression tests.

## 待解决问题
- Final default retention values may be tuned during implementation.
- Durable persistence for large observability buffers is out of scope unless required by failing recovery tests.
