# Design: bind-rewind-context-epoch

## Authority

Canonical Conversation History owns the active history head. `LocalConversationSessionActorBinding.contextEpoch` is the durable identity of the provider-visible context lineage. Responses checkpoints remain replaceable optimization assets and capture the epoch through their existing `baselineEpoch` field.

## Transition

`actor_history_head_moved`, `actor_history_generation_forked`, `actor_history_generation_rolled_back`, and `actor_history_reset` advance the affected actor epoch and remove its `responses-replay:<actorKey>` asset. A session fork invalidates all replay assets in the new session. Ordinary history append and sealing do not advance the epoch.

## Request Contract

Responses planning uses the greater of the actor continuation epoch and the persisted Session epoch. A successful complete response writes the checkpoint only for the prepared epoch and synchronizes that epoch to the Session binding. An older result is discarded when the epoch changed during the request.

## Verification

- Runtime tests prove a history-head move increments the epoch and removes the checkpoint without changing canonical History.
- Request-plan tests prove an epoch mismatch rejects stateful continuation and falls back to canonical replay.
- Existing Responses replay, checkpoint, and recovery tests remain green.
