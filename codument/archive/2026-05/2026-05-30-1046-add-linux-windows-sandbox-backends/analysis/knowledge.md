# Knowledge Context

## Source Notes
| Source | Summary | Relevance |
|--------|---------|-----------|
| Existing sandbox runtime implementation | Provides shared selection, writable roots, network access, sync/streaming Bash execution, and macOS Seatbelt delegation. | Target extension point for Linux and Windows backends. |
| Existing macOS Seatbelt backend | Builds a deny-by-default policy, protects metadata directories, conditionally allows network access, and wraps commands with a fixed platform executable. | Local pattern to preserve when adding backend modules. |
| Existing sandbox backend tests | Cover selection, writable roots, danger fallback, macOS command args, real macOS smoke tests, Bash delegation, and timeouts. | Test structure for adding Linux/Windows cases. |
| Codex Linux sandbox implementation | Uses bubblewrap by default, helper CLI arguments, seccomp/no-new-privs inner stage, network namespace isolation, WSL1 detection, and protected path handling. | Reference for Linux backend semantics and failure modes. |
| Codex Windows elevated sandbox implementation | Uses resolved permissions, sandbox user credentials, ACL preparation, capability SIDs, runner IPC, and environment normalization. | Reference for Windows backend semantics and setup requirements. |

## Codebase Knowledge
- `SandboxBackendName` currently includes `macos-seatbelt` and `unsandboxed`; new backends can extend this union without changing Bash tool call shape.
- `SandboxBackendSelection` already carries `sandboxMode`, `networkAccess`, `workDir`, `writableRoots`, and `platform`; Linux/Windows may need additional derived paths or setup status but should avoid leaking platform details into Bash.
- `resolveAdditionalWritableRoots` and workspace-access grant merging should be reused for every workspace-write backend.
- Sync execution is mostly a test path; production Bash uses streaming execution to avoid blocking the event loop.
- Backend tests can inject `platform`, `spawnSyncFn`, and spawned process mocks, which makes command construction testable on non-target platforms.

## Domain Knowledge
- Sandbox mode maps to three user-facing states: `read-only`, `workspace-write`, and `danger-full-access`.
- Network access maps to `enabled` or `disabled`; backend behavior must make unsupported denial explicit instead of silently allowing restricted network access.
- Linux bubblewrap semantics: read-only root by default, bind writable roots, remount protected subpaths read-only or mask them, isolate user/PID namespaces, and optionally isolate network namespace.
- Windows elevated semantics: sandbox identity, restricted token/capability SIDs, ACL grants/denies, sandbox setup/provisioning, runner IPC, and optional private desktop are separate concerns.

## Terms
| Term | Meaning |
|------|---------|
| Backend selection | Runtime decision that maps metadata and platform into the sandbox implementation used for a command. |
| Writable root | Directory that remains writable under `workspace-write` mode. |
| Protected metadata | Project metadata directories that must remain protected even under writable parents. |
| Bubblewrap | Linux namespace/mount wrapper used by Codex as the default filesystem sandbox layer. |
| Seccomp | Linux syscall filtering used after the filesystem namespace is established. |
| Landlock | Linux filesystem security mechanism used by Codex as a legacy fallback path. |
| Capability SID | Windows security identifier used to grant sandboxed processes read or write capabilities. |
| Elevated setup | Windows setup flow that provisions sandbox users, ACLs, helper binaries, and runner access. |
