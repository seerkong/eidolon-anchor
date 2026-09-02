# Verification

## Verdict

PASS. Workflow composition now selects one mutually exclusive resource-authority mode.

## Effective VFS production shape

With production-shaped metadata containing an Effective VFS, an Effective-VFS authoring port, and legacy global/workspace layer coordinates:

- registry projection contains only `effective-vfs`;
- `WorkflowComponent.resourceLayers` is empty;
- `WorkflowComponent.resourcePackagePublisher` is absent;
- the Effective-VFS authoring port remains available;
- workflow-definition authoring under `.eidolon/workflows` remains available.

An explicitly injected physical publisher beside Effective VFS is rejected by construction.

## Legacy compatibility

When Effective VFS is absent, the physical-only ResourcePackage authoring/publication path remains unchanged. Its complete authoring, proof, publication, recovery and Ctrl/Data product suites pass.

## Evidence

- Focused final host matrix: 72 passed, 0 failed, 657 assertions.
- Physical-only compatibility slice: 45 passed, 0 failed, 515 assertions.
- Effective-VFS production-shape slice: 5 passed, 0 failed.
- TypeScript 5.9.3:
  - `cell/tsconfig.agent-halfcode-pipeline.json`: PASS
  - `cell/tsconfig.agent-resource-authoring.json`: PASS
- `codument validate isolate-workflow-resource-authoring-behind-effective-vfs --strict`: PASS.
- `git diff --check` on Track-owned files: PASS.

The separately owned provider-context transition conflict was not edited or used to weaken acceptance.
