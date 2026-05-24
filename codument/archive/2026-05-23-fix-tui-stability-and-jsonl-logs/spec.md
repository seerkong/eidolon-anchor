## ADDED Requirements

### Requirement: TUI remains responsive under sustained runtime activity
The system SHALL keep the terminal UI responsive during long coding sessions with frequent runtime events, without unbounded synchronous logging or uncontrolled projection work in the hot path.

#### Scenario: Frequent runtime updates do not lock the UI
- **GIVEN** a session that continuously receives message and part updates
- **WHEN** the user keeps typing and the runtime continues emitting events
- **THEN** the UI SHALL continue to accept input and render updates without becoming unresponsive

#### Scenario: Repeated bootstrapping does not amplify overhead indefinitely
- **GIVEN** the runtime and sync layers emit repeated lifecycle and status events
- **WHEN** those events arrive over a long session
- **THEN** the system SHALL avoid runaway growth in per-event logging and projection cost

### Requirement: Non-state logs use append-only JSONL storage
The system SHALL store non-state diagnostic logs in append-only JSONL files, with one structured record per line and without rewriting prior log content in place.

#### Scenario: Diagnostic logs are appended, not rewritten
- **GIVEN** the UI emits a diagnostic log entry
- **WHEN** the log sink persists the entry
- **THEN** the sink SHALL append one JSON object line to the JSONL file
- **AND** the sink SHALL NOT require reading and rewriting the existing file contents

#### Scenario: State-bearing data stays in runtime/session stores
- **GIVEN** a runtime event or session update that is part of application state
- **WHEN** the system processes that update
- **THEN** the system SHALL keep the state in the existing runtime/session state path
- **AND** SHALL NOT reclassify it as a non-state JSONL log record
