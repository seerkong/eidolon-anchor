# Design: Codument proposition tri-modal E2E harness

## Context

The external Codument repository owns proposition bytes and verifiers. Eidolon owns execution and runtime evidence. The harness coordinates them but is not allowed to certify its own generated output. It builds on the existing provider-cache evidence owner and final-wire receipts rather than reading provider prompts through a parallel observer.

## Solution Overview

### 1. Contract and ownership boundary

`ai-organ-contract` owns closed scenario/mode/receipt data and the minimal effect-port contracts. `ai-organ-logic` owns pure manifest validation, run coordination and result/cache-cost comparison processors. Existing support packages own Git/filesystem/process/clock/artifact and credential projection implementations. Terminal code binds these capabilities to CLI/runtime entry only; it does not become the experiment domain owner.

A versioned manifest contains only own-data: scenario id/revision, logical source root, relative request composition, file digests, verifier command/digest, workspace seed policy, timeout class and allowed modes. Loading rejects path escape, unknown fields, digest mismatch, accessor/custom-prototype values and verifier substitution. External source absolute paths remain runtime bindings and are not persisted into reusable receipts.

### 2. Pure coordinator and explicit effect runtime

A pure run coordinator receives one explicit runtime containing minimal workspace/Git, filesystem, process, clock, artifact and credential-projection ports. Support implementations create a unique temporary Git workspace, record source/executable provenance, launch exactly one mode adapter, enforce timeout/cleanup and preserve the workspace on failure. Success is decided only after the original verifier executes in the resulting workspace.

The process effect receives only an allowlisted environment projection plus an opaque provider credential handle resolved by the configured provider runtime. It never inherits the ambient process environment wholesale; undeclared variables are neither forwarded nor serialized.

### 3. Explicit mode adapters

- Ordinary invokes the generic headless Agent with no Workflow lifecycle capability.
- Ctrl creates/loads a fixed Ctrl workflow envelope whose node Agent receives the unchanged proposition as task input.
- Data creates/loads a fixed Data workflow envelope with the same Agent task input and explicit output projection.

All adapters enter through registered production surfaces. Ctrl/Data do not instantiate Workflow implementation classes or read lifecycle storage directly; identity comes from typed lifecycle facts emitted through the public runtime observation port and joined to session, Workflow instance/run and node execution. Missing or wrong-kind identity is a failure, not an ordinary fallback. No adapter introduces a parallel mailbox, messaging or lifecycle mechanism.

### 4. Receipt and provider evidence

The versioned receipt binds manifest/corpus/request/verifier digests, Eidolon and Codument executable/source facts, mode/session identity, process transitions, verifier result, artifact locations and canonical provider-cache evidence references. It summarizes final-success hit/miss/input/output tokens, exact-prefix observations, context epochs/reasons, retries and elapsed time. Raw request content and secrets are never embedded.

Cache comparison groups only same-provider/model forward-only turns within one explicit epoch. Cold/short and explicit epoch transitions remain separate. Outcome-incomplete cells never participate in cost ranking.

### 5. Deterministic and live layers

Deterministic tests use temporary fixture propositions and fake process/provider ports while retaining production manifest, mode identity, workspace, receipt and metric logic. Live scripts are explicitly enabled and use the bound external corpus plus official provider configuration. Sentinel-first execution catches harness/mode defects before full quota-consuming runs.

## Impact

- Add own-data and effect-port contracts to `ai-organ-contract`, pure processors/coordinator to `ai-organ-logic`, and concrete process/filesystem/Git/artifact bindings to existing support packages.
- Add CLI/script entry without changing ordinary command defaults.
- Add focused TypeScript configs/tests and a root script alias where consistent with existing product gates.

## Risk / Tradeoffs

- A single huge live runner is hard to recover: persist one receipt per cell and make cells independently resumable.
- Workflow authoring could alter the proposition: use fixed pre-proved envelopes and digest the exact Agent task input.
- Harness self-certification: verifier process and digest are manifest-owned, and verifier exit/output evidence is collected after runtime disposal.
- Provider incidents can mimic runtime failures: classify transient transport evidence separately and rerun; never relax correctness.
- Temp workspaces can be large: preserve failures/explicit requests and clean successful deterministic fixtures, with material live runs retained under the Mission report binding.

## Compatibility

The capability is additive and live execution remains explicit. Existing headless/TUI commands, sessions, provider configuration and Workflow resources are unchanged unless a later evidence-backed repair Track changes them.

## Decision Summary

- Reuse canonical provider-cache evidence rather than create a second prompt/request ledger.
- Use identical proposition bytes and original verifier across modes.
- Use fixed workflow envelopes for Ctrl/Data so mode selection does not become model-authored proposition mutation.
- Bind every side effect and credential projection through an explicit minimal runtime; do not forward ambient environment state.
- Require all adapters to use registered product surfaces and typed emitted facts rather than internal lifecycle reads.
- Keep official and compatible providers as different evidence classes.

## Open Questions

- None requiring user input; file placement is selected from existing module ownership during TDD implementation.

## Independent Verification Repair Addendum

Fresh verification receipt `vr-08b71aff8348dcddcde7` and the first no-token live sentinel proved that deterministic coverage did not establish production wiring. The repair loop therefore requires an external-cwd portable shim, one production effect assembly that actually calls the canonical coordinator and receipt store, typed public Ctrl/Data identity projection, and retry/final-attempt facts on the real receipt path. Requested-only or `pending_public_trace_join` evidence is invalid. The Track cannot complete until a second fresh verifier exercises those wired paths.
