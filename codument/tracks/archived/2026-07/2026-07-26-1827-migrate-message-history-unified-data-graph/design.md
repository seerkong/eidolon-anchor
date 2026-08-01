# Design

The graph owns the projection lifecycle. Construct one `DataGraph`, register
`inputLog.stream()` through `addSource`, then create an
`addStreamDrivenStateSignalNode` with the existing initial state and pure
`reduceHistoryProjection` reducer. Listener dispatch reads the state-node
handle's signal output through `graph.get(handle.output)` and watches that
output. `dispose()` stops the watch, disposes the state handle and graph, then
disposes the independently owned event log once.

The existing test suite is the behavioral characterization. Add only focused
coverage needed to prove the unified handle/output and lifecycle boundary.
