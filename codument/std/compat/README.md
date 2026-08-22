# Compatibility Map

This directory is the only owner of historical Codument names, paths, and format mappings. Current operations and shared standards must not reference these legacy names as active interfaces.

| Historical surface | Current surface |
|---|---|
| `std/actions/` | `std/operations/` |
| `config/action-hooks.xml` / `config/action-hooks.xnl` / `config/operation-hooks.xml` | `config/operation-hooks.xnl` |
| `ActionHooks` / `Actions` / `Action` | `OperationHooks` / `Operations` / `Operation` |
| `std/sop/` | `std/protocols/` and `std/methods/` |
| `codument-discuss-phase` / `codument-revise-track` / `codument-plan-track-wave` | `codument-maintain-track` with `discuss-phase` / `revise` / `schedule` mode |
| `codument-decision-tree` | `std/protocols/decision-tree.md` (introduced with the operation-simplification migration) |

`upgrade-workspace` backs up and removes legacy paths, migrates legacy hook XML when no current hook file exists, migrates legacy track lifecycle paths into `tracks/{active,archived}/` without overwriting conflicts, and removes deprecated distributed skills.
