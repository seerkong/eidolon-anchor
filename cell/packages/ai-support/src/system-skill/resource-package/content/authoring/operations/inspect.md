# Inspect authoring facts

When the exact `session_id` is known, use `WorkflowGetAuthoringSummary` for its compact identity/revision/proof summary. Use `WorkflowWorkspace` with `describe`, `tree`, `read`, `search`, or `diff` only for the specific missing detail.

Do not list every session or reread full source after a mutation merely to confirm success; the native receipt is authoritative. Do not treat a summary, diagnostic, or model explanation as proof, publication, or runtime evidence.
# Bounded inspection

Use compact registry/session facts to identify exact resource refs before reading source. Opening a ResourcePackage session with `selected_resource_refs` returns its bounded depa-projected `selection` in the open receipt without a directory scan, including the canonical workspace-owned effective KindDefinition documents for the closure. When that selection is present and not truncated, use it directly and do not call `describe`, `tree`, or `read_selection`; do not search or read those KindDefinition paths again. The standalone `read_selection` operation is a recovery fallback for an older session opened without selected refs or a caller that no longer holds the open receipt. Only when the selection is truncated or the selected source names an unregistered dependency may you perform one exact `read`/`read_many`, `search`, or necessary `tree`.

Do not serialize individually known reads across provider completions. Once the source and the exact Kind/profile reference are sufficient, the next provider completion must issue one expected-revision batch mutation. If the current source already satisfies the request exactly, skip mutation and enter validation/preparation instead. A returned structured diagnostic may justify one additional focused read-and-repair cycle.
