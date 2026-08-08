# Proposal: Verify Eidolon Workflow Cross-Surface Acceptance

## Why

The native workflow component and tools are available to an Eidolon conversation, but the human-facing CLI does not expose the runtime operations and therefore cannot prove acceptance for run recovery. TUI routing guidance also only covers create/edit.

## What Changes

- Expose a standardized native-tool invocation port from the terminal runtime bridge.
- Add an organ-support adapter that opens a stable workspace-scoped Eidolon session and invokes a native tool without an LLM mediation turn.
- Add `eidolon workflow run/status/events/result/resume/graph-patch` as thin projections of the existing workflow tools.
- Extend shared AI kernel guidance so ordinary-language run, inspection, resume, and correction requests route to the same tools.
- Verify CLI/TUI/headless root binding, persistence, recovery, and absence of CLI-private workflow logic.

## Non-Goals

- No MCP surface for Eidolon integration.
- No external agent CLI.
- No alternate parser, workflow runtime, fact store, or host-file authoring path.
- No replacement of Eidolon actor/session/runtime-control authorities.
