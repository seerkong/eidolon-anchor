# Pin proposition cell executables

## Context

The first full Codument proposition matrix exposed a provenance race: an independent build replaced the installed Eidolon target between two invocations in the same cell. The harness recorded a digest before execution but continued launching a mutable path, so the receipt could not prove which bytes produced the result.

## Goals

- Freeze the runnable Eidolon closure (main binary plus adjacent native sidecars) and Codument bytes once before a matrix executes its first cell.
- Use those exact bytes for every mode, scenario, and nested invocation in the run.
- Make receipt executable digests identify the bytes actually executed.
- Persist the first executable epoch selected by a run id and reuse it across restart/resume.
- Fail before completed-receipt persistence if the integrity gate observes a changed or missing snapshot.
- Preserve existing single-cell runner behavior and receipt compatibility.

## Non-goals

- Reproducible compilation or supply-chain attestation beyond the local run.
- Provider, Workflow, proposition, or verifier semantic changes.
- Accepting or repairing the interrupted `full-final-20260828-r1` evidence.
- Building a general artifact repository.

## Proposed change

Add a run-scoped content-addressed snapshot effect and first-writer binding manifest to organ-support. The root matrix runner binds Codument plus the complete runnable Eidolon closure before planning any cell and passes only the frozen paths downstream. Re-entering the same run id reuses the manifest's epoch rather than selecting current source bytes. Live receipt persistence rehashes the frozen files and sidecar tree and rejects observed drift. Regression tests cover mutable source/sidecar replacement, restart/resume, unsafe run identifiers, and detected snapshot tampering. After validation, rebuild and locally install Eidolon, then restart the affected matrix under a new run id.
