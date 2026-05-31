# Project Memory Attractor

## Purpose

This attractor defines how durable project memory should be promoted when `projectMemory.enabled=true`.

Project memory is not a replacement for specs, docs, or source code. It records durable lessons that should influence future work across tracks.

## Memory Categories

- `lessons`: reusable learning from a completed track, especially constraints, tradeoffs, and rules of thumb that should guide future implementation.
- `incidents`: important failures, regressions, outages, migration problems, or investigation records that should be discoverable later.
- `patterns`: proven recurring approaches, collaboration protocols, design idioms, or validation practices.
- `summaries`: periodic synthesis across multiple memories or a completed body of work.

## Promotion Rules

Promote a memory only when it is durable enough to affect future tracks.

Good:

- Record why a migration strategy worked or failed.
- Record a recurring pitfall and the diagnostic signal that reveals it.
- Record a stable design pattern that multiple future tracks should reuse.
- Summarize a batch of related memories after enough evidence accumulates.

Bad:

- Copy ordinary task logs into memory.
- Store facts that belong in specs, docs, source code, or tests.
- Create a central `index.md` that every branch must edit.
- Promote unresolved speculation as a durable lesson.

## Storage Shape

Use minute-level, track-updated-time ordering:

```text
codument/memory/<category>/YYYY-MM/YYYY-MM-DD-HHmm-slug/
```

Each memory directory should be self-contained. Avoid global index files because they create merge conflicts across branches and contributors.

## Review

Before archive, check whether the track produced durable lessons, incidents, patterns, or summaries. If none exist, do not create memory entries.
