# Mission Design

## Control objective

The desired state is a host workspace that consumes the 1.0.1 unified `depa-data-graph` API without deleted compatibility APIs, while retaining the observed behavior of its event-log projections and framework consumers.

The actual state is observed from package manifests and lockfile, target-library public exports/tests, host production imports, focused tests, compiler output, and later track reports. The external library is represented as a logical project ref; an implementation session supplies its workspace binding when source-level revalidation is needed.

## Evidence and ownership

- Upstream source, changelog, migration guide, and tests define the target library contract.
- Host package manifests and `bun.lock` define resolved dependency state.
- Host production code and its tests define current behavior that must be preserved.
- `analysis/upgrade-context.md` is the mission’s initial evidence snapshot. Track-level proposal/design/behavior/test artifacts become the authoritative implementation evidence as each slice starts.

## Delivery plan

1. Establish the 1.0.1 package and API baseline, including a complete compile-surface inventory.
2. Migrate Cell runtime and stream foundations: VM RxData, event/semantic logs, graph module state/ports, and timeline compatibility.
3. Migrate Cell observability graph usage: middleware, diagnostic subgraphs, plugins, trace logs and lifecycle.
4. Migrate `MessageHistoryGraph` to a stream-driven state signal within one `DataGraph`.
5. Migrate `ExecProtocolGraph` using the same upstream mechanism, preserving terminal-specific ownership and disposal semantics.
6. Verify cross-package imports, framework adapter consumers, targeted behavior tests, and relevant executable entry points.

Each numbered implementation slice is a real host track. The mission only controls their order, evidence, and re-planning; it does not make direct production changes.

## Replanning and intervention

Replan when one of these observations invalidates the current slices: the target package cannot be installed reproducibly, an existing supported API changes behavior outside the projection migrations, a state-node output semantic makes a public consumer incompatible, or focused behavior tests reveal a lifecycle difference. Record the evidence in `reports/`, then add or supersede a track rather than silently broadening an in-progress slice.

Human intervention is required before accepting a local compatibility shim, changing an externally visible event/snapshot contract, or substituting a target version other than the user-specified commit’s release line.

## Risks

- Package major-version constraints can expose API breaks beyond the two removed projection imports.
- State-node eager activation and signal equality semantics can alter listener timing if a migration chooses the wrong node variant.
- TUI Solid adapter usage must be verified against the published 1.0.1 adapter, not inferred from the core-only migration.
- The workspace is already dirty; tracks must baseline failures and avoid reverting unrelated work.
