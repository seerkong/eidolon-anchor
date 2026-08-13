# L3 · AI workflow resource tree

AI workflow resources use the same XNL bundle discipline as the existing flow DSL: XNL definition is the authoring truth, runtime state is separate, and physical file layout is not business identity.

This page defines the shared app bundle resource system used by AI workflow profiles. Profile-specific nodes for AI Ctrl Workflow and AI Data Workflow are defined separately.

## Resource tree shape

An AI workflow app bundle is an FS-native XNL resource tree:

```text
support-agent/
  manifest.xnl
  resources/
    catalog.xnl
  workflows/
    support-agent.workflow.xnl
    evidence-dag.workflow.xnl
  materials/
    ports.xnl
  flow-code/
    effects.ts
```

`manifest.xnl` is the bundle entry. It declares the app bundle identity and imports or contains a catalog. Directory recursion alone does not compose resources; a catalog entry is the explicit composition boundary.

```xnl
<AIWorkflowAppBundle #depa.flows.demo.SupportAgent apiVersion="depa.flows/v1" version="0.1.0" (
  <ResourceCatalog #main [
    <ResourceEntry #agent-workflow {
      kind = "AICtrlWorkflow"
      fqn = "depa.flows.demo.SupportAgent.Workflow"
      ref = "resource://depa.flows.demo.SupportAgent.Workflow"
      source = "vfs://./workflows/support-agent.workflow.xnl"
    }>
    <ResourceEntry #evidence-dag {
      kind = "AIDataWorkflow"
      fqn = "depa.flows.demo.SupportAgent.EvidenceDag"
      ref = "resource://depa.flows.demo.SupportAgent.EvidenceDag"
      source = "vfs://./workflows/evidence-dag.workflow.xnl"
    }>
    <ResourceEntry #material-ports {
      kind = "MaterialPort"
      fqn = "depa.flows.demo.SupportAgent.MaterialPorts"
      ref = "resource://depa.flows.demo.SupportAgent.MaterialPorts"
      source = "vfs://./materials/ports.xnl"
    }>
  ]>
)>
```

## Identity rules

- Resource identity is declared by content `#id`, `fqn`, or `resource://` ref.
- File path and directory name may aid authoring, but they do not define business identity.
- Source shape is independent from resource kind: a resource can be inline, in `manifest.xnl`, or externalized to a same-kind `.xnl` file.
- Catalogs scan only declared entries. They do not recursively absorb every file under a directory.

## Allowed refs

AI workflow resources use logical refs only:

| scheme | purpose | example |
|---|---|---|
| `vfs://` | bundle/workspace file or code export | `vfs://./flow-code/effects.ts#review` |
| `resource://` | declared resource identity | `resource://depa.flows.demo.SupportAgent.Workflow` |
| `config://` | config entry or sub-path | `config://#model/default` |
| `secret://` | secret handle, never secret value | `secret://ai-provider/api-key` |

Rejected forms:

- host absolute paths;
- naked relative paths such as `./workflow.xnl`;
- `..` path escape or encoded dot escape;
- backslash paths;
- unregistered URI schemes.

## Runtime state roots

Runtime roots such as `.eidolon` are provided by the wrapper at execution time. They are not authoring identity, and XNL app bundle resources must not derive them from process cwd, environment variables, or hidden authoring directories.

## XNL-only authoring

AI workflow app bundle resources are XNL. XML is not a resource authoring surface for new AI workflow resources. XML may still exist in Codument control artifacts, but it is not part of the app bundle resource tree.
