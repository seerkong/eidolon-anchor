# Findings

## Found Facts
- The project already specifies `member / holon` as the formal organization model and `primary / delegate / detached` as execution semantics.
- The project already has scheduler lanes for holon/member work, but those lanes are runtime scheduling concepts rather than UI-selectable foreground conversation lanes.
- Current questionnaire specs define structured request/result events and `pause_all` / `continue_others`, but the reported bug shows delegate-local questionnaire state is not reliably promoted to a global TUI surface.
- The TUI already has a bottom `[功能菜单]` entry, a `[使用说明]` entry, dialog infrastructure, questionnaire center, message list dialog, and runtime bridge tests.
- Sparrow's actor-team surface separates UI `conversation_lanes`, concrete `actor_lanes`, and lane `backend_identity`, then handles questionnaire replies through a runtime-global pending queue keyed by `questionnaire_id`.

## Constraints
- New surface lanes must not replace the existing member/holon scheduler lanes; they need a distinct contract and naming boundary.
- The primary foreground lane must remain stable even when its backend identity points at a member, holon, agent definition, or model-backed actor identity.
- Questionnaire visibility and reply routing must not depend on the currently watched actor, selected lane, or control actor.
- TUI actor switching must reuse existing dialog patterns and must not break the bottom bar focus controls, busy beacons, or questionnaire center.
- Implementation should prefer shell/runtime facade ports over direct TUI access to low-level actor/orchestrator state.

## Open Questions
- Whether primary backend identity should initially support only configured agent/member/holon identities, or also arbitrary ad hoc actor definitions.
- Whether actor list should show only materialized actors or also uninitialized conversation lanes.
- Whether actor-scoped human message injection should be available for every actor type or limited to foreground-capable actors.

## Conclusions
- The track should add a lower-level actor surface projection and route all UI/TUI actor interaction through it.
- The questionnaire fix should be implemented as part of this surface: every pending questionnaire carries owner actor/fiber identity and appears in a global queue.
- The TUI can then add `[Actor列表]` as a consumer of the actor surface while moving usage guidance into `[功能菜单]`.
