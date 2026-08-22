# `codument archive <track-id>`

Archive a completed track only after implementation and verification evidence are present.

```bash
codument validate <track-id> --strict
codument archive <track-id>
```

The command promotes the track's behavior delta, merges eligible full-fidelity decisions from root `decisions.xnl` and recursive `decisions/**/*.xnl` into the canonical XNL decision registry, applies enabled modeling and engineering archive handling, and moves the completed track from `tracks/active/` into `tracks/archived/`. Registry updates commit before the move and roll back together on failure. The `codument-archive-track` operation, not this CLI command, runs explicitly configured before/after hooks.
