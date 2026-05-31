## Requirements

### Requirement: Sandbox Backend Runtime Abstraction
The system SHALL provide a platform-neutral sandbox backend runtime for command execution across macOS, Linux, and Windows.

#### Scenario: Platform-specific backend selection
- **GIVEN** a Bash tool execution with runtime metadata containing `sandbox_permissions`
- **WHEN** the runtime resolves backend selection
- **THEN** macOS SHALL select the Seatbelt backend for `read-only` or `workspace-write`
- **AND** Linux SHALL select the Linux sandbox backend for `read-only` or `workspace-write`
- **AND** Windows SHALL select the Windows sandbox backend for `read-only` or `workspace-write`
- **AND** `danger-full-access` SHALL select the unsandboxed backend on every platform.

#### Scenario: Bash execution uses backend selection
- **GIVEN** a Bash tool execution with runtime metadata containing sandbox permissions
- **WHEN** the command is executed
- **THEN** the tool SHALL delegate process execution to the sandbox backend runtime
- **AND** SHALL preserve existing local permission authorization before executing the command.

#### Scenario: Existing permission chain is preserved
- **GIVEN** a Bash tool execution requires local permission authorization
- **WHEN** the command is executed through any sandbox backend
- **THEN** the tool SHALL call local permission authorization before resolving or invoking the sandbox backend
- **AND** SHALL keep existing dangerous command guards.

#### Scenario: Writable roots are resolved consistently
- **GIVEN** `workspace-write` mode and runtime metadata with additional writable roots or workspace-access grants
- **WHEN** backend selection is resolved
- **THEN** the selected platform backend SHALL receive a normalized unique list of writable roots
- **AND** read-only mode SHALL receive no writable roots.

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

### Requirement: Linux Sandbox Backend
The system SHALL provide a Linux backend modeled on Codex's bubblewrap plus seccomp sandbox design.

#### Scenario: Linux read-only blocks writes
- **GIVEN** the platform is Linux and `sandbox_mode` is `read-only`
- **WHEN** Bash execution attempts filesystem writes
- **THEN** the Linux backend SHALL run the command in a read-only filesystem view
- **AND** the write attempt SHALL fail without modifying the target path.

#### Scenario: Linux workspace-write permits only writable roots
- **GIVEN** the platform is Linux and `sandbox_mode` is `workspace-write`
- **AND** workspace and additional writable roots are known
- **WHEN** Bash execution writes inside an allowed writable root
- **THEN** the write SHALL succeed
- **WHEN** Bash execution writes outside the writable roots
- **THEN** the write SHALL fail.

#### Scenario: Linux protected metadata remains protected
- **GIVEN** a writable root contains protected metadata directories
- **WHEN** a sandboxed Linux command attempts to write protected metadata paths
- **THEN** the backend SHALL deny or mask those writes.

#### Scenario: Linux network policy is enforced or explicitly rejected
- **GIVEN** the platform is Linux and `network_access` is `disabled`
- **WHEN** Bash execution attempts network access
- **THEN** the backend SHALL isolate or block network access
- **AND** if the required namespace or helper capability is unavailable, execution SHALL fail with a clear sandbox setup error.

### Requirement: Windows Sandbox Backend
The system SHALL provide a Windows backend modeled on Codex's elevated restricted-token and ACL sandbox design.

#### Scenario: Windows read-only uses restricted identity
- **GIVEN** the platform is Windows and `sandbox_mode` is `read-only`
- **WHEN** Bash execution runs a command
- **THEN** the Windows backend SHALL run it under a restricted sandbox identity or token
- **AND** filesystem writes outside required runtime scratch locations SHALL fail.

#### Scenario: Windows workspace-write uses capability-scoped writable roots
- **GIVEN** the platform is Windows and `sandbox_mode` is `workspace-write`
- **AND** writable roots are known
- **WHEN** Bash execution writes inside an allowed writable root
- **THEN** the write SHALL succeed
- **WHEN** Bash execution writes outside allowed writable roots
- **THEN** the write SHALL fail.

#### Scenario: Windows setup state is explicit
- **GIVEN** Windows sandbox setup is required before command execution
- **WHEN** the setup has not completed or required privileges are unavailable
- **THEN** the runtime SHALL return an actionable setup error
- **AND** SHALL NOT silently downgrade to unsandboxed execution.

#### Scenario: Windows network policy is enforced or explicitly rejected
- **GIVEN** the platform is Windows and `network_access` is `disabled`
- **WHEN** Bash execution requests a sandboxed command
- **THEN** the backend SHALL apply the configured Windows network restriction
- **AND** if network filtering is unavailable, execution SHALL fail with a clear degraded-state message rather than allowing unrestricted network access.

### Requirement: Cross-Platform Compatibility
The system SHALL preserve explicit fallback behavior without silently weakening requested sandbox permissions.

#### Scenario: Unsupported backend reports a degraded or unsupported state
- **GIVEN** the host platform requests `read-only` or `workspace-write`
- **AND** the required platform backend dependency is unavailable
- **WHEN** Bash execution attempts to run
- **THEN** the runtime SHALL return a clear error or degraded-state message
- **AND** SHALL NOT silently run the command unsandboxed.

#### Scenario: macOS behavior remains unchanged
- **GIVEN** the platform is macOS
- **WHEN** a command is executed under `read-only`, `workspace-write`, or `danger-full-access`
- **THEN** existing Seatbelt and unsandboxed behavior SHALL continue to pass current sandbox backend tests.

## Acceptance Criteria
- Bash command execution is routed through a reusable sandbox backend runtime.
- macOS Seatbelt command arguments are generated from sandbox mode, network access, workspace root, and additional writable roots.
- macOS Seatbelt writable roots include current workspace write grants from `workspace-access.json`.
- Linux and Windows backend names are added to sandbox backend selection.
- `read-only` and `workspace-write` on Linux and Windows no longer use `unsandboxed` as the normal path.
- Linux backend command construction follows bubblewrap/seccomp helper semantics and is unit-tested.
- Windows backend command construction/setup checks follow elevated restricted-token/ACL semantics and is unit-tested.
- Bash sync and streaming execution can route through Linux and Windows backends.
- Unit tests cover policy generation, backend selection, dangerous fallback, command construction, and Bash integration.
- Existing local permission exec mode tests continue to pass.
