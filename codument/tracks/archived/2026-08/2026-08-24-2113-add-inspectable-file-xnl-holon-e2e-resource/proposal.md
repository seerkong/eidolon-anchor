# Track: Add an inspectable File-XNL Holon E2E resource

## Context and why

The product E2E correctly creates a real Holarchy File-XNL authority, reconstructs it and admits its issuer snapshot/receipt. Its physical root is a test-owned temporary directory removed after every case, so reviewers cannot inspect the organization layout without recreating an ad-hoc host-local run. That makes important evidence depend on chat history and temporary-directory lifetime.

## Goals

- Keep one deterministic, repository-owned inspection resource for the Review Team E2E organization.
- Generate it through the same real capsule write → fresh reconstruct → snapshot issue path.
- Expose the authority tree and separately labelled snapshot/issuance projections.
- Provide an exact regeneration check and a command that materializes the scenario into an explicit empty output root.
- Keep the product E2E's independent temporary write path intact.

## Non-goals

- No new product organization store or writable authority.
- No replacement of the product E2E with copied fixture bytes.
- No CLI/TUI product feature, package publication or dependency/version change.
- No host paths, Agent conversation/history, provider data or Mission-2 runtime behavior in the resource.

## What changes

- Add a runtime-first E2E resource materializer and a thin executable wrapper.
- Add a closed deterministic Review Team scenario shared by the real issuer helper and generator.
- Commit generated File-XNL authority bytes plus labelled snapshot/receipt/summary projections under `tests/resources/holon-task-e2e/`.
- Add byte-exact regeneration, reconstruction and boundary tests plus a short resource README.

## Impact

- Capability: `eidolon-holon-e2e-resource`.
- Code: AI organization workflow test support, package scripts and generated test resources.
- Runtime product behavior: unchanged.
