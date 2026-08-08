# Proposal: Real TUI Workflow Human Journey E2E

## Why

The existing workflow evidence proves component behavior, native registration, TUI workspace binding and compiled surfaces, but it does not prove that a person can complete the full journey through ordinary TUI conversation.

## Goal

Add an executable TUI local-runtime E2E scenario in which a person asks Eidolon to collect current AI application trends from a network portal and generate a report, then independently confirms publication and execution in later conversational turns.

## In Scope

- Submit all human messages through `TuiRuntimeClient` local-runtime mode.
- Route the ordinary request through `WorkflowFulfill` and existing native workflow tools.
- Use a real deterministic HTTP portal served inside the test process.
- Assert authoring proof, no publication before confirmation, no execution before confirmation, network access during execution, durable facts and a human-facing report.
- Repair production wiring exposed by the E2E test.

## Out of Scope

- Depending on mutable public news content in normal CI.
- Adding an MCP workflow surface.
- Replacing depa-flows or Eidolon actor/session/effect authorities.
- Requiring humans to provide workflow forms, nodes, ports, XNL or paths.

## Success Criteria

- The TUI E2E test fails against any bypass of `WorkflowFulfill`, publication confirmation or execution confirmation.
- The portal receives no request before execution confirmation and exactly one or more requests after it.
- The generated business report contains portal evidence and the completed journey remains recoverable from the workspace/session facts.
