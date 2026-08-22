# Track: bind-rewind-context-epoch

## Goal

Bind replaceable Responses continuation and replay state to the canonical conversation head. A history head move, fork, rollback, or reset must advance an explicit Session-owned context epoch and remove the affected provider checkpoint before the next request.

## Scope

- Persist `contextEpoch` on the Session actor binding.
- Invalidate the actor's Responses replay checkpoint on history mutations.
- Make Responses request planning use the Session epoch and synchronize successful checkpoint commits back to it.
- Preserve the existing non-authoritative checkpoint and safepoint-only snapshot contracts.
