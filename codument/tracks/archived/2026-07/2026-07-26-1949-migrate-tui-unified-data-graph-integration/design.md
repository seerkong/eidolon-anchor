# Design

TuiA1StateGraph continues to own a single observable DataGraph and keeps each
existing dependency array. Only getter reads change from `ctx.get` to
`runtime.graph.get`, preserving graph-owned invalidation and projection
semantics. A source boundary plus existing TUI graph tests prove the migration.
