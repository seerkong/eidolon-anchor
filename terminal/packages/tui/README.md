# @terminal/tui

Terminal UI built with `@opentui/core`. Entry currently runs the OpenTUI console demo with the debug console docked on the right side. 

## Run

```bash
# from repo root
bun run dev:terminal:tui

# or inside the package
cd terminal/packages/tui
bun run dev
```

- Debug console is on the right; `Ctrl+Y` copies selection (Windows clip / macOS pbcopy / Linux xclip).

## Tests

Run these from `terminal/packages/tui` (repo-root invocation can miss the local TUI context providers).

```bash
bun test ./tests/session-submit.test.tsx
bun test ./tests/dialog-prompt.test.tsx
```

## Streaming pipeline

- The TUI renders assistant output via the shared ingress→lexical→syntactic→semantic→projection stream pipeline, consuming only `tuiControl` and `tuiMessage` events.
- Pipeline messages arrive pre-prefixed (🤔 Think, 🛐 Quote, 🤖 Assist, 🔧 Call). User input and info notices render with `You:` / `Info:` after their emojis.
