# Design

## Authority selection

`WorkflowComponent` will select exactly one resource-authority mode at construction:

- **Effective VFS mode** — `effectiveVfs` is present. Registry projection receives that source; `resourceLayers` becomes empty; the resource publication session receives no physical layers; `resourcePackagePublisher` is absent; explicit injection of a physical publisher is rejected.
- **Legacy physical mode** — `effectiveVfs` is absent. The existing ordered physical layers may feed registry/session/publisher behavior unchanged.

The `.eidolon/workflows` store is a Workflow definition authoring/session authority, not a ResourcePackage overlay source, and remains active in both modes.

## Runtime binding

Terminal metadata may temporarily retain physical layer coordinates for compatibility consumers, but `createWorkflowComponentForRuntimeBinding` must resolve `effectiveVfs` first and must not project metadata layers into the constructed component when Effective VFS exists. The resulting public component shape is the executable authority test: no physical `resourceLayers` and no `resourcePackagePublisher`.

## Failure policy

Silently accepting an explicitly supplied `WorkflowResourcePackagePublisher` beside Effective VFS would reintroduce dual authority. Construction therefore fails closed for that impossible combination. Merely retaining metadata coordinates is not authority; exposing a loader/session/publisher that can read or mutate them is.

## Compatibility and migration

Physical-only tests continue proving the legacy path. Effective-VFS production tests prove isolation. The BehaviorPatch replaces the historical “shared global/workspace ResourcePackage layers” wording with one admitted Effective VFS read port and makes the legacy physical path conditional on Effective VFS being absent.

## Verification

- RED/GREEN production-shape test.
- Effective-VFS registry and authoring suites.
- Physical-only Workflow publication/e2e suites.
- Terminal metadata/component composition regression.
- TypeScript 5.9 checks, strict Track validation, and build/install identity where proportionate.
