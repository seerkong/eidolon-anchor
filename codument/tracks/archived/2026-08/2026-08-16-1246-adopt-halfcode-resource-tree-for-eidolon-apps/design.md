# Design: Halfcode-backed Eidolon App registry

## Authority pipeline

```text
global ResourcePackage root     workspace ResourcePackage root
            |                                |
            +---- Halfcode loadResourceTree -+
                             |
             composeLayeredResourceRegistry
                    global -> workspace
                             |
          EidolonResourceRegistrySnapshot (derived, immutable)
                     /                 \
     depa App projection        exact ResourceRecord lookup
            |                            |
 WorkflowComponent queries      WorkflowDefinitionRepository
            |                            |
 native tools / CLI / TUI       frozen definition revision
```

XNL ResourcePackage files remain the authoring authority. `EffectiveResourceRegistry`, App projections and host receipts are rebuildable projections and MUST NOT be serialized as a second catalog.

## Root policy

Eidolon owns only root binding and layer order:

| Concern | Default root | Meaning |
|---|---|---|
| global resources | `~/.eidolon/resources` | one optional Halfcode ResourcePackage, lower precedence |
| workspace resources | `<workDir>/.eidolon/resources` | one optional Halfcode ResourcePackage, higher precedence |
| workflow authoring | `<workDir>/.eidolon/workflows` | existing mutable authoring/session workspace; not a ResourcePackage by implication |

Runtime metadata receives explicit `resourcePackages.layers` descriptors. The existing `aiWorkflow.roots` object remains the workflow authoring/material runtime boundary. A configured root is never searched for child packages: its own `manifest.xnl` either validates through Halfcode or the load fails. A physically missing root contributes no layer.

The fixed layer ids are `global` and `workspace`, in that order. This deterministic policy is not inferred from paths or package content. Tombstones are not synthesized from absence.

## Host component

`EidolonResourceRegistry` is an Eidolon adapter over public Halfcode APIs. It owns:

- validated absolute root descriptors;
- loading optional roots through `loadResourceTree`;
- exact ordered layer composition;
- effective content identity projection;
- immutable lookup metadata mapping an effective record to its selected layer root;
- depa-flows App projection.
- depa-flows Agent/Material projection for bounded reusable-Agent discovery.

It does not own generic parsing, scanning, Kind validation, containment, shadow rules or digest algorithms. The shared `WorkflowComponent` owns one instance of the adapter, so all native tools in a VM use the same component boundary. Query operations share one stable snapshot until the host explicitly invokes `refresh()` at a lifecycle boundary; there is no path/name cache invalidation heuristic.

An empty root set is represented by Halfcode's authentic empty composition and projects zero Apps/Types. An existing invalid root propagates structured Halfcode diagnostics; Eidolon does not fall back to legacy discovery.

## Exact workflow resolution

`WorkflowDefinitionRepository` splits resolution by explicit scheme:

- `resource://<id>`: exact lookup in the effective Halfcode registry. The selected record must be `AICtrlWorkflow` or `AIDataWorkflow` and use a single-file authority. The adapter resolves its canonical `logicalPath` against the already-bound selected layer root, reads only that registered authority document, verifies the Halfcode authority digest, and validates it through the existing depa-flows profile loader.
- `vfs://./...`: compatibility-only explicit authoring workspace resolution. It may read the stated manifest path but MUST NOT enumerate manifests to discover identities.

`listResourceRefs()` enumerates only effective registry records of the two workflow kinds. An unregistered `manifest.xnl` under either root or authoring workspace is invisible.

For resource-backed capture, `WorkflowDefinitionRevision` gains a compatible optional receipt containing resource id, kind, package id, layer id, composition revision and Halfcode content digest. The existing frozen source files and Eidolon source revision remain execution/recovery input. Later registry changes cannot rewrite a saved revision.

## App surface

The component exposes bounded App list/detail projections containing identity, description, ordered workflow bindings and entrypoints. It does not expose the entire ResourceTree or source bodies through normal tools.

- `WorkflowListApps` returns stable App briefs.
- `WorkflowGetApp` resolves one exact App resource id and returns its bounded projection.
- `WorkflowListTypes` and `WorkflowGetType` use the same registry-backed definition repository.
- `eidolon workflow apps` invokes `WorkflowListApps` through the same native-tool runner used by other CLI lifecycle commands.
- TUI conversations reach the identical tools from the shared built-in tool registry.
- Existing reusable-Agent queries project bounded Agent briefs from the identical registry snapshot; they do not execute or bridge Agents in this track.

`WorkflowQueryService` receives the component-owned definition repository and registry snapshot. Definition and material diagnostics consume only normalized records plus depa typed projections/edges. Serializing an arbitrary definition and searching it with regex, keywords or substrings is forbidden; a relation absent from the typed projection remains absent.

No surface parses prompt text or resource names to select an App.

## Compatibility

- Existing authoring sessions and `vfs://` reads remain supported.
- Existing hardcoded template/prebuilt starting facts are not App discovery and remain temporarily compatible. Reusable Agent discovery is registry-backed here; Agent execution moves to the next actor bridge track.
- Existing frozen workflow definitions without a resource receipt remain readable.
- Existing runtime facts do not gain a new resource/session store.
- The internal `@cell/ai-workflow-contract` keeps its additive exports while consuming the exact depa 0.1.2 patch.

## Failure model

- non-absolute injected root: stable Eidolon root diagnostic;
- missing root: omitted layer;
- existing invalid ResourcePackage: structured Halfcode validation failure;
- layer conflict or invalid shadow facts: structured Halfcode composition failure;
- unknown resource id or wrong kind: stable definition/App not-found or kind-mismatch error;
- origin outside selected layer root: fail closed before any source read;
- source bytes whose Halfcode SHA-256 no longer match the selected content identity: fail closed and require refresh; stale bytes MUST NOT be frozen under the old receipt;
- stale/mutated live package after capture: does not alter the frozen definition revision.

## Verification strategy

Use real global/workspace ResourcePackage fixtures with exact KindDefinitions. Cover workspace precedence, unregistered files, similar ids, ordinary multilingual text, malformed packages, root containment, App ordering, CLI/native sharing, registry change after frozen capture and explicit legacy VFS resolution. Static checks forbid new filesystem package discovery, hand-rolled Catalog parsing, generic overlay code and natural-language semantic routing.
