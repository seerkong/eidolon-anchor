# Design: Eidolon Halfcode 0.3 consumer and physical Holon runtime

## DEPA authority map

| Concern | Single authority | Eidolon responsibility |
| --- | --- | --- |
| Resource envelope, spec version, exact reader resolution | `halfcode-compiler.xnl@0.3` | supply registered contracts/readers and consume authored/resolved facts |
| Holon effective snapshot semantics and canonical bytes | `holarchy-core-contract` | import registration and verify issuer-owned snapshot facts |
| Holon execution adapter closure | `holarchy-eidolon-adapter` | own `HolonExecutionBinding` Kind and canonical binding parser |
| Reusable task admission definition | `ai-organ-contract` | own `HolonTaskRuntimeDefinition` Kind and closed data contract |
| Domain projection and runtime coordination | `ai-organ-logic` | project only resolved records; coordinate explicit effect ports |
| task/claim/lease/result | canonical TaskSpace | observe and submit through ports |
| accepted member effect | pump journal | replay idempotently |
| actor/session/history | generic actor/session runtime | preserve existing owner; store references only |

## Mapping from the current chain

| Existing code | Current semantics | 0.3 mapping |
| --- | --- | --- |
| `HolonExecutionBinding.ts` KindDefinition string | descriptive 0.2 declaration | owner + JSON schema + semantic fingerprints + SpecRevision + exact reader; source rendered from registration |
| `HolonTaskRuntime.ts` KindDefinition string | descriptive 0.2 declaration | same pattern, owned by ai-organ-contract |
| `loadResourceTree*` in `EidolonAppResourceRegistryAdapter` | returns assumed `LoadedResourceTree` and directly composes/project records | returns `AuthoredResourceTree`; exact contract capsule resolves to `ResolvedResourceTree` before Holon projections |
| `composeLayeredResourceRegistry` and effective identities | layered authored authority | remain layered, but downstream execution receives resolved records/receipts and exact effective identities |
| system-skill/builtin VFS/fixtures | emit `apiVersion=halfcode.resources/v1` | emit the 0.3 resource envelope and specVersion required by the owning Kind revision |
| standalone runtime tests | synthetic admissions and file stores | add a physical ResourcePackage/registry bootstrap and recreate the host in a fresh process |

## Contract capsule

Eidolon composition builds one explicit contract capsule. It registers Halfcode bootstrap kinds, Holarchy's exported `HolonEffectiveSnapshot` registration, Eidolon's two owned Kind registrations, and the other owner packages already present in the resource package. The reader profile is exact: a resource is executable only when its descriptor fingerprints match the registered revision and a reader target exists. Missing external registrations are surfaced as structured admission failures; the host never invents fingerprints.

Domain projectors continue to read the familiar resource node shape, but receive `ResolvedResourceRecord` values whose `readerValue`, receipt, effective digest and source authored record are available. This preserves existing projections while moving the trust boundary in front of them.

## Physical package consumption

Until the candidates are explicitly published, tests install or link the previously verified tarballs in an isolated verification directory. Checked-in manifests name exact registry versions only; they do not contain workstation paths. A frozen clean install is therefore a final joint-release operation after publication, not something this Track can honestly claim beforehand.

`holarchy-eidolon-adapter` is the only public Eidolon package in this closure. Its release candidate is packed and consumed by a fresh Bun project together with the Halfcode/Holarchy tarballs. No server/web application package is published or prepared.

## Runtime proof sequence

1. Materialize a valid physical ResourcePackage containing exact KindDefinitions, Holon snapshot, execution binding and runtime definition.
2. Load authored records, resolve them through the explicit 0.3 contract capsule, and project/freeze one standalone admission.
3. Open a normal VM host with real deployment, TaskSpace and pump-journal files; no Workflow instance is created.
4. Assign Holon and exact Member tasks in final/none/stream modes and record stable TaskSpace/effect receipts.
5. Terminate the host after an effect has been accepted but before settlement, start a fresh process, rebuild registry/deployment from files, and resume without invoking the effect twice.
6. Run Ctrl/Data Workflow regression suites to prove they remain adapters over the same service.

## Release boundary

This Track produces candidate tarballs, hashes, isolated-consumer evidence and the exact dependency order. It never runs `npm publish`. If publication is later authorized, every npm registry command that can publish must include `--userconfig /Users/kongweixian/.npmrc_official` (or an equivalent explicit `NPM_CONFIG_USERCONFIG` binding); `~/.npmrc` is not an acceptable implicit source.
