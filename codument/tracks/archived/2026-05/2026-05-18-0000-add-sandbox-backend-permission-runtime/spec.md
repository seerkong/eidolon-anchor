## ADDED Requirements

### Requirement: Sandbox Backend Runtime Abstraction
The system SHALL provide a platform-neutral sandbox backend runtime for command execution.

#### Scenario: Bash execution uses backend selection
- **GIVEN** a Bash tool execution with runtime metadata containing sandbox permissions
- **WHEN** the command is executed
- **THEN** the tool SHALL delegate process execution to the sandbox backend runtime
- **AND** SHALL preserve existing local permission authorization before executing the command

#### Scenario: Workspace access grants extend sandbox writable roots
- **GIVEN** `workspace-access.json` grants write access to a directory outside the workspace for the current workspace
- **AND** the platform is macOS with `sandbox_mode` set to `workspace-write`
- **WHEN** a Bash command is executed through the sandbox backend
- **THEN** the macOS Seatbelt writable roots SHALL include the granted directory
- **AND** SHALL continue to protect workspace metadata directories from generic writes.

#### Scenario: Dangerous mode remains unsandboxed
- **GIVEN** runtime metadata has `sandbox_mode` set to `danger-full-access`
- **WHEN** a Bash command is executed
- **THEN** the runtime SHALL execute without wrapping the command in a sandbox backend
- **AND** SHALL retain existing dangerous command guards.

### Requirement: macOS Seatbelt Backend
The system SHALL provide a macOS Seatbelt backend that wraps shell commands with `/usr/bin/sandbox-exec`.

#### Scenario: workspace-write restricts writes to allowed roots
- **GIVEN** the platform is macOS and `sandbox_mode` is `workspace-write`
- **AND** the workspace root and additional writable roots are known
- **WHEN** a Bash command is executed
- **THEN** the command SHALL run under a Seatbelt policy that permits writes only under those writable roots
- **AND** SHALL protect workspace metadata directories from generic writes.

#### Scenario: read-only blocks writes
- **GIVEN** the platform is macOS and `sandbox_mode` is `read-only`
- **WHEN** a Bash command attempts filesystem writes
- **THEN** the Seatbelt policy SHALL deny those writes.

#### Scenario: network follows runtime metadata
- **GIVEN** the platform is macOS and `network_access` is disabled
- **WHEN** a Bash command is executed through the sandbox backend
- **THEN** the generated Seatbelt policy SHALL omit broad outbound and inbound network permissions.

### Requirement: Cross-Platform Compatibility
The system SHALL preserve existing behavior on platforms without macOS Seatbelt support.

#### Scenario: non-macOS workspace-write falls back safely
- **GIVEN** the platform is not macOS
- **WHEN** Bash execution requests `workspace-write`
- **THEN** the runtime SHALL execute through the existing unsandboxed process path
- **AND** SHALL keep local permission checks as the primary enforcement layer.

## Acceptance Criteria
- Bash command execution is routed through a reusable sandbox backend runtime.
- macOS Seatbelt command arguments are generated from sandbox mode, network access, workspace root, and additional writable roots.
- macOS Seatbelt writable roots include current workspace write grants from `workspace-access.json`.
- Unit tests cover policy generation, backend selection, dangerous fallback, and Bash integration.
- Existing local permission exec mode tests continue to pass.
