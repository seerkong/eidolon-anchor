# Design: typed Agent invocation facade

## 1. Authority map

| Fact | Authority | Eidolon responsibility |
|---|---|---|
| Agent task and dependency closure | immutable complete ResourcePackage/closure bytes inside the frozen workflow instance; fresh Halfcode/depa freeze projection | Rebuild and authenticate the exact task binding before dispatch |
| Agent invocation, selector and run-local indexes | depa `AIWorkflowProfileDurableState` in the canonical `FlowRunCheckpoint` | Bind the checkpoint store and provide CAS transitions |
| Actor/session/provider lifecycle | Eidolon generic runtime-control and actor stores | Dispatch or recover the one generic resource Agent child |
| Authored API shape | published depa Processor contracts | Bind runtime into same-named methods; do not redefine the call formula |
| Publication admission | Eidolon authoring TypeScript/AST proof over frozen package bytes | Accept typed methods and reject public Agent `invoke` |
| Human guidance | generated Flow DSL reference and later system Skill track | This track updates code/reference proof only; later track updates Skill prose |

## 2. Processor and bound facade

The canonical dependency remains:

```ts
runAgent(agentRuntime, input, config)
runTargetedAgent(agentRuntime, selector, invocation, config)
```

The authored runtime is a closure-bound projection with the same names:

```ts
runtime.ai.effects.runAgent(input, config)
runtime.ai.effects.runTargetedAgent(selector, invocation, config)
```

The binding layer constructs an authentic `AIAgentRuntime` for the current workflow run and node. It delegates state transitions and selector resolution to depa, while its host callback maps one normalized invocation to the existing `EidolonWorkflowEffectProvider`/generic resource Agent execution plan. `EidolonWorkflowEffectProvider.invoke` may remain an internal method; it is not present in the authored Agent API.

## 3. Closed selector and result

The only selectors are:

```ts
type AIAgentSelector =
  | { readonly byInstanceId: string }
  | { readonly byInstanceName: string }
```

They are plain, dense, exact data objects. Missing, empty, both-key, accessor, inherited, extra-field, unresolved, duplicate-name and id/name-conflict inputs fail before dispatch. Resolution uses only the same run's canonical `profile.ai`; it never scans actor sessions or interprets labels/text. A successful call returns the typed output plus the stable Agent instance reference required for later `byInstanceId` use. An authored `instanceName` is unique within that run.

## 4. Frozen ResourcePackage closure, task proof and per-node runtime

The current resource capture freezes only workflow manifest/code bytes; it does not yet carry the Agent, Material, Prompt, Tool, Port, Binding and KindDefinition closure. This track therefore extends instance admission before version 0: from the admitted resource snapshot and run-freeze receipt it materializes the complete selected package/closure bytes into the immutable instance definition capsule, with exact source origin, dependency snapshot and content identities. No mutable registry path is stored as authority.

On every process construction that needs an Agent task, Eidolon loads those frozen bytes through Halfcode, rebuilds the depa App/Workflow/Agent/Material projections, calls the real run-freeze/projector path, and obtains a new in-process authentic `FrozenAIAgentTaskBinding`. It never deserializes a structural lookalike from the checkpoint. Live global/workspace package modification, deletion or registry refresh cannot affect an existing instance; missing, drifting or incomplete frozen closure bytes fail before dispatch.

The facade binder consumes that authentic proof and the canonical checkpoint. It verifies workflow kind/ref, node id, Agent definition ref, semantic fingerprint, dependency snapshot revision and closure refs before provider dispatch. Structural copies are rejected.

The facade receives node-scoped config and exact invocation facts from the substrate binder; no code path should infer Agent semantics from node labels, function names, descriptions or topology. `profile.ai` persists stable instance/name/session references and receipts only. Conversation history, provider transcript, compaction and actor state remain outside the flow checkpoint.

## 5. Generic addressed Agent continuity and exact-once recovery

Current `spawnChildExecutionActor` creates a random child and removes it after immediate completion, which is sufficient for one-shot effects but not for `runTargetedAgent`. This track adds a generic runtime-owned addressed Agent seam, not a workflow store:

- create: allocate a durable generic actor/session identity from the normalized Agent definition and initial invocation;
- invoke: send a later invocation to that exact actor/session identity;
- resume: reconstruct/hydrate the same generic owner from its opaque reference after process restart;
- close: remain governed by generic runtime lifecycle policy, not Flow node code.

`profile.ai` indexes only the returned opaque actor/session/instance reference by run-local id and authored name. A targeted call with a different invocation key must reach that same generic actor/session; it cannot spawn a fresh child and merely reuse a logical identifier. The host validates that the opaque reference resolves to the same Agent definition and owner before delivery.

The depa Processor owns pending/completed receipt transitions under checkpoint CAS. The Eidolon host callback uses the existing generic runtime-control request/pending/result evidence to converge one effect lifecycle. Required cases:

1. same-process concurrent calls with the same semantic invocation share one pending result;
2. a reconstructed provider/runtime while the first child is still pending waits for the same durable terminal result;
3. completed repetition returns the same instance/output without another child;
4. completion CAS conflict reloads and accepts only a matching completed fact;
5. any changed task, selector, material refs, policy, invocation metadata, input or config fails before dispatch.
6. different invocation keys targeting the same by-name/by-id binding reuse one actor/session in the generic store, including after reconstruction.

An instance-local map may optimize waiting but cannot be correctness authority. No new workflow-specific actor, session, history or compactor store is permitted.

## 6. Authored TypeScript and publication proof

The bootstrap runtime declaration must type both methods independently, preserving generic input/output inference and the exact selector union. Generated Ctrl/Data examples and physical fixtures use the named methods. The authoring proof parses the runtime-first exported Processor signature and the bound method call shape. It rejects:

- `runtime.ai.effects.invoke` used for Agent execution;
- computed/aliased access that bypasses the named capability;
- a missing/misplaced runtime parameter in exported flow Processors;
- selector/config facts that cannot be tied to the frozen node/task contract.

Generic `invoke` may remain available internally for non-authored dispatch plumbing and existing non-Agent compatibility paths. The admission rule is semantic and AST/type-based, not a repository-wide string ban.

## 7. Ctrl and Data integration

Ctrl `Run` and Data ordinary nodes receive the same bound facade from their existing runtime derivation seams. Both forms record pending/completed Agent profile transitions and opaque addressed-owner refs in the single canonical checkpoint. Tests use physical complete ResourcePackages and cover direct `runAgent`, name-based reuse and id-based reuse across fresh service reconstruction, after the live ResourcePackage has been modified or removed.

## 8. Build and verification

The canonical unified build continues to run the system Skill plan check first. Verification includes focused runtime/proof tests, full workflow tests, frozen install, exact dependency checks, TypeScript compilation for authored examples, strict Codument validation, compiled isolated `global init`, XNL/XML and diff/static checks. Commands never specify a registry and never edit npmrc.
