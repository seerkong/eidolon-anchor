# Design: HolonExecutionBinding resource authority

## Ownership

The public `holarchy-eidolon-adapter` library owns the KindDefinition bytes, closed TypeScript/XNL data, effective target projection and freeze receipt. Private `@cell/ai-organ-contract` and `@cell/ai-organ-logic` expose compatibility re-exports and connect that library to the product registry, authoring and publisher seams; they do not define a second schema or capability. App ResourcePackages mechanically copy/include the canonical KindDefinition; they do not redefine it.

## Binding

A binding maps stable exact Member/Role refs to a closed execution adapter:

```ts
type HolonMemberExecutionAdapter =
  | { kind: "ai-agent"; agentDefinitionRef: string; runtimeProfileRef: string }
  | { kind: "human-endpoint"; humanEndpointRef: string; inboxProfileRef: string }
  | { kind: "service"; serviceAdapterRef: string; runtimeProfileRef: string }
  | { kind: "hybrid"; policyRef: string; candidateBindingRefs: readonly [string, ...string[]] };
```

Every ref is an exact Resource identity resolved from the admitted package/deployment closure. The hybrid policy selects only among its frozen candidate bindings; duplicate refs, cycles, an empty candidate set and unresolved policy/adapter refs fail closed. It cannot create an adapter or consult live prose. The common dispatch envelope carries TaskSpace/task/claim/invocation refs, typed input/material refs and expected result contract, so Coordinator and TaskSpace do not branch their protocol by principal type.

The binding can be evaluated only with an issuer-owned `HolonEffectiveSnapshot` Resource and `HolonEffectiveSnapshotIssuanceReceipt` whose canonical KindDefinition and codecs come from the exact published authority `holarchy-core-contract@0.1.1`; Eidolon verifies and freezes those bytes but cannot issue or rewrite them. Policy is a closed versioned union for shared/isolated runtime intent, task capability/profile and bounded tool/material authority. `MemberPrincipalKind` is descriptive evidence only and never automatically selects or validates an adapter entry.

## Resolution

The existing component-owned Halfcode registry loads the carried organization snapshot, binding, adapter dependencies, Agents and Materials. A Holon adapter validates the external snapshot KindDefinition and issuance receipt, then projection validates every adapter reference and captures effective origin/content identities. AI entries additionally produce the existing Agent run-freeze proof; other entries produce an exact adapter contract/closure proof. Freeze binds snapshot digest, issuer receipt id, binding digest and the complete adapter/resource closure. No independent scanner, cache or catalog is introduced.

## Publication

Authoring proof recognizes the new kind and validates references against the candidate package closure. Publication stages and loads an isolated candidate snapshot, verifies exact projection, then admits through the existing registry publication fence. It records a publication effect only; no MemberRuntime, instance or run is created.

## Compatibility

Existing direct Agent bindings remain valid. The first KindDefinition is 1.0.0; later compatible schema changes use 1.0.x and package releases use minimum patch versions.

The initial public adapter release is `holarchy-eidolon-adapter@0.1.0`. It has exact runtime dependencies on the issuer-owned `holarchy-core-contract@0.1.1`, `halfcode-compiler.xnl@0.2.2` and `ai-workflow-contract@0.1.7`; the private product packages are never published.
