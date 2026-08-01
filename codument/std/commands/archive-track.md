# `codument archive <track-id>`

Archive a completed track only after implementation and verification evidence are present.

```bash
codument validate <track-id> --strict
codument archive <track-id>
```

The command promotes the track's behavior delta, applies enabled modeling and engineering archive handling, runs explicit artifact hooks, and moves the completed track from `tracks/active/` into `tracks/archived/`. Resolve validation failures or merge conflicts before retrying; archive does not leave partial registry updates behind.
