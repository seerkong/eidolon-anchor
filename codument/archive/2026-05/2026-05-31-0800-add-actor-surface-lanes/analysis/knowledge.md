# Knowledge Context

## Source Notes
| Source | Summary | Relevance |
|--------|---------|-----------|
| Sparrow actor-team surface types | Defines separate conversation lane, actor lane, backend identity, and questionnaire history structures. | Reference model for this track's contract shape. |
| Sparrow actor-team surface ops | Builds a unified surface projection, lazily initializes teammate lanes, submits human messages to selected actors, and scans global pending questionnaires. | Reference behavior for runtime projection and routing. |
| Sparrow questionnaire registry | Replies by `questionnaire_id`, resolves the owning actor from pending state, writes a questionnaire response mailbox item, and resumes the waiting queue. | Reference behavior for fixing delegate approval stalls. |
| Current `aiagent-questionnaire` spec | Defines structured questionnaire request/result, TUI presentation, answer parsing, and suspend policies. | Existing capability to modify with global pending queue semantics. |
| Current `aiagent-member-holon-primary-model` spec | Establishes `member / holon` and `primary / delegate / detached` terminology. | Naming source for lane backend identities. |
| Current `terminal-tui-shell` spec | Establishes bottom bar, feature menu, dialogs, questionnaire center, and prototype-first TUI direction. | UI target for Actor list and menu reshaping. |

## Codebase Knowledge
- `TerminalRuntime` currently contains primary actor routing, input submission, cancellation, and some questionnaire reply handling.
- TUI runtime hydration already projects questionnaire center data, but the current route is too tied to the control actor path for delegate-local waits.
- TUI dialogs are implemented through reusable dialog primitives and existing system dialogs, so Actor list should follow the same material style.
- `TuiTextGraph` and card projections already maintain per-actor snapshots for semantic events, which can feed actor history viewing once the runtime facade exposes stable actor identities.

## Domain Knowledge
- "Conversation lane" in this track means a human-selectable foreground conversation surface, not an orchestrator scheduling lane.
- "Actor lane" means a concrete runtime actor/fiber surface that has status, transcript, cancelability, and optional active turn identity.
- "Backend identity" means the capability identity behind a conversation lane. It may be an agent, member, holon, or configured actor identity and does not necessarily equal the concrete foreground actor id.
- Questionnaire is a global human-interaction queue because human approval can block background/delegate fibers even when the user is viewing another lane.

## Terms
| Term | Meaning |
|------|---------|
| `conversation_lanes` | UI-selectable foreground lanes such as `lane:primary`, `lane:member:<id>`, or `lane:holon:<id>`. |
| `actor_lanes` | Concrete runtime actors/fibers that can have transcript, status, active turn, and cancellation state. |
| `backend_identity` | Capability identity behind a lane, separate from the foreground lane id and concrete actor id. |
| `questionnaire_surface` | Runtime-global projection of pending and historical questionnaire items keyed by questionnaire id. |
| `owner_actor_id` | Actor that owns a pending questionnaire and should receive the reply. |
| `owner_fiber_id` | Fiber waiting on a pending questionnaire and needing resume after reply. |
