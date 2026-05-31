# Agent Heartbeat Scheduler

Heartbeat Scheduler lets an actor schedule a future wake without blocking the current LLM turn. It is the runtime equivalent of JavaScript `setTimeout` and `setInterval`: the actor creates a schedule, the current turn can finish, and the runtime later delivers a `heartbeatWake` mailbox item to the target actor.

The model must not sleep or poll inside one response. Use heartbeat when the next useful action is in the future, such as checking a background build, retrying after a cooldown, or periodically inspecting deployment state.

## Tools

| Tool | Purpose |
|------|---------|
| `create_timeout` | Create a one-shot wake. |
| `create_interval` | Create a repeated wake until cancelled or capped by `max_fires`. |
| `list_schedules` | List active schedules by default; pass `status: "terminal"` or `status: "all"` for history. |
| `cancel_schedule` | Cancel a pending timeout or active interval by `schedule_id`. |

Every create call must include:

- `name`: short human-readable label.
- `description`: detailed purpose, check action, completion condition, or stop condition.
- `message`: concise instruction for the future actor turn.
- `delay_seconds` or `interval_seconds`: bounded by runtime limits.

## Timeout Example

```json
{
  "name": "check-build-once",
  "description": "Check build.log once and report whether the background build completed; if still running, decide whether another timeout is needed.",
  "delay_seconds": 60,
  "message": "Check build status",
  "payload": {
    "logFile": "build.log"
  }
}
```

## Interval Example

```json
{
  "name": "watch-deploy",
  "description": "Every minute check deployment status; cancel after success or failure; stop after max_fires to avoid runaway cost.",
  "interval_seconds": 60,
  "max_fires": 20,
  "message": "Check deploy status"
}
```

Use intervals sparingly. Every wake can cause a new LLM turn, so short intervals can create unnecessary token cost. Prefer deterministic scripts or detached background tasks for tight polling loops, and use heartbeat only for the actor decision point.

## Runtime Behavior

- Schedules are session-scoped and are recovered from the runtime snapshot.
- Due schedules are delivered through actor mailbox/fiber orchestration, not by directly calling the model.
- If a matching wake is already pending for the target actor, the scheduler coalesces the duplicate wake and records diagnostics.
- Pending timeouts that are already missed during recovery expire conservatively; active intervals advance to the next future tick without replaying all missed ticks.
