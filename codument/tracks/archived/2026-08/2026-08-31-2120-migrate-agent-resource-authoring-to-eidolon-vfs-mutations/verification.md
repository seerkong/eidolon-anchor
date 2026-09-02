# Verification

## Accepted behavior

- `EffectiveEidolonVfsMaterializer.prepare()` returns an immutable, unforgeable candidate that is invisible through `read()` until `admit()` succeeds.
- Halfcode registry projection and receipt reconciliation run against the candidate read port before VFS CAS.
- Agent authoring stages a durable journal, then commits the workspace overlay file, Effective VFS revision, registry projection and receipt in a recoverable order.
- A simulated interruption after VFS CAS recovers the pending receipt only after exact content-identity verification.
- Autonomous Worker authoring freezes its task proof from the admitted Effective VFS-backed registry.
- Physical overlays exclude `.eidolon/sessions` and atomic temp files. A manifest-bearing ResourcePackage layer replaces the prior package; manifest-free files remain sparse overlays.

## Evidence

- Symbiont + mod-ai-coding: 38 tests passed before the final package-boundary additions; focused final materializer/runtime suite: 12 passed.
- Effective Registry + authoring + autonomous host: 16 tests passed.
- TypeScript 5.9: symbiont logic, agent-resource-authoring and agent-halfcode-pipeline configurations passed.
- Terminal production entry bundled 1,247 modules into a 14.95 MB Bun artifact.
- `terminal_runtime_composer_adoption`: VFS-related failures were eliminated, including session temp-file ENOENT, Effective VFS readback divergence and standalone resource Agent composition.

## Independently owned remaining failure

The shared full terminal suite is now 15/16. Its only remaining failure is `/work-mode` with `provider_context_transition_unpersisted_predecessor_conflict`, inside the concurrently owned provider-context Mission. This Track does not modify that authority. The owner was notified through `.tmp/chat.jsonl` with the exact post-fix result.
