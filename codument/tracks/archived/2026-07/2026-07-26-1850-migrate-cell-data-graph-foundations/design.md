# Design

`addConsumer` remains the sequencing mechanism, but its callback no longer
receives a `ctx.get` capability. Each callback will read its declared state ref
through the owning `DataGraph` instance (or an equivalent supported unified
API), preserving the existing batching and append-delta logic. Existing live
and replay fixtures are the characterization oracle; no parser rules change.
