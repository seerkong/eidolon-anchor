# DEPA before: portable skill generation and recovered TUI follow-up

Date: 2026-10-22. Baseline: `765b1da`. Scope: module-level, standard depth;
bug fixes and regression coverage, without a new runtime architecture or mission lifecycle.
Reviewed with depa-expert DataTopology, Data/Effect/Actor dimensions and seven-point rubric.

## Evidence and findings

1. **GAP — platform-dependent derived bytes.**
   `cell/packages/ai-support/tools/generate-eidolon-system-skill-plan.ts:109` calls
   `planSkillCapsuleDistribution` on the original module directories. Compiler 0.3.2
   `dist/src-D-s6VQe9.js:180` reads mapped file bytes before digesting them. The supplied
   generated-file diff changes 96 lines, including base64, content/provenance and closure
   digests. A checkout's CRLF consequently becomes part of the distributed skill identity.
   Canonicalize text at the input boundary before assembly/planning; retain compiler
   ownership of provenance and all digest calculations. Do not patch a finished projection.
2. **GAP — undeclared external fixture dependency.**
   `terminal/packages/tui/tests/session-continue-follow-up.test.tsx:15` reads a private
   drive-qualified session. Lines 42–43 copy it instead of creating recovery material.
   Lines 105–110 retry through another submission path and swallow failures, making the
   exercised path ambiguous. Lines 116–122 print debugging instead of assertions.
   Use one current-format runtime-produced checkpoint and one explicit follow-up path.
3. **PASS — runtime-host path composition.**
   `tests/runtime-host/follow-up-turn-settles.test.ts:16–21` uses `os.tmpdir` and
   `path.join`; its prompts and assertions do not depend on newline conventions.
   Its cleanup starts after runtime creation, so setup failures can leak the fixture.
4. **Existing test drift.** `system_skill_split_plan.test.ts:62` expects compiler
   0.3.1 while the package and installed dependency are 0.3.2. Validate and align that
   existing assertion with the pinned dependency while running the required suite.

## DataTopology / authority inventory

| Node | Role / model | Owner and transitions | Relations / verdict |
| --- | --- | --- | --- |
| Source skills and module descriptors | current_authority / versioned_repository | repository edits | derives normalized staging input; clean |
| Temporary normalized module tree | derived input / disposable copy | generator IO boundary, create/remove | feeds compiler; must not write sources; planned correction |
| Distribution plan and generated TS | derived_observation / immutable compiler projection | compiler planner, generator write | content → provenance → capsule → closure digests; current portability GAP |
| Session checkpoint/index | recovery_material / versioned runtime format | real runtime persist/dispose | restores owner through assembly; external fixture GAP |
| Recovered actor/session | current_authority / runtime owner | runtime turn and model-control APIs | projects SDK/UI observations; clean boundary to preserve |
| Test frame and captured model calls | derived_observation / test observation | renderer and mock adapter | assertions only; no authority backwrite |

## Seven-point assessment and design constraints

- Runtime explicitness / Effect: partial in the original test (ambient home and private
  fixture); use explicit temp `globalRoot`, injected adapter, bounded waits and cleanup.
- Data: GAP at byte canonicalization and recovery fixture provenance; fix at input/owner boundaries.
- Processor: preserve the compiler and runtime APIs; normalization is a fixed pure transform.
- Actor: preserve turn/SDK ingress and await disposal before reopening the same session.
- Avoid overdesign / vendor primitives: stage modules because the compiler API has no
  content-read hook; do not duplicate its digest/provenance algorithm or snapshot schema.
- EventSourcedStateProfile: NOT_APPLICABLE to this change; checkpoint creation and
  recovery alone do not establish canonical event-log authority.
- ReactiveDataGraphProfile: NOT_APPLICABLE to the changed generator/test fixture logic;
  existing renderer/runtime graphs are consumed through public APIs and are not redesigned.

## Authorized verification and continuity checkpoint

Keep the supplied untracked test as the file to repair. Regenerate the supplied generated
modification from canonical inputs, compare to HEAD, run twice and check bytes. Add tests
for LF/CRLF/CR and binary preservation through the real planner. Run system-skill tests,
both follow-up tests (TUI three times), and compare package type diagnostics against HEAD.
Commit generator/config/tests, TUI fixture, and DEPA reports separately; no push.
Owner: current chat. CWD: repository root. No background jobs or external submissions.
Next safe action: record HEAD typecheck diagnostics, then implement canonical staging and
runtime-owned fixture setup. Runtime observation is local command completion; no remote
service readiness is required or claimed.
