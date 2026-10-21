# DEPA after: portable skill generation and recovered TUI follow-up

Date: 2026-10-22. Baseline: `765b1da`. Same module-level scope as `depa-before.md`.
Post-change review reapplies depa-expert's authority, lifecycle, effect and seven-point
criteria to the final implementation and observed results. Verdict: the two scoped
portability gaps are resolved; no new authority conflict or projection backwrite found.

## Changes and evidence

- `cell/packages/ai-support/tools/lf-system-skill-plan.ts:14–23` is a pure byte
  transform: supported UTF-8 text formats canonicalize CRLF/CR to LF, preserving BOMs.
  Other extensions, invalid UTF-8 and NUL-containing material retain exact bytes.
  The current module source formats are Markdown, XNL, EJS, YAML and JSON. Future
  additional text formats must be explicitly added to this policy and `.gitattributes`.
- `lf-system-skill-plan.ts:26–45` copies modules into an isolated temporary directory,
  normalizes before assembly/template rendering and compiler planning, then removes
  staging in `finally`. Original source/package directories are never written.
  The compiler still computes content base64, content digests, generated provenance,
  capsule digests and closure digest. No second digest/provenance implementation exists.
- `generate-eidolon-system-skill-plan.ts:82–98` compares the mirrored KindDefinition
  using canonical text bytes and invokes the normalized planner. `.gitattributes`
  enforces `text eol=lf` for the source text formats and generated module. Attribute
  queries confirmed LF for the root manifest, a nested operation and generated output.
- `system_skill_plan_line_endings.test.ts:11–58` checks all three newline forms,
  UTF-8/BOM preservation, invalid text/binary bypass, actual compiler digests/base64,
  full projection equality including provenance/closure, and unchanged source files.
  A synthetic binary asset is copied through the actual planner without modification.
- `system_skill_split_plan.test.ts:52` now asserts the already-pinned compiler 0.3.2.
  This repairs stale coverage; no dependency or lockfile change is introduced.
- `terminal/packages/tui/tests/session-continue-follow-up.test.tsx:43–108` creates
  a temp workspace and isolated provider authority, injects an in-process provider,
  runs a seed turn through the real TUI runtime bridge, awaits disposal, and reads
  the resulting manifest/index. The actual current format is manifest `version: 4`,
  actor index `schemaVersion: 4`, `kind: "actors_by_key"` with `entries`.
- The test at lines 110–145 reopens through the real local SDK/UI, waits until the
  seed reply is rendered, sends exactly one SDK follow-up and asserts exactly one
  model call containing both the recovered prompt and follow-up. It waits for
  `CONTINUED-OK` while rejecting English/Chinese history-change banners in every
  sampled frame. No debug output, copied private session, hardcoded drive, path
  separator, newline split, swallowed prompt failure or fallback submission remains.
- Test cleanup at lines 30–40 and 142–145 destroys the renderer, disposes runtime/SDK,
  restores both home variables and the adapter factory, and removes owned temp data.
- `tests/runtime-host/follow-up-turn-settles.test.ts:16–57` was scanned and left
  unchanged: temp roots use `os.tmpdir`/`path.join`; no drive, separator or newline
  assumption was found. The before report's optional setup-failure cleanup improvement
  is outside the requested portability repair and does not block the passing test.

## DataTopology and DEPA post-review

| Node | Role / model | Owner / transition and writes | Relation / verdict |
| --- | --- | --- | --- |
| Source skill modules | current_authority / versioned_repository | repository edits only | derives staging input; clean |
| LF staging tree | derived input / disposable filesystem | generator copy/normalize/remove | feeds compiler; never writes source; clean |
| Immutable distribution plan / generated TS | derived_observation / compiler projection | compiler plan, generator output write | bytes → provenance → capsule → closure; clean |
| Seed session checkpoint and v4 index | recovery_material / runtime snapshot | runtime turn/persist/dispose | restores runtime owner on reopen; clean |
| Recovered session / actor | current_authority / runtime owner | public bridge and SDK turn/model commands | projects history and live events; clean |
| Captured model requests / rendered frames | derived_observation / test observation | adapter / renderer | assertions only; clean |

| Criterion | Finding |
| --- | --- |
| Runtime explicitness | PASS in scope: planner takes module descriptors and roots; test passes workspace/global authority/model and injected adapter. Ambient home/factory hooks are test-only, restored during cleanup and run in the package's isolated test process. |
| Data | PASS: compiler owns identities; runtime owns checkpoint schema; no fabricated snapshot/provenance and no derived backwrite. |
| Effect | PASS: normalization is pure; filesystem work belongs to generator orchestration; fixture IO and provider substitution are explicit test setup. |
| Processor | PASS: fixed normalization plus existing compiler/runtime APIs, with one awaited follow-up ingress and bounded readiness polling. |
| Actor | PASS: seed writer is disposed before recovery; follow-up uses public SDK/turn/model-control boundaries; no direct actor mutation. |
| Avoid overdesign | PASS: one build-time staging helper because compiler 0.3.2 lacks an injected read hook; no runtime framework, policy registry or compatibility loader added. |
| Vendor primitives | PASS: Node filesystem/path/temp APIs, Halfcode planner and actual runtime persistence/recovery are reused. |

EventSourcedStateProfile: NOT_APPLICABLE to the modified boundaries; no new event-log
authority/replay contract. ReactiveDataGraphProfile: NOT_APPLICABLE to modified fixture
and generator logic; existing UI graphs are observed through public renderer/SDK APIs.
These findings do not certify unrelated runtime graph internals.

## Verification evidence

Windows host, Bun 1.3.14. No macOS host was available; macOS execution is not claimed.

| Check | Observed result |
| --- | --- |
| `bun run generate:system-skills` in ai-support, twice consecutively | PASS: identical file SHA-256 `790fa26eeb6a6afa49c15430534bc2b99b1a10e19d4b55892750e0de5853508d` before and after both runs |
| `bun run generate:system-skills:check` | PASS |
| Generated TS vs `git show 765b1da:<path>` | PASS: byte-for-byte buffer equality and empty `git diff`; supplied CRLF-derived embedded payload changes were removed by regeneration |
| Plan closure | 113 files; `sha256:1079ae177d2a54184e7defb0433a9d8d7de238e927d47ab9d2f85e6f549ee13a` |
| `bun test tests/system_skill_plan_line_endings.test.ts tests/system_skill_split_plan.test.ts` in ai-support | 13 pass, 0 fail |
| `bun run test session-continue-follow-up.test.tsx` in tui, three separate invocations | 3/3 pass; test bodies approximately 5.34s / 5.32s / 4.84s |
| `bun test tests/runtime-host/follow-up-turn-settles.test.ts` from root | PASS before and after; final body approximately 3.84s |
| ai-support package type diagnostics against HEAD | 145 → 145 total, 15 → 15 attributed to the package; zero new diagnostics |
| tui package type diagnostics against HEAD | 68 → 68 total, 48 → 48 attributed to the package; zero new diagnostics, including the new fixture |
| Supplemental generator/helper/test typecheck with Bun declarations | No diagnostics in the generator, new helper or new test; existing split-plan line 106 has a readonly-array matcher mismatch unchanged from HEAD |
| Whitespace review | `git diff --check` passes |

Type comparison used the installed TypeScript compiler API, each package's parsed
`tsconfig.json`, `noEmit: true`, and complete pre-emit diagnostics keyed by file, line,
code and flattened message. The before pass supplied HEAD's generated source through
the compiler host and excluded the untracked TUI test, reproducing HEAD's roots without
resetting the working tree. Other tracked source files were still HEAD at that point.
Both before/after diagnostic arrays match exactly. These packages have existing errors;
this is a zero-new-errors result, not a clean whole-repository typecheck claim.

The full required system-skill run also included `system_skill_installer.test.ts`:
**19 pass, 7 fail**. The failures are in the untouched installer suite/runtime with the
generated plan now byte-identical to HEAD: one assertion expects `/authority/.eidolon`
although Windows resolves `E:\authority\.eidolon`; six require unavailable Windows
symlink privileges (`EPERM`). They cover ordinary symlinks, managed file, managed skill
root, global skill root, manifest, and reserved workspace system path. No privilege
or machine policy changes were made. The combined run was 32 pass / 7 fail.

## Completion / continuity checkpoint

Both scoped repairs and required verification are complete. No jobs or external requests
remain pending. The generated file has no content change to commit. Generator, attributes
and regression coverage are committed as `3b0f7c7`; the portable TUI regression is committed
as `015a1c9`. These two DEPA reports form the final documentation commit. No push is
authorized. Residual limitations are the existing installer/typecheck issues above and
lack of an actual macOS run.
