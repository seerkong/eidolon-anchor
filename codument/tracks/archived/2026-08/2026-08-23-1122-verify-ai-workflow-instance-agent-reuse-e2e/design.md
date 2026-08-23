# Design: instance/run/targeted-Agent acceptance

## Authority chain

```text
ResourcePackage bytes
  -> Halfcode registry + depa projections
  -> publication receipt
  -> frozen Definition instance capsule (.agent-resources included)
  -> canonical FlowRunCheckpoint profile.ai
  -> typed runAgent creates named generic actor/session
  -> runTargetedAgent({byInstanceName})
  -> snapshot save/hydrate
  -> runTargetedAgent({byInstanceId})
  -> one typed output + stable receipts
```

The Flow checkpoint owns definition/run facts, exact instance indexes and invocation receipts. Generic runtime persistence owns actor/session/conversation/provider state. The acceptance compares stable refs across the boundary; it never infers them from prose or physical directory names.

## Verification layers

1. Physical deterministic E2E uses the actual ResourcePackage fixture, Halfcode/depa loaders, publication proof, Ctrl/Data runtimes, generic provider callback, filesystem checkpoint and runtime snapshot repository.
2. Fresh reconstruction removes live resource roots and creates new service/provider owners before name/id targeting.
3. Product readback checks `~/.local/bin/eidolon` resolves to current dist and actual `.system-skills.xnl` has the exact managed identities/versions/closure digest.
4. Fresh `codument-verify`/coding Attractor reports issues first and does not repair.

## Acceptance invariants

- Ctrl and Data both return OutputSchema-valid structured results.
- One run has exactly one accepted Agent instance; all three invocation receipts name the same instanceId/sessionId.
- Generic actor count does not grow on by-name/by-id targeting.
- No canonical runtime write appears under legacy flat `agent-executions`/`ai-state` paths.
- Frozen ResourcePackage closure, checkpoint and generic snapshot are sufficient after live source deletion.
- Installed binary/global Skills match the reviewed source plan.

## Risks

- Component-only evidence could be overstated → explicitly include installed binary/global readback and label deterministic physical E2E separately from earlier real-provider acceptance.
- Provider timing could make acceptance unstable → targeted continuity uses a deterministic generic provider callback; previous real-provider structured-output acceptance remains historical evidence, not the only current gate.
