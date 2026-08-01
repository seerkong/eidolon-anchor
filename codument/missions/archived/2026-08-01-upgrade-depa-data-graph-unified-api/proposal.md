# Mission: Upgrade depa-data-graph to the unified API

## Background

The workspace is locked to `depa-data-graph-core` and `depa-data-graph-solid` 0.1.1. The requested upstream commit is the breaking unified DataGraph release, published as 1.0.1. It removes the split stream/bridge/reducer-projection surface that the workspace still uses in two production projections.

## Goals

- Upgrade all direct workspace dependency declarations and the lockfile to the upstream 1.0.1 release line.
- Migrate or explicitly revalidate every Cell graph-facing foundation, including VM RxData, event/semantic streams, stage modules, timeline compatibility and observability graphs.
- Replace removed `ReducerProjection/createReducerProjection` usage with the upstream unified DataGraph state-node model.
- Preserve message-history and terminal execution-protocol projection behavior through focused regression tests.
- Audit all remaining core and Solid adapter consumers against the new surface, then verify the integrated CLI/TUI paths relevant to those consumers.

## Non-goals

- This mission does not fork or modify `depa-data-graph` itself.
- It does not retain local shims for APIs intentionally removed upstream unless a later track establishes a concrete upstream migration gap.
- It does not redesign unrelated application state graphs merely because they compile against the new API.

## Why a mission

This is a breaking dependency upgrade spanning five package manifests, the package lock, two independently owned reducer projections, framework adapter consumers, and integration verification. Evidence gathering, package baseline work, two migrations, and validation must be separately observable and re-plannable. The mission is the control plane; each code/spec/test change belongs in its own track.

## Success criteria

- Every direct dependency resolves to the intended 1.0.1 line without duplicate legacy graph packages.
- No production import relies on an API removed by the target release, and all retained Cell graph APIs have migration or compatibility evidence for their target semantics.
- Message history and terminal execution snapshots preserve their current observable behavior, including replay/current-state, listener, completion, and disposal semantics.
- Core and Solid adapter consumers compile and targeted runtime/TUI tests pass, with any unrelated worktree baseline failures documented rather than hidden.
