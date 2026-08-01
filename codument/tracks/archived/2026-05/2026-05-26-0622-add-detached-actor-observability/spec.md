# add-detached-actor-observability Specification

## ADDED Requirements

### Requirement: Detached bash logs are queryable while running
The system SHALL expose scoped, bounded log queries for `RunDetachedBash` tasks while they are pending, running, suspended, or terminal.

#### Scenario: Query recent stdout only
- **GIVEN** a `RunDetachedBash` task has emitted stdout and stderr chunks
- **WHEN** the caller queries detached logs with `sources=["stdout"]`
- **THEN** the response SHALL include only stdout log entries
- **AND** the response SHALL include sequence metadata for follow-up polling

#### Scenario: Query recent stderr only
- **GIVEN** a `RunDetachedBash` task has emitted stderr chunks
- **WHEN** the caller queries detached logs with `sources=["stderr"]`
- **THEN** the response SHALL include only stderr log entries
- **AND** stdout entries SHALL NOT be included

#### Scenario: Query log range by sequence
- **GIVEN** a `RunDetachedBash` task has emitted ordered log chunks
- **WHEN** the caller queries with `after_seq`
- **THEN** the response SHALL include only entries with sequence greater than `after_seq`
- **AND** the response SHALL include the next sequence cursor

#### Scenario: Log retention rolls over
- **GIVEN** a `RunDetachedBash` task emits more logs than the configured retention limits
- **WHEN** the oldest entries are discarded
- **THEN** the query response SHALL report dropped entry or byte metadata
- **AND** the remaining entries SHALL preserve monotonic sequence ordering

### Requirement: Detached delegate messages are queryable while running
The system SHALL expose recent message and execution event queries for detached `RunDelegateActor` tasks.

#### Scenario: Query recent assistant messages
- **GIVEN** a detached delegate actor has produced assistant messages and tool events
- **WHEN** the caller queries messages with `roles=["assistant"]`
- **THEN** the response SHALL include only assistant message entries
- **AND** the response SHALL include sequence metadata for follow-up polling

#### Scenario: Query recent tool events
- **GIVEN** a detached delegate actor has started and completed tool calls
- **WHEN** the caller queries messages with `kinds=["tool_call","tool_result"]`
- **THEN** the response SHALL include tool call and tool result entries
- **AND** ordinary assistant text SHALL NOT be included unless requested

#### Scenario: Query message range and limit
- **GIVEN** a detached delegate actor has many message entries
- **WHEN** the caller provides `after_seq`, `limit_entries`, or `limit_bytes`
- **THEN** the response SHALL honor the requested range and limits
- **AND** it SHALL report truncation or dropped-entry metadata when applicable

### Requirement: Detached task result is queryable after completion
The system SHALL provide a focused result query for detached tasks that returns terminal status and final output.

#### Scenario: Completed detached bash result
- **GIVEN** a `RunDetachedBash` task has completed
- **WHEN** the caller queries the detached result
- **THEN** the response SHALL include terminal status, final output summary, and available stdout/stderr tail data
- **AND** the response SHALL indicate whether logs were truncated or rolled over

#### Scenario: Completed delegate result
- **GIVEN** a detached `RunDelegateActor` task has completed
- **WHEN** the caller queries the detached result
- **THEN** the response SHALL include terminal status and final assistant result text
- **AND** the caller MAY request a bounded recent message tail in the same response

#### Scenario: Result requested before terminal state
- **GIVEN** a detached task is not yet completed, failed, or cancelled
- **WHEN** the caller queries the detached result without allowing partial results
- **THEN** the response SHALL report that the task is not terminal
- **AND** it SHALL include the current task status

### Requirement: Existing detached status compatibility is preserved
The system SHALL preserve existing detached task status behavior while adding observability-specific tools.

#### Scenario: Existing status query remains valid
- **GIVEN** a caller uses `DetachedActorStatus` for an existing detached task
- **WHEN** the observability implementation is enabled
- **THEN** the status response SHALL continue to include task id, kind, status, timestamps, child identifiers, output text, and error
- **AND** callers needing logs or message tails SHALL use the new observability query tools

## Non-Functional Requirements
- Log and message buffers SHALL be bounded by count and byte limits.
- Sequence ids SHALL be monotonic per detached task and stable for polling.
- Query responses SHALL avoid exposing hidden system prompts or non-user-visible reasoning content.
- Background progression SHALL remain owned by actor/fiber orchestration.

## Acceptance Criteria
- `RunDetachedBash` supports running-time stdout and stderr queries by source.
- `RunDelegateActor(mode="detached")` supports running-time recent message queries by role, kind, range, and limit.
- Completed detached tasks expose terminal results through a dedicated query.
- Log overflow reports dropped/truncated metadata.
- Existing detached status tests continue to pass.

## Out Of Scope
- A full terminal UI for browsing detached logs.
- Durable storage for arbitrarily large logs beyond bounded task observability data.
- Replaying interrupted in-flight bash processes after recovery.
