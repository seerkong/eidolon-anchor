# Actor Surface Lanes And Global Questionnaire Specification

## ADDED Requirements

### Requirement: Actor surface projection separates conversation lanes from actor lanes
The system SHALL expose a runtime actor surface projection that separates human-selectable `conversation_lanes` from concrete runtime `actor_lanes`.

#### Scenario: Surface lists stable foreground lanes
- **GIVEN** a session has a primary actor and configured member or holon identities
- **WHEN** the TUI or another shell surface requests the actor surface projection
- **THEN** the projection includes `conversation_lanes`
- **AND** `lane:primary` is always present
- **AND** member or holon lanes are represented with stable lane ids
- **AND** each lane includes display name, kind, status, backend identity, and optional concrete actor id

#### Scenario: Surface lists concrete runtime actors separately
- **GIVEN** the runtime has materialized primary, delegate, detached, member, or holon actors
- **WHEN** the actor surface projection is built
- **THEN** the projection includes `actor_lanes`
- **AND** each actor lane includes actor id, actor type, status, transcript key, active turn identity when available, and cancelability
- **AND** actor lanes are not inferred solely from uninitialized conversation lanes

### Requirement: Primary conversation lane supports configurable backend identity
The system SHALL model the primary foreground lane separately from the backend capability identity that serves it.

#### Scenario: Primary lane remains stable when backend identity changes
- **GIVEN** the user configures the primary actor backend identity to a member, holon, agent definition, or other supported identity
- **WHEN** the actor surface projection is rebuilt
- **THEN** `lane:primary` remains the foreground lane id
- **AND** the lane's `backend_identity` reflects the selected capability identity
- **AND** selecting or configuring that backend identity does not activate or initialize a separate member or holon lane by itself

#### Scenario: Primary backend identity is preserved across runtime refresh
- **GIVEN** the user has selected a non-default primary backend identity
- **WHEN** the TUI hydrates, refreshes, submits a prompt, or resumes a session
- **THEN** the configured backend identity remains visible and effective
- **AND** the system does not reset the primary backend identity unless runtime state explicitly changed it

### Requirement: Member and holon lanes are human-selectable foreground conversation lanes
The system SHALL allow member and holon identities to appear as selectable foreground conversation lanes without conflating them with scheduler lanes.

#### Scenario: Member lane can be selected independently
- **GIVEN** a member identity exists in the current session or configuration
- **WHEN** the TUI opens the actor list
- **THEN** the member appears as a selectable conversation lane
- **AND** selecting it changes the viewed conversation target
- **AND** sending a human message routes to that member lane's concrete actor when initialized

#### Scenario: Holon lane can be selected independently
- **GIVEN** a holon identity exists in the current session
- **WHEN** the TUI opens the actor list
- **THEN** the holon appears as a selectable conversation lane with its governance metadata
- **AND** selecting it does not change the primary lane backend identity
- **AND** holon scheduler lanes remain a separate runtime concern

### Requirement: Conversation lane actor binding is lazy and explicit
The system SHALL support conversation lanes that exist before their concrete actor has been materialized.

#### Scenario: Uninitialized member or holon lane is visible
- **GIVEN** a member or holon identity is configured but has no concrete runtime actor for the current session
- **WHEN** the actor surface projection is built
- **THEN** the conversation lane is visible with `initialized=false`
- **AND** its `actor_id` is empty or absent
- **AND** its backend identity remains complete enough for display and routing decisions

#### Scenario: Sending to an uninitialized lane materializes the actor
- **GIVEN** the user sends a human message to an uninitialized conversation lane
- **WHEN** the runtime accepts the message
- **THEN** the runtime initializes or binds the concrete actor for that lane
- **AND** records the actor binding in session state or the runtime actor index
- **AND** routes the human message to that concrete actor

### Requirement: Questionnaire pending state is runtime-global and owner-routed
The system SHALL expose pending questionnaires through a runtime-global queue keyed by questionnaire id, independent of the selected lane or watched actor.

#### Scenario: Delegate questionnaire appears globally
- **GIVEN** a delegate, detached actor, member, holon, or child fiber requests human input
- **WHEN** it emits a `QuestionnaireRequest`
- **THEN** the pending questionnaire is added to the global questionnaire surface
- **AND** the entry carries `questionnaireId`, session id, owner actor id, owner fiber id when available, request payload, lifecycle state, and suspend policy
- **AND** the TUI can display and answer it even when a different actor lane is selected

#### Scenario: Reply routes back to the owning actor or fiber
- **GIVEN** a pending questionnaire belongs to a non-primary actor or child fiber
- **WHEN** the user submits a reply by questionnaire id
- **THEN** the runtime resolves the pending entry
- **AND** sends the structured `QuestionnaireResult` to the owner actor or resumes the owner fiber
- **AND** removes or marks the pending entry according to its lifecycle state
- **AND** scheduler gates for `pause_all` are released when the owner wait completes

### Requirement: Questionnaire events bypass actor visibility filters
The system SHALL treat questionnaire requests as global human-blocking events rather than ordinary actor transcript events.

#### Scenario: Unwatched delegate approval is still visible
- **GIVEN** a delegate actor is not currently watched and is not the selected actor lane
- **WHEN** it requests questionnaire approval
- **THEN** the request appears in the global questionnaire surface
- **AND** route projection filtering does not hide it from the TUI
- **AND** the shell does not remain silently blocked while waiting for invisible user input

### Requirement: TUI Actor list provides actor switching and actor-scoped operations
The terminal TUI SHALL provide an `[Actor列表]` bottom-bar entry that opens a reusable dialog for viewing and switching actor lanes.

#### Scenario: Bottom bar exposes actor list
- **GIVEN** the TUI bottom bar is rendered
- **WHEN** this track is implemented
- **THEN** `[使用说明]` is moved into `[功能菜单]`
- **AND** the freed bottom-bar button space is used for `[Actor列表]`
- **AND** busy beacon spacing and existing focus controls remain visually stable

#### Scenario: Actor list dialog switches viewed transcript
- **GIVEN** the user opens `[Actor列表]`
- **WHEN** the user selects an actor or conversation lane
- **THEN** the TUI switches the viewed conversation history to that actor or lane
- **AND** the composer indicates the active target
- **AND** ordinary prompt submission routes to the selected target when it is foreground-capable

#### Scenario: Actor list supports actor-scoped control actions
- **GIVEN** an actor in the list has an active or cancellable LLM turn
- **WHEN** the user triggers cancel from the actor dialog
- **THEN** only that actor's active request is cancelled
- **AND** other actors continue or remain queued according to scheduler state

#### Scenario: User can send a manual message to a selected actor
- **GIVEN** the user selects an actor lane from the actor list
- **WHEN** the user enters a manual message for that actor
- **THEN** the message is recorded in that actor's transcript
- **AND** the actor is scheduled or resumed through the runtime facade
- **AND** the primary lane is not implicitly selected unless the user chooses it

### Requirement: Actor surface is exposed through narrow shell runtime facade ports
The system SHALL expose actor surface operations through shell/runtime facade ports rather than requiring TUI code to inspect low-level VM internals.

#### Scenario: TUI consumes facade projection
- **GIVEN** the TUI needs actor lanes, statuses, transcript keys, or pending questionnaires
- **WHEN** it hydrates or receives runtime updates
- **THEN** it calls or subscribes to a stable facade projection
- **AND** it does not directly depend on orchestrator internals, actor mailbox implementation details, or member/holon registries as truth sources

#### Scenario: Facade supports actor-scoped commands
- **GIVEN** the TUI needs to select an actor, cancel an actor turn, send actor human input, or answer a questionnaire
- **WHEN** it invokes the runtime facade
- **THEN** the command is routed by lane id, actor id, or questionnaire id as appropriate
- **AND** the facade returns an updated projection or event sufficient for the TUI to stay in sync

## MODIFIED Requirements

### Requirement: Shell questionnaire collection uses global questionnaire surface
The existing shell questionnaire collection behavior SHALL use the runtime-global questionnaire surface instead of checking only the primary or control actor's pending control mailbox.

#### Scenario: Primary input does not swallow delegate questionnaire replies
- **GIVEN** a delegate-owned questionnaire is pending
- **WHEN** the user answers from the questionnaire dialog or composer-adjacent approval UI
- **THEN** the reply is submitted by questionnaire id
- **AND** the runtime routes it to the delegate owner
- **AND** the primary actor does not receive an unrelated `toolResult`

### Requirement: Terminal guidance is consolidated under the feature menu
The TUI SHALL consolidate usage guidance under `[功能菜单]` so the bottom bar has room for actor switching.

#### Scenario: Feature menu contains usage guidance
- **GIVEN** the user opens `[功能菜单]`
- **WHEN** the menu is displayed
- **THEN** it includes an entry for usage guidance
- **AND** selecting that entry opens the existing usage guidance dialog content
- **AND** no separate bottom-bar `[使用说明]` button is required

## Non-Functional Requirements
- Actor surface projections SHALL be deterministic and cheap enough for frequent TUI hydration.
- Global questionnaire state SHALL be bounded and shall preserve enough lifecycle history for TUI display without unbounded transcript duplication.
- Actor-scoped cancellation and manual messaging SHALL be covered by focused tests for primary, delegate, member, and holon cases where those actor kinds exist.
- The TUI implementation SHALL preserve existing questionnaire center behavior and bottom-bar layout invariants.
