# Design

## Target State

The workspace uses `depa-data-graph-core@1.0.1` wherever it directly depends on
the core package, and `@terminal/tui` uses `depa-data-graph-solid@1.0.1`.
`bun.lock` has a single matching core/Solid release line. The vendor boundary
test names only public APIs retained by the unified release and references
present AI-specific ownership paths.

## Approach

1. Add regression assertions that inspect all five direct manifests and the
   lockfile resolution, and revise the existing export/topology assertions.
2. Change the five manifest ranges to `^1.0.1`.
3. Regenerate only the dependency lock resolution through Bun's project-native
   install path.
4. Run the boundary test and a focused import/resolution search. Do not run a
   broad code migration in this track: compile/runtime failures caused by
   removed production APIs are owned by their successor migration tracks.

## Compatibility and Risk

This is intentionally a breaking dependency baseline. The package update can
surface production imports of removed APIs before their migrations are applied;
that exposure is desired evidence, not a reason to retain a compatibility shim.
The worktree already has unrelated changes, so verification reviews only the
declared package files, lockfile records, and boundary test.

## Completion Evidence

- All five manifests request `^1.0.1` for their direct dependency.
- `bun.lock` has `depa-data-graph-core@1.0.1` and, where applicable, Solid
  `1.0.1`, with no direct legacy resolution.
- The vendor boundary test passes and does not require removed exports.
- A diff review shows no unrelated source changes.
