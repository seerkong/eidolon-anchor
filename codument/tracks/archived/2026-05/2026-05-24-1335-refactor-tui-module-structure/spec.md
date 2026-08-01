# Spec: Refactor TUI Module Structure

## ADDED Requirements

### Requirement: TUI source shall be organized by ownership and dependency direction
The system SHALL reorganize `terminal/packages/tui/src` so source files are grouped by stable responsibilities: entry/startup, runtime adapter, concrete TuiA1 app, reusable UI, providers, commands, support utilities, and types.

#### Scenario: Developer locates TuiA1 feature code
- **GIVEN** a developer needs to modify a concrete TuiA1 feature
- **WHEN** they inspect `terminal/packages/tui/src`
- **THEN** TuiA1-specific feature code is under an app-owned TuiA1 area rather than mixed with generic UI or support code.

#### Scenario: Developer locates reusable UI code
- **GIVEN** a developer needs to modify a reusable dialog or primitive
- **WHEN** they inspect `terminal/packages/tui/src`
- **THEN** reusable presentation code is under a reusable UI area and does not import the concrete TuiA1 app implementation.

### Requirement: Final source shall not rely on import aliases
The system SHALL remove TUI-local import alias usage from final source code and SHALL not leave alias-based compatibility code after the migration is complete.

#### Scenario: Alias scan after refactor
- **GIVEN** the refactor is complete
- **WHEN** source code under `terminal/packages/tui/src` is scanned for TUI-local aliases such as `@tui/` and `@/`
- **THEN** no import statements use those aliases.

#### Scenario: Compatibility shim scan after refactor
- **GIVEN** the refactor is complete
- **WHEN** old compatibility barrel files or migration-only re-export files are reviewed
- **THEN** no migration-only compatibility code remains.

### Requirement: Potentially unused or inactive features shall be inventoried before deletion
The system SHALL collect code paths that appear unused, inactive, or future-scaffolded into a track-local inventory before deciding whether to remove, retain, or relocate them.

#### Scenario: LSP code is discovered during refactor
- **GIVEN** LSP-related code exists in TUI but may not be actively exposed
- **WHEN** the refactor evaluates feature ownership
- **THEN** LSP files and call paths are recorded in the inventory with a recommendation to keep, move, or delete.

#### Scenario: Unused code is removed
- **GIVEN** a code path is recorded as unused or inactive
- **WHEN** the implementation removes it
- **THEN** the decision and validation evidence are recorded in the track artifacts.

### Requirement: Refactor shall preserve existing TUI behavior
The refactor SHALL preserve current user-facing TUI behavior, including streaming output, composer behavior, system dialogs, session list, message list, runtime selection, and command entry behavior.

#### Scenario: TUI tests run after structural moves
- **GIVEN** files have been moved or split
- **WHEN** the TUI package tests run
- **THEN** the tests pass without regressions caused by missing imports or behavior changes.

#### Scenario: Runtime entry still launches TUI
- **GIVEN** the package entry commands are updated
- **WHEN** the existing dev or CLI startup flow launches the TUI
- **THEN** it reaches the same TuiA1 app behavior as before the refactor.

## Acceptance Criteria
- `terminal/packages/tui/src` has a shallower, responsibility-based structure.
- TuiA1-specific code is separated from reusable UI and generic provider code.
- The final implementation contains no TUI-local import alias usage such as `@tui/` or `@/`.
- Temporary compatibility shims created during migration are removed by the final phase.
- Inactive or unused feature candidates are recorded with keep/remove decisions.
- TUI tests and targeted import scans pass.

## Out Of Scope
- Redesigning the TUI visual appearance.
- Changing runtime protocol behavior.
- Introducing a new TUI variant beyond organizing TuiA1 to allow future variants.
- Large cross-package extraction unless required to repair a direct source import boundary.
