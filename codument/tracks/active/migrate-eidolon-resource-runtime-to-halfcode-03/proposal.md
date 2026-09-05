# Proposal: migrate Eidolon resource runtime to Halfcode 0.3

## Problem

Halfcode 0.3 and the Holarchy local-file package line now have verified release candidates, but Eidolon still authors `halfcode.resources/v1` envelopes and consumes the 0.2 `LoadedResourceTree` model. The standalone Holon task runtime therefore passes isolated service tests while its normal-VM physical registry test is correctly refused: the real registry cannot prove exact Kind ownership and reader compatibility.

## Change

1. Make `holarchy-eidolon-adapter` the owner of the `HolonExecutionBinding` Kind and `ai-organ-contract` the owner of `HolonTaskRuntimeDefinition`, each with an immutable Halfcode 0.3 owner/spec revision/reader registration.
2. Migrate Eidolon-authored ResourcePackages and generators to `halfcode.resource-envelope/v1` and numeric `specVersion`.
3. Refactor the host adapter from the 0.2 loaded-tree assumption to an explicit authored → exact resolved pipeline before domain projection.
4. Consume the Halfcode/Holarchy 0.3 release candidates in physical verification, then prove normal VM, standalone assignment, crash-after-effect and fresh-process recovery.
5. Prepare, but do not publish, the public `holarchy-eidolon-adapter` tarball.

## Non-goals

- Reimplementing Holon snapshot semantics in Eidolon.
- Adding a permissive legacy envelope reader or guessed compatibility profile.
- Migrating depa-flows package ownership inside this Track; any genuine external contract blocker is reported as scope drift rather than hidden by host code.
- Publishing packages to npm. Any later authorized publish uses `/Users/kongweixian/.npmrc_official` explicitly.

## Success

The same resource artifacts are admitted by Halfcode 0.3 exact contracts, projected by Eidolon, executed through the standalone HolonTaskRuntimeService, and recovered by a fresh process without a Workflow instance or duplicate accepted effect.
