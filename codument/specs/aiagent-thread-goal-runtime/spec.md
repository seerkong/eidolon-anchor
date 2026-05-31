# Spec: AIAgent thread goal runtime

## Requirements

### Requirement: The system shall persist a thread goal as a first-class runtime entity

The system SHALL store exactly one current goal per thread when a goal is active. The stored goal SHALL include objective, status, budget, usage, and timestamps, and SHALL survive session resume for persisted threads.

#### Scenario: Create and restore a goal

- GIVEN a persisted thread with no current goal
- WHEN the user sets a goal
- THEN the system SHALL persist the goal for that thread
- AND the goal SHALL be available after the session is resumed

#### Scenario: Ephemeral threads cannot retain goals

- GIVEN an ephemeral thread without persisted state
- WHEN the user or model attempts to create or update a goal
- THEN the system SHALL reject the mutation
- AND SHALL explain that the thread must be persisted to support goals

### Requirement: The system shall provide a `/goal` user control surface

The system SHALL expose a `/goal` command surface that lets the user create, inspect, edit, pause, resume, replace, and clear the current thread goal.

#### Scenario: Create a goal from the user command surface

- GIVEN a thread with no current goal
- WHEN the user submits `/goal <objective>`
- THEN the system SHALL create an active goal for the thread
- AND SHALL surface the goal status to the user

#### Scenario: Edit or manage an existing goal

- GIVEN a thread with an existing goal
- WHEN the user submits `/goal edit`, `/goal pause`, `/goal resume`, or `/goal clear`
- THEN the system SHALL apply the requested goal action
- AND SHALL update the visible goal state accordingly

### Requirement: The system shall expose goal read/write tools to the model

The system SHALL provide model-callable goal tools for reading and managing the current goal. The write surface SHALL be constrained so the model can only mark a goal complete or blocked when allowed by the runtime policy.

#### Scenario: Read the current goal

- GIVEN a thread with a current goal
- WHEN the model calls `get_goal`
- THEN the system SHALL return the current goal and its usage summary

#### Scenario: Mark a goal complete or blocked

- GIVEN an active goal whose completion or blocked conditions are satisfied
- WHEN the model calls `update_goal`
- THEN the system SHALL permit only the approved terminal status values
- AND SHALL reject pause, resume, budget-limited, and usage-limited writes from the model

### Requirement: The runtime shall account goal usage and continue active goals when idle

The system SHALL account token and elapsed-time usage for active goals across turn lifecycle events, SHALL update budget-related statuses when needed, and SHALL automatically continue an active goal when the session becomes idle and no higher-priority user input is pending.

#### Scenario: Account progress during a turn

- GIVEN an active goal and an in-progress turn
- WHEN the turn completes, aborts, or triggers goal-related tool activity
- THEN the system SHALL update token and time usage for that goal

#### Scenario: Continue an active goal when idle

- GIVEN an active goal and no active turn or pending user input
- WHEN the runtime checks for idle continuation
- THEN the system SHALL inject the continuation prompt and start the next goal turn

### Requirement: Goal completion and blocking shall use strict audit rules

The system SHALL treat goal completion as unproven until the current state is audited against the original objective. The system SHALL only mark a goal blocked after the same blocking condition has recurred for the required number of consecutive goal turns and the runtime cannot make meaningful progress without external input.

#### Scenario: Complete only after evidence-based audit

- GIVEN an active goal near the end of a task
- WHEN the runtime considers completing the goal
- THEN the system SHALL require the current state to satisfy the full objective
- AND SHALL NOT mark the goal complete merely because the turn is ending or the budget is low

#### Scenario: Block only after repeated impasse

- GIVEN a goal that hits the same blocking condition across consecutive goal turns
- WHEN the blocking threshold is satisfied
- THEN the system SHALL mark the goal blocked
- AND SHALL stop keeping the goal active without resolution

### Requirement: Goal state changes shall propagate to user-visible surfaces

The system SHALL notify connected user-visible surfaces when a goal is created, updated, paused, resumed, blocked, budget-limited, or completed, so the current objective and its usage remain visible to the user.

#### Scenario: Surface updates after goal mutation

- GIVEN a current thread goal
- WHEN the goal changes state
- THEN the system SHALL emit a goal update event or equivalent state change notification
- AND connected surfaces SHALL be able to render the updated objective and status
