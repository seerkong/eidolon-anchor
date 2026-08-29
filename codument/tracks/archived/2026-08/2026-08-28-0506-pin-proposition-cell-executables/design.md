# Design: pin proposition cell executables

## Executable epoch

Before matrix planning begins, read each configured executable once. For Eidolon, also inventory the adjacent `node_modules` sidecar tree required relative to `process.execPath`. Calculate SHA-256 over the main bytes and a deterministic path/content digest over the sidecar tree, then materialize a runnable closure at:

`<execution-root>/.executable-snapshots/<run-id>/eidolon-runtime-<closure-digest>/eidolon-<binary-digest>.bin`

with the sidecar copied to `eidolon-runtime-<closure-digest>/node_modules/`. Codument remains `<run-root>/codument-<digest>.bin`.

The run id must be a safe single path segment. Snapshot creation is exclusive; an existing content-addressed file is reused only after its digest is verified. Snapshot files are executable and never overwritten.

The directory also contains `binding.json`, written with create-only semantics. It records schema version, both main-file digests, the Eidolon closure digest, and content-addressed paths. This manifest is the first-writer authority for the run id. On restart/resume, an existing binding is loaded and verified without consulting current mutable source bytes. Changed source or sidecar bytes are selected only under a new run id. A missing, malformed, escaping, or digest-inconsistent binding fails closed.

The root runner replaces its configured mutable paths with the two snapshot paths once. Every subsequently planned cell, runtime process, verifier call, and nested agent invocation receives those frozen bindings.

## Integrity gate

`runCodumentPropositionLiveCell` computes receipt digests from the bound snapshot files. Its receipt store is wrapped with an integrity assertion that rehashes both files immediately before delegating persistence. A missing file or drift observed by that gate rejects the cell, leaving diagnostics but no completed receipt.

The existing receipt digest fields remain authoritative and require no schema migration. Direct single-cell callers retain their current API and gain the same final integrity check even when they do not use the matrix snapshot helper.

## Tests

- Snapshot source executables and a synthetic sidecar, replace their mutable source/sidecar bytes, and prove the runnable snapshot paths and digests remain unchanged.
- Re-enter the same run id after source replacement and prove it reuses the first binding; a new run id may select the new bytes.
- Reject unsafe run ids and detect snapshot mutation or manifest inconsistency.
- Prove the matrix runner creates snapshots before cell execution and passes their paths to all cells.
- Prove receipt persistence fails when the bound executable changes after preflight.

## Decisions and trade-offs

- Run scope is required: cell-scoped snapshots would still permit different executable epochs between ordinary, Ctrl, and Data evidence.
- The runtime closure, rather than the Mach-O alone, is the executable unit because the binary resolves native code relative to its own path.
- Content addressing makes reuse deterministic and makes accidental overwrite visible.
- Same-user mutation cannot be prevented absolutely and a narrow rehash/write TOCTOU remains; this is an integrity/provenance boundary for ordinary local builds, not a hostile-user security boundary.
- The invalid full run is preserved for diagnosis but excluded from comparison and Mission completion.

## Rollout

Implement the support effect and RED regressions, wire the root runner and persistence gate, run focused and locked-TypeScript validation, rebuild and locally install Eidolon, then restart `modeling-blog/ordinary` and the remaining full matrix with a new run id.
