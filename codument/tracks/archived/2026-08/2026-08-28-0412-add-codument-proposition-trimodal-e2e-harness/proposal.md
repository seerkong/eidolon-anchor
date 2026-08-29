# Change: Add a Codument proposition tri-modal E2E harness

## Context And Why

The provider-cache work has deterministic final-wire coverage and small live probes, but it does not prove that Eidolon can carry an unchanged real engineering proposition to completion through ordinary, AI Ctrl Workflow and AI Data Workflow modes. Codument's source repository already supplies realistic modeling, implementation and nested-Mission propositions with independent verifiers. A reusable harness is needed to invoke those external authorities, preserve comparable evidence and expose correctness, stability and provider cost together.

## Goals / Non-Goals

Goals:

- define content-addressed scenario manifests for external proposition request compositions and verifiers;
- run each manifest in a fresh isolated Git workspace through explicit ordinary/Ctrl/Data mode adapters;
- prove mode identity and forbid silent fallback;
- reuse canonical provider-request/cache observations and emit redacted run receipts;
- preserve workspaces/logs for recovery and run original verifiers independently;
- provide deterministic orchestration tests and explicit official-DeepSeek live entry points.

Non-goals:

- changing or copying Codument source propositions into a new acceptance authority;
- making live provider calls part of normal PR-safe tests;
- adding Workflow concepts to ordinary Agent execution;
- self-scoring generated code inside the runtime that generated it;
- treating compatible DeepSeek gateways as official evidence.

## What Changes

- Add closed scenario, mode, run-receipt and comparison contracts.
- Place own-data/effect-port contracts in `ai-organ-contract`, pure coordination/comparison in `ai-organ-logic`, and filesystem/Git/process/clock/artifact implementations in existing support packages.
- Add isolated workspace, explicitly allowlisted subprocess environment, verifier and artifact lifecycle support.
- Add ordinary, Ctrl and Data adapters sharing one proposition payload, entering through registered production surfaces and emitting distinct typed identity evidence.
- Join final provider observations and final-success usage into absolute and ratio cache/cost metrics.
- Add deterministic tests for manifest closure, mode mismatch, timeout/recovery, redaction, metric math and verifier authority.
- Add an explicit runner for sentinel/full live matrices.

## Impact

- Behaviors: `terminal-headless-runtime-cli`, `eidolon-complete-agent-ctrl-data-e2e`, `provider-deepseek`.
- Likely code: AI organ contracts/logic, terminal headless support bindings, workflow runtime observation ports, provider-cache product runner, repository scripts and focused tests.
- Compatibility: additive and opt-in; normal TUI/headless and Workflow commands retain existing behavior.
