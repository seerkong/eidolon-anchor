# Validation Protocol

Validation checks return a compact verdict and evidence. General checks use `PASS | GAP | BLOCKED`; GapLoop uses `NO_GAP | FIX_APPLIED | BLOCKED`.

## HumanConfirm

Run the configured automatic checks first, present their evidence, then yield for the required confirmation. A rejected confirmation returns control to implementation and repeats the same gate after repair.

## GapLoop

The parent coordinator owns rounds. Each round uses a fresh child context to compare the selected scope with proposal, design, behavior deltas and Acceptance, write a report, apply in-scope repairs when possible, and return:

```text
status: NO_GAP | FIX_APPLIED | BLOCKED
summary: <one concise line>
evidence: <report path or decisive check>
```

`FIX_APPLIED` always starts another fresh verification round. `NO_GAP` closes the loop unless the configured `verify_round` requires one additional lightweight confirmation. `BLOCKED` returns the concrete missing decision or external dependency.

Track validation mode is represented by the configured `GapLoop` or `HumanConfirm` hooks. Full execution rules live in `std/operations/gap-loop.md`.
