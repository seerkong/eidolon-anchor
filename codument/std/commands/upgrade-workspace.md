# `codument upgrade-workspace`

Refresh the managed Codument standards and installed skill shells in an existing workspace while preserving project-owned tracks, attractors, behaviors, modeling, engineering, decisions, and memory. The command creates a full backup first, then migrates legacy `tracks/<id>/` directories to `tracks/active/<id>/` and legacy `archive/` history to `tracks/archived/`; an existing destination is never overwritten.

```bash
codument upgrade-workspace
codument upgrade-workspace --agent codex
codument upgrade-workspace --skills-dir .agents/skills
```

The command creates a timestamped backup under `.tmp/codument/`, refreshes `codument/std/`, migrates known legacy standard paths, updates the managed root `AGENTS.md` block, and removes deprecated skill directories. Review the printed backup location if a project-specific standard customization needs to be recovered.
