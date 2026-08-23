# Create a fresh ResourcePackage session

Use this operation only when the workspace ResourcePackage does not yet exist. First load the exact Halfcode Resource DSL and Flow DSL references required by the requested resource kinds. The model then authors one complete valid ResourcePackage file set and calls `WorkflowCreateResourcePackageSession` once:

```json
{
  "session_id": "<optional-stable-session-id>",
  "files": [
    { "path": "manifest.xnl", "content": "<complete ResourcePackage manifest>" },
    { "path": "KindDefinitions/<Kind>/manifest.xnl", "content": "<complete KindDefinition>" },
    { "path": "<catalog>/<resource>.xnl", "content": "<complete resource>" }
  ],
  "selected_resource_refs": ["resource://<exact-app-workflow-or-agent-id>"]
}
```

`files` is a bounded ordered list of 1–128 exact relative paths and UTF-8 text contents. It must already contain a complete valid ResourcePackage, every required KindDefinition, every referenced resource and every referenced code file. The native tool validates paths, materializes one recoverable `/base` and `/work` candidate through the existing `explicit-complete-package` store path, loads it through Halfcode, projects it through depa, and returns the same bounded selection shape used for an existing package. It does not synthesize KindDefinitions, infer resource kinds, choose App or workflow semantics, publish, create an instance, or start a run.

When `manifest.xnl` declares the KindDefinition catalog as `shape = "directory"`, `root = "vfs://./KindDefinitions/"`, `entry = "manifest.xnl"`, each directory item is one KindDefinition authority. Author one file per kind:

```text
KindDefinitions/AIWorkflowAppBundle/manifest.xnl
KindDefinitions/AICtrlWorkflow/manifest.xnl
KindDefinitions/AIDataWorkflow/manifest.xnl
KindDefinitions/AIAgentDefinition/manifest.xnl
...
```

Never combine several KindDefinitions in `KindDefinitions/manifest.xnl`: that path is not a directory-catalog entry and registers none of them. Every catalog kind named by the package manifest must have its own matching KindDefinition entry before any business resource is loaded. A validation retry must resend the complete package file set, not only the files changed since the previous attempt.

Resolve every authored `vfs` reference from the correct authority. `vfs://./...` is relative to the XNL document containing the reference. If a workflow lives at `CtrlWorkflows/Summary/manifest.xnl`, then `vfs://./flow-code/index.ts#run` requires `CtrlWorkflows/Summary/flow-code/index.ts`. To reference a package-root file such as `flow-code/index.ts`, author `vfs://@/flow-code/index.ts#run`. Never assume `vfs://./` means the package root.

Do not use the legacy `WorkflowCreateBundle` surface. Do not create a placeholder package and repair it through repeated writes. If the exact complete file set cannot yet be authored, load the missing exact reference resource first; then make one structured create call. After success, use `WorkflowWorkspace(operation=patch)` only for later coherent revisions, and use `WorkflowPreparePublication` for canonical proof.
