# Create a fresh ResourcePackage session

Use this operation only when the workspace ResourcePackage does not yet exist. First load the exact Halfcode Resource DSL and Flow DSL references required by the requested resource kinds. The model then authors one complete valid ResourcePackage file set and calls `WorkflowCreateResourcePackageSession` once:

```json
{
  "session_id": "<optional-stable-session-id>",
  "files": [
    { "path": "manifest.xnl", "content": "<complete ResourcePackage manifest>" },
    { "path": "<catalog>/<resource>.xnl", "content": "<complete resource>" }
  ],
  "selected_resource_refs": ["resource://<exact-app-workflow-or-agent-id>"]
}
```

`files` is a bounded ordered list of 1–128 exact relative paths and UTF-8 text contents. It must contain a complete valid ResourcePackage, every referenced business resource and every referenced code file. The manifest declares non-empty `packageVersion` in `{}`; each resource root uses `envelopeVersion="halfcode.resource-envelope/v1" specVersion=1` header metadata. The native tool validates paths, materializes one recoverable `/base` and `/work` candidate through the existing `explicit-complete-package` store path, loads it through Halfcode, projects it through depa, and returns the same bounded selection shape used for an existing package. It does not synthesize KindDefinitions, infer resource kinds, choose App or workflow semantics, publish, create an instance, or start a run.

In the normal Effective VFS host, standard depa Kinds are supplied by the trusted installed contract package. Use `WorkflowGetAuthoringContext(stage="definition", kind="<exact Kind>")` to inspect the required schema. Do not copy standard KindDefinitions into each business package, invent fingerprints, or add a KindDefinition catalog when there are no custom definitions. For a physical host without trusted imports, supply exact installed definitions explicitly.

For custom Kinds, declare the KindDefinition catalog as `shape = "directory"`, `root = "vfs://./KindDefinitions/"`, `entry = "manifest.xnl"`. Each directory item is one KindDefinition authority; author one file per custom kind:

```text
KindDefinitions/MyCustomKind/manifest.xnl
```

Never combine several KindDefinitions in `KindDefinitions/manifest.xnl`: that path is not a directory-catalog entry and registers none of them. Every catalog kind must resolve to either a trusted imported definition or a matching custom definition before a business resource is loaded. A validation retry must resend the complete package file set, not only changed files.

Resolve every authored `vfs` reference from the correct authority. `vfs://./...` is relative to the XNL document containing the reference. If a workflow lives at `CtrlWorkflows/Summary/manifest.xnl`, then `vfs://./flow-code/index.ts#run` requires `CtrlWorkflows/Summary/flow-code/index.ts`. To reference a package-root file such as `flow-code/index.ts`, author `vfs://@/flow-code/index.ts#run`. Never assume `vfs://./` means the package root.

Do not use the legacy `WorkflowCreateBundle` surface. Do not create a placeholder package and repair it through repeated writes. If the exact complete file set cannot yet be authored, load the missing exact reference resource first; then make one structured create call. After success, use `WorkflowWorkspace(operation=patch)` only for later coherent revisions, and use `WorkflowPreparePublication` for canonical proof.
