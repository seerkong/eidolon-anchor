---
name: eidolon-cli-auto-debug
description: Use when autonomously reproducing, diagnosing, and verifying Eidolon session recovery/runtime issues with eidolon-cli, especially historical .eidolon/sessions directories that need session-upgrade plus headless exec validation.
---

# Eidolon CLI Auto Debug

Use this workflow to debug a real Eidolon session without relying on TUI clicks.

## Rules

- Work on a temporary copy of the target workspace or session first.
- Do not modify another project repository's code while debugging an Eidolon runtime issue unless the user explicitly asks.
- Treat `logs/*` journal sinks as diagnostic evidence only. Do not require or perform journal sink migration during session upgrade.
- Validate with `eidolon-cli`/`terminal/packages/cli` headless execution before claiming a session recovery bug is fixed.

## Repro Workflow

1. Copy the affected project workspace or at least the target `.eidolon/sessions/<sessionId>` into `/tmp`.
2. Run single-session upgrade in apply mode against the copied session:

```bash
bun run --cwd terminal/packages/cli dev session-upgrade --session-dir /tmp/<workspace>/.eidolon/sessions/<sessionId> --apply
```

3. Run headless exec against the copied workspace and session. Put trace/last-message outputs outside the
   copied workspace so the agent cannot discover its own validation artifacts through project searches:

```bash
mkdir -p /tmp/eidolon-cli-debug-artifacts
bun run --cwd terminal/packages/cli dev exec \
  --cwd /tmp/<workspace> \
  --session <sessionId> \
  --timeout 45 \
  --output-trace /tmp/eidolon-cli-debug-artifacts/<sessionId>-trace.jsonl \
  --output-last-message /tmp/eidolon-cli-debug-artifacts/<sessionId>-last-message.txt \
  "请用一句话说明当前任务状态，不要调用工具。"
```

4. Inspect:
   - `/tmp/eidolon-cli-debug-artifacts/<sessionId>-trace.jsonl`
   - `/tmp/eidolon-cli-debug-artifacts/<sessionId>-last-message.txt`
   - `<sessionDir>/logs/diagnostics.xnl`
   - `<sessionDir>/logs/ingress.xnl`
   - `<sessionDir>/runtime-control/effects.xnl`
   - `<sessionDir>/runtime_state/fibers/*.json`
   - `<sessionDir>/runtime_state/vm.json`
   - `<sessionDir>/conversation/history.xnl`

## Pass Criteria

A fix is not verified until headless exec can load the upgraded session and make forward progress under `eidolon-cli`.

For prompts that explicitly say not to use tools, the run should produce a final assistant answer without resuming stale tool loops. If the old task is legitimately continued, every tool result must be paired with the matching tool call in the model-visible history.

## Known Failure Patterns

- Upgrade succeeds and recovery classifies clean, but exec resumes an old `start_llm` phase instead of consuming the new user input.
- Model-visible history misses tool results, so the model repeats a read/sed/bash tool call.
- A checkpoint only covers a WAL prefix; WAL tail evidence must not make the checkpoint dirty.
- Journal sinks can be ahead of checkpoint and must not influence recovery classification.

## Diagnostic Questions

- Which source provides model-visible history after upgrade: `conversation/history.xnl`, actor transcript, runtime snapshot, or prompt generation records?
- Was the new headless input appended to conversation/mailbox before a recovered `start_llm` executes?
- Does the prompt builder include all assistant tool calls and corresponding tool outputs?
- Is a stale cooperative execution phase being treated as runnable foreground work after an explicit new interactive turn?
