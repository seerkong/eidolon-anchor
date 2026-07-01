# Decisions

## D1: Mission scope

- Decision: Use a mission, not a single track, for long-running turn pause/resume.
- Evidence: The work spans runtime coordinator, persistence/recovery, terminal exec protocol, and historical replay.
- Confidence: 0.9
- Reversibility: moderate
- Durable candidate: yes

## D2: Checkpoint invariant

- Decision: Full VM/runtime snapshots remain safepoint-only; progress pause/resume must use sealed closed facts instead.
- Evidence: Existing `runtime-session-robustness` behavior and previous hardening track deferred production seal specifically to avoid dirty recovery.
- Confidence: 0.95
- Reversibility: hard
- Durable candidate: yes

## D3: External outcome model

- Decision: Target outcome states are `settled`, `paused_with_progress`, and `failed`.
- Evidence: Current `timeout_unsettled` conflates resumable long progress with failure; headless `exec` needs deterministic protocol projection.
- Confidence: 0.85
- Reversibility: moderate
- Durable candidate: yes

