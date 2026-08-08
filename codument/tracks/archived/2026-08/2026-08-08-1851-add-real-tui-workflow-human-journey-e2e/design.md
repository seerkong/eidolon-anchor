# Design: Real TUI Workflow Human Journey E2E

## Harness

Use the same `createTuiRuntimeClient({ mode: "local-runtime" })` path as existing terminal questionnaire E2E tests. Configure an isolated project and home, inject a scripted LLM adapter, subscribe to TUI events, and submit three human turns through `sdk.client.session.prompt`.

## Scenario

1. The person requests a reusable workflow that reads an AI hot-topic portal and produces a trend report, while explicitly forbidding publication and execution.
2. The system authors, diffs, validates and statically dry-runs a recoverable workflow, then reports that publication confirmation is required.
3. The person confirms publication but forbids execution. The system publishes the proven revision, prepares an instance and reports that execution confirmation is required.
4. The person confirms execution. The workflow invokes an Eidolon AI actor; that actor accesses a deterministic HTTP portal through the normal network-capable tool surface and returns a report grounded in the portal payload.

## Deterministic Network Boundary

The test owns an HTTP server with stable portal content and records requests. This exercises a real socket/network boundary without binding CI correctness to changing public news, rate limits or provider availability.

## Authorities and Gates

- TUI owns only message projection and input; it does not write workflow resources directly.
- `WorkflowFulfill` owns the high-level journey.
- WorkflowComponent owns authoring and publication.
- Publication and execution confirmations are separate user turns and separate booleans.
- depa-flows owns graph execution; Eidolon owns actor, tool, session and effect lifecycle.

## Failure Interpretation

A failure in routing, session recovery, confirmation isolation, child actor completion, network effect or result projection is a production integration gap, not a test-only exception. The implementation task must repair the real shared path.
