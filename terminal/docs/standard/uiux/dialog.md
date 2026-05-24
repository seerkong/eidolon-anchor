# TUI Dialog UI/UX Standard

This document defines the shared dialog rules for `eidolon-tui`. Apply these rules when creating or refactoring any TUI dialog so all surfaces feel consistent, compact, and operable in a terminal.

## Core Principles

- Dialogs are work surfaces, not marketing panels. Use dense, predictable layouts that optimize scanning and repeated actions.
- Prefer OpenTUI built-in layout, border, scrollbox, input, and text renderables. Avoid hand-drawn borders unless OpenTUI cannot express the needed shape.
- Every clickable command label in a dialog must be visually bracketed, for example `[关闭(esc)]`, `[清空]`, `[删除]`.
- Button labels should be action-first and short. Use Chinese labels in Chinese-facing dialogs.
- Dialog content must not rely only on background contrast. Use the shared dialog border and theme colors.
- Text must not overlap adjacent columns, buttons, or timestamps. Long text must be truncated or constrained by layout.

## Dialog Shell

- Dialogs should use the shared `Dialog` shell from `ui/dialog.tsx`.
- The shell should leave approximately 5% horizontal viewport margin and 10% vertical viewport margin.
- The shell should use an OpenTUI border, currently rounded, with the shared secondary border color.
- The default dialog shell may provide top padding for normal dialogs, but special dense dialogs may opt out and control their own inner spacing.
- Dialogs should close on `esc` and on click outside, unless a modal flow explicitly prevents this.
- The close action should be rendered as `[关闭(esc)]` when visible.
- Do not render duplicate close/cancel affordances. If a dialog footer already has `[取消]`, omit the header `[关闭(esc)]`.

## Spacing

- Standard dialogs may use comfortable spacing: one line between major sections and one line of bottom breathing room.
- Dense dialogs must keep vertical chrome minimal. For a dense full-surface list, the intended visual rule is:
  - top inner spacing: one terminal row from border to title
  - bottom inner spacing: one terminal row from footer/close line to border
  - horizontal inner spacing: one character from border to content
- Do not add redundant padding in both the shared shell and the dialog body. If a dialog owns exact spacing, configure the shell padding accordingly.
- A scrollable list that should occupy remaining height must use a `flexGrow` container and a scrollbox with fixed fill height, not `maxHeight` alone.

## Header And Footer

- List-style dialogs should normally place the title at top-left.
- If a dialog needs maximum vertical density, do not place `[关闭(esc)]` in the header. Put `[关闭(esc)]` at the bottom-right.
- If `[关闭(esc)]` is in the footer, the main content area should expand to push it to the bottom.
- The row immediately above a bottom close/footer row should have exactly one blank line of separation unless the dialog type explicitly requires no gap.
- Header right-side actions are allowed for normal dialogs, but all clickable labels still need brackets.
- Header close actions are for read-only or list dialogs. Form, confirmation, alert, and other action dialogs that already provide footer actions should hide the header close action.
- When a footer contains both a committing action and a no-op/cancel action, put the no-op action on the far right. Use `[确认] [取消]`, or `[删除] [取消]` for destructive confirmation, so an accidental click on the rightmost action does not commit changes.

## Inputs

- Search inputs should be single-line and visually aligned with the dialog content inset.
- Search action buttons such as `[清空]` must be right-aligned on the search row, not adjacent to the input text when the input is empty.
- Search rows should leave one blank line before the list when the dialog is not extremely compact; dense dialogs may still keep this one row if scanning benefits.
- Clear actions must reset the text field, filter state, selection index, and scroll position.

## List Dialogs

Use this type for command palettes, selection lists, model/provider pickers, help menus, and similar surfaces.

- The list should be keyboard and mouse navigable.
- Hover and active states must keep text readable. Avoid highlight colors that reduce contrast with the text.
- Active/hover colors should fit the global theme and not introduce unrelated hues.
- Repeated list items should avoid nested cards. Use rows or compact row groups.
- Long titles and descriptions must be truncated or constrained to one line unless the dialog intentionally supports multi-line details.
- Metadata columns, timestamps, or action groups must have fixed or flex-shrink-safe widths so they do not collide with primary text.
- If item actions exist, clicking the action must not accidentally trigger the row selection.

## Dense List Dialogs

Use this type for high-volume operational lists such as Sessions.

- Prefer a custom dense surface rather than a generic select component when the row structure is specialized.
- Keep the dialog body in control of exact spacing. The shared shell should not add extra top padding on top of the dense layout.
- The list area must expand to fill available space, with footer controls pinned to the bottom.
- Use a scrollbox that fills the remaining height. Do not let the list shrink to only its content height when fewer items exist.
- Each record must have a stable row height. For Sessions, each item is three rows:
  - row 1: session id, compact session name, right-aligned item actions
  - row 2: initial question and right-aligned created time
  - row 3: latest message or `-`, and right-aligned updated time
- Row 1 action labels for Sessions are `[分叉会话] [重命名] [删除]`.
- Row 1 outside the action labels should not switch sessions when clicked.
- Rows 2 and 3 may switch/select the session.
- Session titles, messages, and timestamps must be truncated or constrained so they never overlap item actions.
- If the latest message is identical to the initial message or absent, show `-` in the latest-message row.

## Form Dialogs

Use this type for prompts, rename dialogs, export options, and other edit flows.

- Header title stays top-left. Forms with footer `[取消]` must not also show header `[关闭(esc)]`.
- Standard form content should use the dialog shell plus a clear body inset, currently four characters left/right and one row of bottom padding, unless a dense specialized dialog documents tighter spacing.
- Inputs should have clear focus styling and sufficient contrast.
- Submit/cancel affordances should be explicit. In footer action rows, the committing action comes before cancel, with cancel on the far right.
- Async submit handlers must be awaited before closing when the submit changes persistent data.
- Form state changes that affect list previews or titles should emit or trigger the same data synchronization path as non-dialog actions.

## Confirmation Dialogs

Use this type for destructive or irreversible actions when direct action is too risky.

- Keep content short: title, one concise message, and action row.
- Destructive actions should be visually distinct but readable.
- Buttons must use bracket labels. The no-op action belongs on the far right, for example `[删除] [取消]` or `[确认] [取消]`.
- Confirmation dialogs with footer cancel actions must not also show header `[关闭(esc)]`.
- If an action is intentionally one-click inside a dense list, the product decision should be explicit and the list should update immediately after success.

## Information Dialogs

Use this type for help, status, shortcuts, and read-only details.

- Prefer structured sections over prose-heavy blocks.
- Lists of commands or shortcuts should be scannable, with aligned labels and descriptions.
- Scroll areas should fill the intended content space when the dialog is tall.
- Footer hints should not float in the middle of the dialog; they belong at the bottom if present.

## Nested Detail Dialogs

Use this type for drill-in views opened from a list inside the same dialog flow, such as questionnaire history details.

- Inventory must include both the parent list and every drill-in detail surface; a parent that uses `DialogSelect` does not make custom detail views compliant automatically.
- If `esc`, `backspace`, or `left` returns to the parent list instead of closing the dialog, do not show `[关闭(esc)]` on the detail view.
- Show one explicit bracketed return action, normally `[返回]`, and place it in the footer rather than exposing raw shortcut text such as `left/backspace`.
- Detail scroll areas should fill the remaining height so footer actions stay anchored near the bottom of the dialog.
- Nested detail views should follow form/detail spacing unless they are documented as dense specialized surfaces.

## Data Synchronization Expectations

- Dialog actions must update the source of truth, not only the visible list.
- If a dialog action changes sessions, titles, previews, or deletion state, reopening the dialog must show the same result.
- Runtime actions should emit the appropriate sync event:
  - session created: upsert into the session list
  - session updated: update title, timestamps, preview, and status-relevant fields
  - session deleted: remove from the session list
- Session list previews must come from session data, not ad hoc UI reconstruction.

## Implementation Checklist

- Uses shared dialog shell and OpenTUI border.
- Custom drill-in views are checked separately from their parent dialog launcher.
- Bracketed clickable labels.
- No duplicated shell/body padding.
- Correct close-button placement for the dialog type.
- Scroll area expands when it should.
- Footer/close row is pinned to the intended bottom position.
- Long text is truncated or constrained.
- Hover/active state remains readable.
- Mouse action handlers stop propagation when needed.
- Persistent actions survive dialog close/reopen.
- Tests cover any non-trivial synchronization behavior.
