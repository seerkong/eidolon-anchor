# Design

## Verification topology

The Track observes one chain only:

`embedded Builtin Bn → physical home/workspace intent → candidate Effective VFS → admitted revision → Halfcode projection → frozen run closure → compiled terminal`

Upgrade tests prepare a B1 materializer with an overlay, then replay the same logical intent against B2. A compatible patch must be revalidated and admitted as a new complete revision. A stale identity or invalid Halfcode result must preserve the last admitted B2 revision and return actionable diagnostics.

## Three execution modes

- Ordinary: Terminal loads the standalone embedded Coding Agent through the Effective VFS Registry.
- Ctrl: a frozen `AICtrlWorkflow` Agent task resolves the same formal resource and keeps its prefix/resource identity.
- Data: autonomous preparation selects or authors a Worker through candidate-gated VFS authoring and freezes exact proof before execution.

All modes must use registry/resource evidence, not a copied test-only prompt.

## Build and dependency boundary

The real `build:terminal:tui` path injects the generated Builtin VFS asset and compiles the binary. Local install verifies the produced artifact. Repository-local links to unpublished XNL/Halfcode builds may be used for verification, but the report must distinguish them from a reproducible public dependency closure. No npm publication is implied.

## Recovery and concurrency

Frozen closures load their exact Effective VFS provenance. Live home/workspace changes after freeze cannot alter an existing run. Mutable `.eidolon/sessions` facts and independently managed `.eidolon/skills` / `.eidolon/commands` trees are outside the configuration overlay. The provider-context Mission owns its current transition conflict; this Track records but does not mask it.
