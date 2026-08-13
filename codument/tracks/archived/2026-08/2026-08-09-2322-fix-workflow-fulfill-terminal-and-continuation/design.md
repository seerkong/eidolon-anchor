# Design

## DEPA authority map

| Fact | Role | Authority | Projection |
|---|---|---|---|
| provider completion result/failure | current terminal effect | runtime effect lifecycle | actor terminal message |
| child conversation history | message/history authority | Conversation Domain | successful child output |
| child terminal status/error | cross-actor terminal message | `childDone` mailbox payload | parent tool result |
| WorkflowFulfill/CLI result | derived observation | child terminal message + parent actor outcome | human business response |
| prior business conversation | historical input | parent Conversation Domain | bounded child prompt context |

## Terminal rule

The current provider attempt determines the actor transition. A failed provider attempt cannot be converted to complete because a previous assistant message exists. Successful output is materialized from Conversation Domain only after a complete terminal transition.

The initial `WAIT_FOR_CHILD_DONE` tool execution is control flow, not a result. For sync-wait delegates, only the `childDone` terminal message may commit the paired tool result. Failed/cancelled payloads must remain errors through event, Conversation Domain and CLI projection.

The workflow CLI marks an exact `WorkflowFulfill` structured tool error as fatal for the business journey. This policy uses tool identity and `isError`, never assistant prose. TUI and CLI subcommands are compiled through one entry and installed as the single `eidolon` artifact; no `eidolon-cli` launcher or parallel build remains.

## Continuation rule

Before spawning a fresh workflow actor, materialize the parent Conversation Domain and create a bounded structured projection of prior user and assistant business messages. Selection is based only on structural role/order and size limits. Host code must not interpret words, scenario, authorization or topology.

The current structured invocation remains the final prompt section and is authoritative for explicit `publish`/`execute` booleans. Prior text is context, never authorization.

## Verification

- Provider failure after partial assistant output fails the child.
- Sync-wait child failure produces one non-empty error tool result.
- No initial empty tool result competes with childDone.
- A second WorkflowFulfill call receives the earlier business request/plan without reusing prior authorization.
- Real original request creates, proves, publishes and runs in a fresh session.
