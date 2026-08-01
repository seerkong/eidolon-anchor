# Design

## Chosen Approach

`DataGraph.addComputed` in 1.0.1 supplies a graph runtime to the getter.
Each migrated getter will read declared signal dependencies through
`runtime.graph.get(nodeId)`. The declared dependency lists remain unchanged,
so invalidation and lazy evaluation ownership stay in DataGraph.

## Scope Boundary

This track owns Cell and terminal organ observability diagnostic summaries plus
terminal observability tests that directly exercise the obsolete callback
contract. Terminal TUI projection callbacks are deliberately excluded: the
mission reserves them for G7 cross-package integration because they share the
TUI runtime and adapter verification boundary.

## Verification Strategy

1. Add a source-boundary test covering both production DiagnosticSubgraph
   implementations and the terminal test fixtures.
2. Run the full focused Cell and terminal organ observability suites.
3. Inspect that dependency arrays are retained and no `ctx.get` remains in
   the track-owned source/test files.

## Risks And Mitigations

- A mechanical replacement could change generic inference: preserve existing
  generic types on each `graph.get` call.
- Tests can mask production failures if only fixtures change: boundary test
  names the two production sources and focused suite executes summary updates.
- TUI has the same legacy pattern: retain it for G7 and record that boundary
  explicitly rather than silently widening this track.
