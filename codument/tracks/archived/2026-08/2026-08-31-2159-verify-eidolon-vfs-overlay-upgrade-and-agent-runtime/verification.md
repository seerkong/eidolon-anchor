# Verification report

## Verdict

The Effective Eidolon VFS overlay, Halfcode projection, frozen Agent resource closure, and compiled BunFS product satisfy this Track's acceptance boundary. The VFS-owned regression matrix is green and the locally installed executable is byte-identical to the built artifact.

One additional live ordinary-mode experiment reached a complete implementation and its local test suite, but the outer proposition receipt failed while entering the independently delegated Codument verifier. The failure is the concurrently owned provider-context transition conflict, not an Effective VFS/resource-resolution failure. It is recorded below and is not hidden or converted into a passing live receipt.

## Acceptance matrix

| Concern | Evidence | Result |
| --- | --- | --- |
| B1 overlay replay on B2 | `effective_eidolon_vfs_materializer.test.ts` replays a compatible B1 mutation on B2 and rejects a stale identity without replacing admitted B2 | PASS |
| Frozen B1 recovery after live B2 | `effective_vfs_resource_registry.test.ts` recovers the exact captured VFS revision and dependency closure | PASS |
| Ordinary/Ctrl/Data formal Agent surface | Builtin resource, proposition support, proposition harness/matrix, and autonomous Agent host suites | PASS, 45 tests in the mode/product slice |
| Complete VFS/resource regression | Seven focused suites covering overlay, registry, embedded resources, proposition modes, and autonomous authoring | PASS, 61 tests / 267 assertions |
| Type integrity | TypeScript 5.9.3 against `cell/tsconfig.agent-resource-authoring.json` and `cell/tsconfig.agent-halfcode-pipeline.json` | PASS |
| Compiled product | `bun run build:terminal:tui` with generated BunFS injection | PASS |
| Local install | `bun run install:dist:terminal`; installed `eidolon --version` reports `0.2.0` | PASS |
| Artifact identity | SHA-256 of the final independently rebuilt and installed executable after the gap-loop runtime-state boundary repair | both `a2901adb83e51cd2e56cfbd543a776da4170d6283fccbaa7574acaae1543dcce` |

The focused final regression command passed 61 tests across:

- `cell/packages/symbiont-logic/tests/effective_eidolon_vfs_materializer.test.ts`
- `cell/packages/ai-organ-logic/tests/workflow/effective_vfs_resource_registry.test.ts`
- `cell/packages/mod-ai-coding/tests/builtin_eidolon_resources.test.ts`
- `terminal/packages/organ-support/tests/codument-proposition-support.test.ts`
- `cell/packages/ai-organ-logic/tests/e2e/codument_proposition_harness.test.ts`
- `cell/packages/ai-organ-logic/tests/e2e/codument_proposition_matrix_runner.test.ts`
- `cell/packages/ai-organ-logic/tests/workflow/autonomous_agent_resource_host.test.ts`

## Real provider observation

An extra ordinary-mode live cell used the installed executable, the `stream-pipeline-ai-agent` Codument proposition, and `deepseek-iqingwa/deepseek-v4-pro`:

- wall time: 23 minutes 31 seconds;
- provider calls: 86;
- provider failures/retries: 0 / 0;
- prompt/cache-hit tokens: 9,464,151 / 9,195,776;
- overall cache-hit ratio: 97.1643%;
- cache-eligible stable-prefix hit ratio: 99.9977%;
- retained-prefix integrity: 1;
- generated project verification before independent delegation: 36 pytest tests passed plus the offline end-to-end demo.

The process then invoked `RunDelegateActor` for fresh Codument verification and hit `provider_context_transition_head_session_divergence_conflict`, followed by a closed request ledger. Consequently the proposition receipt correctly remains `failed`; its verifier reports `no Codument Track reached completed status` because the provider transition aborted the Agent before the final Track transition.

Evidence is preserved under:

`/Users/kongweixian/ai/eidolon/eidolon-anchor/.tmp/effective-vfs-trimodal-live/stream-pipeline-ai-agent/ordinary/effective-vfs-20260831-r2/`

The exact receipt is:

`receipts/ordinary-885257b163f79f53c13f6da92a663b4a2cc3f945076d36bda748fa1cac5e877c.json`

The current source integration regression independently reproduces the same ownership boundary: `provider_context_epoch_transition.test.ts` passes 14 tests, while `terminal_runtime_composer_adoption.test.ts` has only the `/work-mode` provider transition case failing (`29 pass, 1 fail, 1 unhandled assertion consequence`). The provider-context Mission owns that repair. This Track does not weaken transition semantics, bypass independent verification, or mutate provider files.

## Boundary notes

- `.eidolon/projects`, `.eidolon/sessions`, `.eidolon/skills`, `.eidolon/commands`, atomic temporary files, and symlinks are not scanned as configuration overlay content. Gap-loop round 1 exposed `projects` as a runtime-state tree after a real home directory contained 1,143 files (about 55 MB); the coordinated repair is guarded by a test that would fail if traversal entered a symlink below `projects`.
- Manifest-bearing physical resource packages replace the package as a unit; manifest-free physical files remain sparse overlays.
- Exact resource persistence uses exact XNL bytes, while admitted Effective VFS identity remains a canonical, directory-order-independent tree digest.
- Local links to unpublished XNL/Halfcode builds were used for product verification. No npm publication was performed or implied.
