import path from "node:path"

import type {
  AiWorkflowForm,
  AIWorkflowDefinitionBinding,
} from "@cell/ai-workflow-contract"
import { hashWorkflowSources, type WorkflowAuthoringWorkspace } from "../authoring"
import { WorkflowResourceLoader } from "../resources"
import type { WorkflowDefinitionRevision } from "./WorkflowLifecycleFacts"

export type ResolvedWorkflowDefinition = {
  workflowRef: string
  manifestPath: string
  bundlePath: string
  baseUri: string
  sources: Record<string, string>
  binding: AIWorkflowDefinitionBinding
}

function vfsManifestPath(ref: string): string | undefined {
  if (!ref.startsWith("vfs://./")) return undefined
  const relative = ref.slice("vfs://./".length).replace(/^workflows\//, "")
  return relative.endsWith(".xnl") ? relative : `${relative.replace(/\/$/, "")}/manifest.xnl`
}

export class WorkflowDefinitionRepository {
  constructor(
    private readonly workspace: WorkflowAuthoringWorkspace,
    private readonly loader = new WorkflowResourceLoader(),
  ) {}

  private async loadManifest(manifestPath: string): Promise<ResolvedWorkflowDefinition | undefined> {
    let manifest: string
    try {
      manifest = await this.workspace.read(manifestPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
    const bundlePath = path.posix.dirname(manifestPath)
    const baseUri = path.join(this.workspace.store.rootPath, ...bundlePath.split("/"))
    const sources = { "manifest.xnl": manifest }
    const loaded = this.loader.load({ sources, baseUri })
    if (!loaded.binding) {
      const details = loaded.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; ")
      throw new Error(`Workflow manifest ${manifestPath} is invalid${details ? `: ${details}` : ""}`)
    }
    return {
      workflowRef: `resource://${loaded.binding.definition.fqn}`,
      manifestPath,
      bundlePath,
      baseUri,
      sources,
      binding: loaded.binding,
    }
  }

  async resolve(ref: string, expectedForm?: AiWorkflowForm): Promise<ResolvedWorkflowDefinition> {
    const logicalRef = ref.trim()
    let resolved: ResolvedWorkflowDefinition | undefined
    const directPath = vfsManifestPath(logicalRef)
    if (directPath) {
      resolved = await this.loadManifest(directPath)
    } else if (logicalRef.startsWith("resource://")) {
      const fqn = logicalRef.slice("resource://".length)
      const manifests = (await this.workspace.tree())
        .filter((file) => file.endsWith("/manifest.xnl") || file === "manifest.xnl")
      for (const manifestPath of manifests) {
        const candidate = await this.loadManifest(manifestPath)
        if (candidate?.binding.definition.fqn === fqn) {
          resolved = candidate
          break
        }
      }
    } else {
      throw new Error(`Unsupported workflow definition ref: ${logicalRef}`)
    }

    if (!resolved) throw new Error(`Workflow definition not found: ${logicalRef}`)
    if (expectedForm && resolved.binding.kind !== expectedForm) {
      throw new Error(`Workflow ${logicalRef} is ${resolved.binding.kind}, expected ${expectedForm}`)
    }
    return { ...resolved, workflowRef: logicalRef.startsWith("resource://") ? logicalRef : resolved.workflowRef }
  }

  async listResourceRefs(): Promise<string[]> {
    const manifests = (await this.workspace.tree())
      .filter((file) => file.endsWith("/manifest.xnl") || file === "manifest.xnl")
    const refs: string[] = []
    for (const manifestPath of manifests) {
      const definition = await this.loadManifest(manifestPath)
      if (definition) refs.push(definition.workflowRef)
    }
    return [...new Set(refs)].sort()
  }

  async capture(ref: string): Promise<WorkflowDefinitionRevision> {
    const resolved = await this.resolve(ref)
    const prefix = resolved.bundlePath === "." ? "" : `${resolved.bundlePath}/`
    const filePaths = (await this.workspace.tree(resolved.bundlePath === "." ? undefined : resolved.bundlePath))
      .filter((file) => !file.includes("/.authoring/") && !file.endsWith("/.authoring"))
    const files: Record<string, string> = {}
    for (const filePath of filePaths) {
      const relative = prefix && filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath
      files[relative] = await this.workspace.read(filePath)
    }
    if (!files["manifest.xnl"]) throw new Error(`Workflow bundle ${resolved.bundlePath} has no manifest.xnl`)
    const revision = hashWorkflowSources(Object.entries(files).map(([filePath, content]) => ({
      path: filePath,
      content,
    })))
    return {
      revision,
      workflowRef: resolved.workflowRef,
      fqn: resolved.binding.definition.fqn,
      form: resolved.binding.kind,
      sourceBundlePath: resolved.bundlePath,
      files,
      createdAt: Date.now(),
    }
  }

  captureSources(input: {
    files: readonly { path: string; content: string }[]
    form: AiWorkflowForm
    sourceBundlePath: string
  }): WorkflowDefinitionRevision {
    const files = Object.fromEntries(input.files.map((file) => [file.path, file.content]))
    const manifest = files["manifest.xnl"]
    if (!manifest) throw new Error(`Workflow source ${input.sourceBundlePath} has no manifest.xnl`)
    const loaded = this.loader.load({ form: input.form, sources: { "manifest.xnl": manifest } })
    if (!loaded.binding) {
      const details = loaded.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; ")
      throw new Error(`Workflow source ${input.sourceBundlePath} is invalid${details ? `: ${details}` : ""}`)
    }
    return {
      revision: hashWorkflowSources(input.files),
      workflowRef: `resource://${loaded.binding.definition.fqn}`,
      fqn: loaded.binding.definition.fqn,
      form: loaded.binding.kind,
      sourceBundlePath: input.sourceBundlePath,
      files,
      createdAt: Date.now(),
    }
  }

  resolveFrozen(snapshot: WorkflowDefinitionRevision, bundleRoot: string): ResolvedWorkflowDefinition {
    const loaded = this.loader.load({
      form: snapshot.form,
      sources: { "manifest.xnl": snapshot.files["manifest.xnl"]! },
      baseUri: bundleRoot,
    })
    if (!loaded.binding) {
      const details = loaded.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; ")
      throw new Error(`Frozen workflow revision ${snapshot.revision} is invalid${details ? `: ${details}` : ""}`)
    }
    if (loaded.binding.definition.fqn !== snapshot.fqn || loaded.binding.kind !== snapshot.form) {
      throw new Error(`Frozen workflow revision identity mismatch: ${snapshot.revision}`)
    }
    return {
      workflowRef: snapshot.workflowRef,
      manifestPath: "manifest.xnl",
      bundlePath: bundleRoot,
      baseUri: bundleRoot,
      sources: snapshot.files,
      binding: loaded.binding,
    }
  }
}
