---
name: session-log-repair
description: Use when cleaning or repairing an Eidolon session directory after runtime stalls, repeated tool calls, unpaired tool calls/results, dirty mailbox/control-signal state, or inconsistent snapshot/conversation/log files. Guides safe diagnosis and session-data-only repair using logs/ingress.xnl, logs/diagnostics.xnl, runtime_state, conversation, and actor files.
---

# Session Log Repair

Use this skill to repair a single `.eidolon/sessions/<session-id>` directory so it can be loaded and continued. This skill is for session data repair only. Do not change project runtime code unless the user explicitly asks for a code fix.

## Principles

- Repair by choosing one coherent safepoint and making all persisted session files agree with it.
- Prefer deleting dirty tail data over adding runtime compatibility for dirty data.
- Preserve evidence before edits. Create a timestamped backup under the session directory.
- Use `logs/ingress.xnl` and `logs/diagnostics.xnl` as append-only evidence that is not gated by snapshot saves.
- Do not invent missing tool results. If a tool call has no trustworthy result, trim before that assistant message or convert only when the session already has durable evidence for the result.
- Keep mailbox, control signals, conversation history, transcript, and fiber cooperative state consistent.

## Quick Workflow

1. Identify the session directory and stop any process using it.
2. Inspect current state:
   - `conversation/history-generations/main__active.json`
   - `runtime_state/fibers/*.json`
   - `runtime_state/vm.json`
   - `actors/*/mailboxes.json`
   - `actors/*/state.json`
   - `actors/*/transcript.txt`
   - `logs/ingress.xnl`
   - `logs/diagnostics.xnl`
3. Find the last coherent safepoint:
   - Conversation ends with a non-tool assistant/user message, or an assistant tool call immediately followed by matching tool result messages.
   - No mailbox entry duplicates already-committed conversation input.
   - No `asyncCompletion`, `toolResult`, `childDone`, `control`, `humanInput`, or heartbeat wake remains unconsumed unless the fiber state expects it.
   - Fiber phase is coherent with conversation tail:
     - after a completed tool result batch: `phase="start_llm"`, `toolIndex=toolCalls.length`, no inflight
     - before an unanswered assistant tool call: trim before that assistant message
     - idle waiting for user: `phase="drain"` and `status="suspended"` with an external/human wait reason
4. Back up files before any edit:
   - `conversation/history-generations/main__active.json`
   - `conversation/history.index.json`
   - `runtime_state/manifest.json`
   - `runtime_state/vm.json`
   - `runtime_state/fibers/*.json`
   - `runtime_state/indexes/*.json`
   - `actors/*/mailboxes.json`
   - `actors/*/state.json`
   - `actors/*/transcript.txt`
5. Edit only session files. Do not touch source code.
6. Validate consistency after edits.

## Evidence Reading

Use `jq` for JSON and simple text tools for xnl. Do not parse xnl with ad hoc edits unless only inspecting. For precise xnl parsing, use `xnl-core` from the repo with `bun`.

Useful checks:

```bash
jq '{messageCount, actual:(.messages|length), tail:.messages[-8:]}' "$SESSION/conversation/history-generations/main__active.json"
jq '{status, waitingReason, lane, workloadKind, exec:.metadata.cooperativeExecState}' "$SESSION/runtime_state/fibers/<fiber-file>.json"
jq '.sessionState.controlSignals | {events:(.events|length), checkpoint:.consumedCheckpoint, nextSequence}' "$SESSION/runtime_state/vm.json"
jq '.mailboxes' "$SESSION/actors/<actor-dir>/mailboxes.json"
tail -80 "$SESSION/logs/ingress.xnl"
tail -80 "$SESSION/logs/diagnostics.xnl"
```

When diagnosing loops, compare:

- Repeated ingress `tool` / `toolcall` chunks.
- Diagnostics semantic tool call events.
- Conversation assistant/tool message pairs.
- Fiber `toolCalls`, `toolIndex`, `nextOpSeq`, `pendingAiGenerated`, `pendingToolResults`, and `inflight`.

## Repair Rules

### Conversation

- Keep `messageCount === messages.length`.
- Trim dirty repeated tail as whole assistant/tool pairs.
- Never leave a `tool` message without a matching previous assistant tool call.
- Never leave an assistant tool call without all required tool result messages.
- Prefer ending at a paired tool result and set the fiber to continue with `start_llm`.

### Fiber

For a clean continuation after a completed tool batch:

```json
{
  "status": "ready",
  "waitingReason": null,
  "metadata": {
    "cooperativeExecState": {
      "phase": "start_llm",
      "toolCalls": ["same last assistant tool calls, normalized if needed"],
      "toolIndex": "toolCalls.length",
      "pendingToolResults": [],
      "pendingAiGenerated": [],
      "inflight": null
    }
  }
}
```

Set `nextOpSeq` to a number greater than the last retained operation sequence. It is acceptable to set it near the retained conversation count if no more precise value exists.

For an idle human-wait safepoint:

- `status="suspended"`
- `metadata.cooperativeExecState.phase="drain"`
- no inflight
- mailbox contains only the actual pending user/control input, not an input already committed into conversation.

### VM Control Signals

- If trimming to an earlier safepoint, remove stale pending control events and stale consumed tombstones that refer to discarded operations.
- Set `consumedCheckpoint` and `nextSequence` to match the retained operation horizon.
- Do not keep consumed tombstones for tool calls that no longer exist in conversation.

### Mailboxes

- Clear wake mailboxes that correspond to already-committed conversation messages or consumed tool results.
- Keep a mailbox entry only when it is the intended next input to be consumed after restore.

### Transcript

- If conversation persistence is authoritative, stale transcript content can reintroduce dirty tail context during fallback paths.
- Either trim transcript to the same safepoint or clear it when conversation files are present and authoritative.

## Validation Checklist

Before reporting success:

- `main__active.json` parses, `messageCount` equals `messages.length`.
- The final OpenAI-style tool-call pairing is valid.
- All actor mailboxes are either empty or intentionally pending.
- `runtime_state/vm.json` has no pending stale control signals.
- Every non-terminal fiber can be recovered into a schedulable state: usually `ready` plus a recoverable cooperative phase.
- `logs/ingress.xnl` and `logs/diagnostics.xnl` are not modified except by the running runtime unless the user explicitly requests log trimming.
- Run a read-only recovery smoke test if the project provides one. If not, at least run JSON parse and targeted `jq` checks.

## Output

Report:

- The chosen safepoint.
- Which tail or stale records were removed.
- Which files were changed.
- Whether the session should auto-continue or require the user to send "继续".
- Any remaining risk, especially if logs show the model may still choose the same repeated tool call after restore.
