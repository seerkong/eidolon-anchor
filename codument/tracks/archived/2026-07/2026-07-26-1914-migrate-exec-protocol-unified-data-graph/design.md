# Design

Mirror the completed MessageHistoryGraph migration: own one DataGraph, register
`eventLog.stream()` as a source, reduce it through
`addStreamDrivenStateSignalNode`, observe `handle.output`, and dispose watcher,
handle, graph, then independently-owned log in order. Existing protocol tests
are the behavior oracle.
