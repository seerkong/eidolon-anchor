# Findings

## Found Facts
- Current project has an active spec named `sandbox-backend-permission-runtime`.
- The archived track `add-sandbox-backend-permission-runtime` introduced the platform-neutral sandbox runtime and macOS Seatbelt backend, and explicitly left Linux and Windows backend support out of scope.
- Current `SandboxBackendRuntime` selects `macos-seatbelt` only for `platform === "darwin"` and otherwise falls back to `unsandboxed` unless `sandbox_mode` is `danger-full-access`.
- Bash execution already delegates through `executeSandboxedBashCommand` / `executeStreamingSandboxedBashCommand` after local permission authorization.
- Current macOS backend keeps the extension mechanism small: backend selection, backend-specific command construction, command execution, and focused tests live behind the shared runtime surface.
- Codex Linux sandbox uses a helper executable interface around bubblewrap by default, with seccomp and `PR_SET_NO_NEW_PRIVS` applied in an inner stage. It preserves read-only-by-default filesystem semantics, explicit writable roots, protected metadata paths, and network namespace isolation.
- Codex Linux also has a legacy Landlock path, but the default path is bubblewrap plus seccomp. WSL1 cannot support the required bubblewrap user namespaces.
- Codex Windows elevated sandbox resolves permission profiles into filesystem/network permissions, prepares sandbox users and ACLs, creates capability SIDs for read-only or workspace-write execution, and runs commands through an elevated runner IPC path.
- Windows sandbox network denial is environment/Windows-filter driven in Codex, while filesystem containment depends on ACLs, restricted tokens, capability SIDs, and pre-provisioned sandbox users.

## Constraints
- `danger-full-access` must remain explicitly unsandboxed.
- Local permission authorization must continue to run before sandbox backend execution.
- macOS behavior must not regress while Linux and Windows backend names are added.
- Generated Codument artifacts should be self-contained and should not depend on external documentation.
- Linux and Windows behavior need testable command builder/selection semantics even when the current development machine is not Linux or Windows.
- True Linux/Windows execution smoke tests may need to be platform-gated.

## Open Questions
- Whether Linux implementation should shell out to a bundled helper binary, system `bwrap`, or a minimal local helper maintained inside this project.
- Whether Windows support should implement the full elevated user/ACL setup flow in this iteration or start with a restricted-token command builder plus setup detection.
- Whether network restriction on Windows should be implemented immediately through platform filters or initially surface as unsupported/degraded when filtering is unavailable.

## Conclusions
- This track should modify the existing sandbox backend runtime capability rather than create a parallel execution path.
- The plan should require research-aligned adapters for `linux-bwrap` and `windows-elevated` / restricted-token execution behind the existing backend selection and Bash integration surface.
- Because the change is security-sensitive and cross-platform, the track needs `design.md`, `decisions.md`, and final gap-loop validation.

## Implementation Evidence
- Added `LinuxSandbox.ts` with a bubblewrap command builder that uses read-only root binding, explicit writable roots, protected metadata masking/read-only remounts, cwd selection, and `--unshare-net` when network access is disabled.
- Added `WindowsSandbox.ts` with an elevated runner adapter contract that passes cwd, mode, network policy, writable roots, and protected metadata deny-write paths to `eidolon-windows-sandbox-runner`.
- Extended `SandboxBackendRuntime.ts` so `read-only` and `workspace-write` select `linux-bwrap` on Linux and `windows-elevated` on Windows, while `danger-full-access` remains explicitly `unsandboxed`.
- Refactored sync and streaming Bash execution through the same spawn spec dispatcher so Linux and Windows do not silently fall back to an unsandboxed shell.
- Verified on darwin with focused tests: sandbox backend runtime test file passed 20 tests / 80 assertions; local permission exec mode test file passed 4 tests / 10 assertions.
- Linux/Windows real smoke tests were not runnable on this darwin host; the implemented coverage is non-target selection, planner, and injected execution routing.
