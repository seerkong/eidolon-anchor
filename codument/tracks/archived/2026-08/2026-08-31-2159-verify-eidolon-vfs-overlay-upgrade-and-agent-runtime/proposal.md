# Verify Effective VFS upgrades and the installed Agent runtime

## Goal

Close the product loop after the Effective VFS cut-over: prove overlay replay and conflict behavior, frozen recovery, source/compiled parity, and ordinary/Ctrl/Data use of the embedded Halfcode Coding Agent.

## Scope

- Add B1→B2 replay and fail-closed conflict tests without introducing a second VFS authority.
- Run the real terminal compile path with its BunFS asset and local installation.
- Exercise ordinary, AI Ctrl Workflow and AI Data Workflow Agent resolution/recovery from the formal embedded resource.
- Record provider-prefix/cache observations where a configured provider is available; do not weaken provider semantics to make the matrix pass.

## Non-goals

- Publishing unpublished XNL/Halfcode packages to npm without explicit authorization.
- Repairing the concurrently owned provider-context transition implementation.
