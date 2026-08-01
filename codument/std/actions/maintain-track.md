# codument-maintain-track

Maintain an existing track with one explicit mode: `discuss-phase`, `revise`, or `schedule`.

- `discuss-phase`: refine a phase's TaskSpace, acceptance, and risks.
- `revise`: update the minimum track-local proposal, design, decisions, deltas, or plan artifacts after evidence changes scope.
- `schedule`: add or revise direct-child DAG dependencies and parallel limits.

Read the target track and the shared protocols in `std/protocols/` and methods in `std/methods/`. Preserve the track as the state source, make only evidence-backed changes, validate it strictly, and report changed files. This action replaces the legacy bodies documented in `std/compat/`.
