# Track Implementation Gap Report - Round 1

Track: `add-linux-windows-sandbox-backends`
Scope: whole track
Round: 1
Status: `NO_GAP`
Date: 2026-05-30

## Reviewed Inputs
- `proposal.md`
- `spec.md`
- `design.md`
- `plan.xml`
- `decisions.md`
- `analysis/findings.md`
- `analysis/knowledge.md`
- Existing reports: none present before this round.

## Implementation Reviewed
- `cell/packages/ai-organ-logic/src/sandbox/SandboxBackendRuntime.ts`
- `cell/packages/ai-organ-logic/src/sandbox/LinuxSandbox.ts`
- `cell/packages/ai-organ-logic/src/sandbox/WindowsSandbox.ts`
- `cell/packages/ai-organ-logic/src/sandbox/MacOsSeatbeltSandbox.ts`
- `cell/packages/ai-organ-logic/src/sandbox/index.ts`
- `cell/packages/ai-organ-logic/src/composer/AIAgent/tools/Bash/Logic.ts`
- `cell/packages/ai-organ-logic/src/composer/AIAgent/tools/RunDetachedBash/Logic.ts`
- `cell/packages/ai-organ-logic/tests/AIAgent/sandbox_backend_runtime.test.ts`
- `cell/packages/ai-organ-logic/tests/AIAgent/local_permission_exec_mode.test.ts`

## Current Diff Reviewed
- Modified sandbox runtime extends backend names to `linux-bwrap` and `windows-elevated`, keeps `danger-full-access` on `unsandboxed`, and returns `unsupported` for unknown restricted platforms.
- Added Linux bubblewrap command planner with read-only root binding, workspace writable roots, protected metadata handling, cwd selection, and `--unshare-net` for disabled network.
- Added Windows elevated runner command planner with cwd, mode, network, writable-root, and protected metadata deny-write arguments.
- Shared sync and streaming Bash execution now build a backend spawn spec instead of falling back to unsandboxed for non-macOS restricted modes.
- Bash local permission authorization still runs before backend selection and execution.
- Detached Bash uses the same streaming sandbox runtime.
- Tests cover selection, Linux/Windows command planners, macOS behavior, sync delegation, timeout behavior, local permission exec modes, and available macOS smoke behavior.

## Verification
Command:

```bash
bun test cell/packages/ai-organ-logic/tests/AIAgent/sandbox_backend_runtime.test.ts cell/packages/ai-organ-logic/tests/AIAgent/local_permission_exec_mode.test.ts
```

Result:
- Passed: 24 tests, 90 assertions.
- Host: darwin.
- Linux/Windows real smoke tests were not runnable on this host; this matches the plan evidence and current design decision to cover non-target selection/planner/delegation with unit tests and gate real platform smoke tests by platform/dependency availability.

## Gap Assessment
No fixable gap was found against the approved track scope and recorded decisions.

The implementation satisfies the track's scoped contract:
- Restricted Linux and Windows modes no longer select or execute the normal unsandboxed path.
- Missing Linux `bwrap` or Windows runner dependencies fail through the attempted backend executable path rather than silently downgrading.
- Network-disabled Linux planning maps to `--unshare-net`; Windows network policy is passed to the runner contract.
- Writable roots are normalized and passed only for `workspace-write`.
- Protected metadata handling is represented in Linux and Windows planners.
- macOS behavior remains covered and unchanged by focused tests.
- Public Bash tool input/output shape remains unchanged.

The deeper native implementation work for Linux helper/seccomp packaging and full Windows elevated setup/runner provisioning is not a gap in this round because `decisions.md` explicitly scopes this track to a system `bwrap` adapter and a setup-aware Windows runner contract, with helper packaging and full elevated setup left outside the current implementation depth.

## Result
`NO_GAP`
