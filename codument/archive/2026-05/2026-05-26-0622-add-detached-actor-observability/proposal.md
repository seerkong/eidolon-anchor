# 变更：Add Detached Actor Observability

## 背景和动机 (Context And Why)
Detached background work currently returns a task id and exposes coarse status, but callers cannot reliably inspect running bash output, recent delegate messages, or final task results through focused tools. `RunDetachedBash` also relies on a synchronous bash execution path, so stdout and stderr are not available incrementally while the command is running.

## "要做"和"不做" (Goals / Non-Goals)
**目标:**
- Add scoped observability APIs for detached bash logs with stdout/stderr source filtering.
- Add scoped observability APIs for detached delegate actor recent messages and tool events.
- Add a dedicated result query for completed detached tasks.
- Add bounded retention with rolling discard metadata for large logs or message streams.
- Preserve current detached status compatibility and fiber-owned background progression.

**非目标:**
- Do not build a new TUI browsing surface in this track.
- Do not make terminal runtime responsible for background business progression.
- Do not persist unlimited detached logs.
- Do not replay interrupted in-flight bash commands after recovery.

## 变更内容（What Changes）
- Introduce detached task observability data structures for log chunks, message entries, sequence cursors, and retention metadata.
- Add a streaming execution path for `RunDetachedBash` so stdout and stderr can be appended during execution.
- Capture delegate actor message and tool-event entries from the cooperative executor/orchestrator path.
- Add focused query tools for detached logs, detached messages, and detached terminal result.
- Extend tests for running-time log/message queries, result retrieval, source filtering, range cursors, and rolling discard.
- No **BREAKING** change is intended.

## 影响范围（Impact）
- 受影响的功能规范：`aiagent-fiber-orchestration`, `aiagent-persistence-recovery`, `aiagent-reference-aligned-stage-streaming`, `ai-agent-vm-runtime-shape`
- 受影响的代码：detached actor registry, AIAgent tools, bash sandbox backend, orchestrator driver, cooperative executor, runtime snapshot/recovery types, tests
