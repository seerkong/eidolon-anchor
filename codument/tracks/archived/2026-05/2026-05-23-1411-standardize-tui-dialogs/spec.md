## MODIFIED Requirements

### Requirement: TUI Dialog Visual Standardization
The TUI SHALL render dialogs with a consistent shell, border, spacing, title, and action style that follows the established dialog UI/UX standard.

#### Scenario: Dialog uses the standard shell
- **GIVEN** any TUI dialog is opened
- **WHEN** it is displayed on screen
- **THEN** it SHALL use the shared OpenTUI border style rather than relying only on background contrast
- **AND** it SHALL reserve approximately 5% horizontal outer space and 10% vertical outer space unless a specialized dialog explicitly documents tighter constraints
- **AND** it SHALL keep content visually separated from the border by the dialog category's specified inner spacing.

#### Scenario: Close action is consistent
- **GIVEN** any closable TUI dialog is opened
- **WHEN** the close action is rendered
- **THEN** the action SHALL be displayed as `[关闭(esc)]`
- **AND** clicking it or pressing Escape SHALL close the dialog.

### Requirement: TUI Dialog Action Labels
The TUI SHALL render clickable dialog actions with bracketed labels and readable hover/focus states.

#### Scenario: Dialog actions are visibly clickable
- **GIVEN** a dialog contains clickable actions such as delete, rename, confirm, cancel, clear, quit, or command navigation
- **WHEN** those actions are rendered
- **THEN** each clickable action SHALL use bracketed text such as `[删除]`, `[重命名]`, `[确认]`, `[取消]`, or `[清空]`
- **AND** hover and focus colors SHALL preserve sufficient text contrast.

#### Scenario: Confirmation actions remain clear
- **GIVEN** a confirmation dialog is opened
- **WHEN** confirm and cancel actions are shown
- **THEN** the cancel action SHALL render as `[取消]`
- **AND** the confirm action SHALL render as `[确认]` or a specific bracketed verb when configured.

### Requirement: TUI List Dialog Density And Stability
The TUI SHALL render list dialogs with stable dense rows, usable search controls, and no accidental multiline overflow.

#### Scenario: List rows do not wrap
- **GIVEN** a list dialog displays user-generated text, paths, session names, messages, model names, commands, or status values
- **WHEN** an item contains long text
- **THEN** the visible item text SHALL be truncated to the available single-line region
- **AND** it SHALL NOT wrap into additional rows
- **AND** it SHALL NOT overlap right-aligned metadata or actions.

#### Scenario: Search controls are compact and resettable
- **GIVEN** a list dialog provides a search input
- **WHEN** the search row is displayed
- **THEN** the search input SHALL align with the dialog content column
- **AND** a `[清空]` action SHALL appear right-aligned on the same row when supported
- **AND** activating `[清空]` SHALL reset the search input and refresh the visible list.

#### Scenario: List area uses available height
- **GIVEN** a list dialog is displayed
- **WHEN** the dialog has unused vertical content space
- **THEN** the list area SHALL expand to fill the available height
- **AND** the footer or close row SHALL stay anchored according to the dialog category instead of floating above unused blank space.

### Requirement: Sessions Dialog Remains A Specialized Dense List
The Sessions dialog SHALL preserve its specialized three-line dense record layout and reliable session operations.

#### Scenario: Session item layout is stable
- **GIVEN** the Sessions dialog displays a session record
- **WHEN** the record is rendered
- **THEN** line 1 SHALL show session id, compact session name, and right-aligned actions `[分叉会话] [重命名] [删除]`
- **AND** line 2 SHALL show the initial user question and right-aligned created time
- **AND** line 3 SHALL show the latest message or `-` and right-aligned updated time
- **AND** each line SHALL remain a single line regardless of content length.

#### Scenario: Session item actions update real data
- **GIVEN** the user clicks `[删除]`, `[重命名]`, or `[分叉会话]` on a session item
- **WHEN** the operation succeeds
- **THEN** the underlying session source of truth SHALL be updated
- **AND** reopening the Sessions dialog SHALL show the updated state
- **AND** the visible list SHALL refresh without stale `no message yet` placeholders when message data exists.

### Requirement: TUI Form, Alert, Confirmation, And Information Dialogs
The TUI SHALL standardize non-list dialogs while preserving their existing functional behavior.

#### Scenario: Prompt or form dialog uses standard layout
- **GIVEN** a prompt or form dialog is opened
- **WHEN** its input and actions are rendered
- **THEN** it SHALL use the standard dialog border, readable content spacing, bracketed actions, and stable focus styling
- **AND** async confirm actions SHALL avoid duplicate submission.

#### Scenario: Alert and information dialogs use standard layout
- **GIVEN** an alert, shortcut help, status, provider-auth, or informational dialog is opened
- **WHEN** it is rendered
- **THEN** it SHALL use the shared dialog shell and readable border/foreground colors
- **AND** any footer instructions or close actions SHALL use the standard bracketed action style.

## Acceptance Criteria
- Shared dialog primitives are standardized before custom dialog migrations.
- DialogSelect-based command/model/provider/agent/MCP/theme lists inherit the updated standard style.
- File picker, shortcuts, status, and provider auth dialogs are migrated or explicitly documented as compliant.
- Sessions dialog remains dense and its item actions persist after reopening.
- Focus, hover, click, Escape, search clear, scroll, and long-text truncation behavior are verified on key dialog types.
