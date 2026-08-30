import path from "node:path"
import { readFileSync } from "node:fs"
import type { DefinitionStepSourceReadPort } from "flow-step-space-contract"

import type {
  AiWorkflowForm,
  AIWorkflowDefinitionBinding,
} from "@cell/ai-workflow-contract"
import type {
  EidolonAppResourceRegistryAdapter,
  EidolonEffectiveResourceSource,
} from "../../resources"
import { hashWorkflowSources, type WorkflowAuthoringWorkspace } from "../authoring"
import { WorkflowResourceLoader } from "../resources"
import type {
  WorkflowDefinitionResourceReceipt,
  WorkflowDefinitionRevision,
} from "./WorkflowLifecycleFacts"

export type ResolvedWorkflowDefinition = {
  workflowRef: string
  manifestPath: string
  bundlePath: string
  baseUri: string
  sources: Record<string, string>
  binding: AIWorkflowDefinitionBinding
  resourceSource?: EidolonEffectiveResourceSource
  resourceReceipt?: WorkflowDefinitionResourceReceipt
}

function vfsManifestPath(ref: string): string | undefined {
  if (!ref.startsWith("vfs://./")) return undefined
  const relative = ref.slice("vfs://./".length).replace(/^workflows\//, "")
  return relative.endsWith(".xnl") ? relative : `${relative.replace(/\/$/, "")}/manifest.xnl`
}

function filesystemStepSources(baseUri: string): DefinitionStepSourceReadPort {
  const root = path.resolve(baseUri)
  return Object.freeze({
    readSource(ref: string): Uint8Array {
      if (!ref || path.isAbsolute(ref) || ref.includes("\0")) {
        throw new Error(`Workflow step source ref is invalid: ${ref}`)
      }
      const target = path.resolve(root, ref)
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
        throw new Error(`Workflow step source escapes its bundle root: ${ref}`)
      }
      return readFileSync(target)
    },
  })
}

export class WorkflowDefinitionRepository {
  constructor(
    private readonly workspace: WorkflowAuthoringWorkspace,
    private readonly loader = new WorkflowResourceLoader(),
    private readonly registry?: EidolonAppResourceRegistryAdapter,
  ) {}

  private async loadManifest(
    manifestPath: string,
    workflowRef: string,
  ): Promise<ResolvedWorkflowDefinition | undefined> {
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
    const loaded = this.loader.load({
      sources,
      baseUri,
      stepSources: filesystemStepSources(baseUri),
    })
    if (!loaded.binding) {
      const details = loaded.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; ")
      throw new Error(`Workflow manifest ${manifestPath} is invalid${details ? `: ${details}` : ""}`)
    }
    return {
      workflowRef,
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
      resolved = await this.loadManifest(directPath, logicalRef)
    } else if (logicalRef.startsWith("resource://")) {
      if (logicalRef !== ref || !this.registry) {
        throw new Error(`Workflow resource registry is not bound for ref: ${ref}`)
      }
      const resourceId = logicalRef.slice("resource://".length)
      if (!resourceId) throw new Error("Workflow resource ref must contain an exact identity")
      const resourceSource = await this.registry.readEffectiveSource(resourceId)
      if (resourceSource.resource.kind !== "AICtrlWorkflow" && resourceSource.resource.kind !== "AIDataWorkflow") {
        throw new Error(
          `Workflow ${logicalRef} has resource kind ${resourceSource.resource.kind}, expected AICtrlWorkflow or AIDataWorkflow`,
        )
      }
      const profile = await this.registry.loadEffectiveProfile(resourceSource, ({ sources, stepSources }) => (
        this.loader.load({
          form: resourceSource.resource.kind as AiWorkflowForm,
          sources,
          stepSources,
          baseUri: resourceSource.baseUri,
        })
      ))
      const sources: Record<string, string> = { ...profile.sources }
      const loaded = profile.result
      if (!loaded.binding) {
        const details = loaded.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; ")
        throw new Error(`Workflow resource ${logicalRef} is invalid${details ? `: ${details}` : ""}`)
      }
      if (loaded.binding.definition.fqn !== resourceId) {
        throw new Error(
          `Workflow resource identity mismatch: registry '${resourceId}', definition '${loaded.binding.definition.fqn}'`,
        )
      }
      for (const dependency of executableDependencies(loaded.binding)) {
        const content = dependency.scope === "package"
          ? await this.registry.readEffectivePackageDependencySource(resourceSource, dependency.sourcePath)
          : await this.registry.readEffectiveDependencySource(resourceSource, dependency.sourcePath)
        const existing = sources[dependency.frozenPath]
        if (existing !== undefined && existing !== content) {
          throw new Error(
            `Workflow executable refs resolve different authorities to frozen path '${dependency.frozenPath}'`,
          )
        }
        sources[dependency.frozenPath] = content
      }
      resolved = {
        workflowRef: logicalRef,
        manifestPath: resourceSource.logicalPath,
        bundlePath: path.posix.dirname(resourceSource.logicalPath),
        baseUri: resourceSource.baseUri,
        sources,
        binding: loaded.binding,
        resourceSource,
        resourceReceipt: resourceReceipt(resourceSource, loaded.binding.kind),
      }
    } else {
      throw new Error(`Unsupported workflow definition ref: ${logicalRef}`)
    }

    if (!resolved) throw new Error(`Workflow definition not found: ${logicalRef}`)
    if (expectedForm && resolved.binding.kind !== expectedForm) {
      throw new Error(`Workflow ${logicalRef} is ${resolved.binding.kind}, expected ${expectedForm}`)
    }
    return resolved
  }

  async listResourceRefs(): Promise<string[]> {
    if (!this.registry) return []
    const snapshot = await this.registry.snapshot()
    return [
      ...(snapshot.registry.byKind.get("AICtrlWorkflow") ?? []),
      ...(snapshot.registry.byKind.get("AIDataWorkflow") ?? []),
    ]
      .map((resource) => `resource://${resource.resourceId}`)
      .sort(compareCodeUnits)
  }

  async capture(ref: string): Promise<WorkflowDefinitionRevision> {
    const resolved = await this.resolve(ref)
    if (resolved.resourceSource) {
      const files = { ...resolved.sources }
      const receipt = resourceReceipt(resolved.resourceSource, resolved.binding.kind)
      const revision = hashWorkflowSources([...Object.entries(files).map(([filePath, content]) => ({
        path: filePath,
        content,
      })), {
        path: "@resource-receipt",
        content: JSON.stringify(receipt),
      }])
      return {
        revision,
        workflowRef: resolved.workflowRef,
        fqn: resolved.binding.definition.fqn,
        form: resolved.binding.kind,
        sourceBundlePath: resolved.bundlePath,
        files,
        resourceReceipt: receipt,
        createdAt: Date.now(),
      }
    }
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
    workflowRef: string
  }): WorkflowDefinitionRevision {
    const files = Object.fromEntries(input.files.map((file) => [file.path, file.content]))
    const manifest = files["manifest.xnl"]
    if (!manifest) throw new Error(`Workflow source ${input.sourceBundlePath} has no manifest.xnl`)
    const loaded = this.loader.load({ form: input.form, sources: workflowProfileSources(files) })
    if (!loaded.binding) {
      const details = loaded.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; ")
      throw new Error(`Workflow source ${input.sourceBundlePath} is invalid${details ? `: ${details}` : ""}`)
    }
    return {
      revision: hashWorkflowSources(input.files),
      workflowRef: input.workflowRef,
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
      sources: workflowProfileSources(snapshot.files),
    })
    if (!loaded.binding) {
      const details = loaded.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; ")
      throw new Error(`Frozen workflow revision ${snapshot.revision} is invalid${details ? `: ${details}` : ""}`)
    }
    if (loaded.binding.definition.fqn !== snapshot.fqn || loaded.binding.kind !== snapshot.form) {
      throw new Error(`Frozen workflow revision identity mismatch: ${snapshot.revision}`)
    }
    const binding = {
      ...loaded.binding,
      definition: { ...loaded.binding.definition, baseUri: bundleRoot },
    } as AIWorkflowDefinitionBinding
    return {
      workflowRef: snapshot.workflowRef,
      manifestPath: "manifest.xnl",
      bundlePath: bundleRoot,
      baseUri: bundleRoot,
      sources: snapshot.files,
      binding,
      resourceReceipt: snapshot.resourceReceipt,
    }
  }
}

function resourceReceipt(
  source: EidolonEffectiveResourceSource,
  kind: AiWorkflowForm,
): WorkflowDefinitionResourceReceipt {
  return Object.freeze({
    schemaVersion: "eidolon.workflow-definition-resource-receipt/v1",
    resourceId: source.resource.resourceId,
    kind,
    packageId: source.packageId,
    layerId: source.layerId,
    logicalPath: source.logicalPath,
    compositionRevision: source.compositionRevision,
    registryRevision: source.registryRevision,
    authorityDigest: source.authorityDigest,
    contentDigest: source.contentDigest,
  })
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function workflowProfileSources(files: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).filter(([filePath]) => (
    filePath.endsWith(".xnl") && !filePath.startsWith(".agent-resources/")
  )))
}

type ExecutableDependency = {
  readonly scope: "resource" | "package"
  readonly sourcePath: string
  readonly frozenPath: string
}

function executableDependencies(binding: AIWorkflowDefinitionBinding): readonly ExecutableDependency[] {
  const refs: ExecutableDependency[] = []
  const add = (value: unknown, location: string): void => {
    if (value === undefined) return
    if (typeof value !== "string" || !value || value !== value.trim()) {
      throw new Error(`Workflow executable ref ${location} must be an exact non-empty string`)
    }
    const resourcePrefix = "vfs://./"
    const packagePrefix = "vfs://@/"
    const scope = value.startsWith(resourcePrefix)
      ? "resource" as const
      : value.startsWith(packagePrefix)
        ? "package" as const
        : undefined
    if (!scope) return
    const prefix = scope === "resource" ? resourcePrefix : packagePrefix
    const fragmentIndex = value.indexOf("#", prefix.length)
    if (fragmentIndex <= prefix.length || fragmentIndex === value.length - 1) {
      throw new Error(`Workflow executable ref ${location} must contain an exact file and export fragment`)
    }
    const sourcePath = value.slice(prefix.length, fragmentIndex)
    refs.push(Object.freeze({ scope, sourcePath, frozenPath: sourcePath }))
  }

  if (binding.kind === "AICtrlWorkflow") {
    const definition = binding.definition
    add(definition.flowContract?.input, "FlowContract.input")
    add(definition.flowContract?.output, "FlowContract.output")
    const visit = (node: (typeof definition.statements)[number]): void => {
      add(node?.attrs?.src, `${String(node?.id ?? node?.tag ?? "statement")}.src`)
      add(node?.attrs?.when, `${String(node?.id ?? node?.tag ?? "statement")}.when`)
      for (const child of node?.children ?? []) visit(child)
      for (const section of Object.values(node?.sections ?? {})) {
        visit(section)
      }
    }
    for (const statement of definition.statements ?? []) visit(statement)
  } else {
    const definition = binding.definition
    for (const node of definition.nodes ?? []) {
      add("src" in node ? node.src : undefined, `${String(node.id ?? node.tag ?? "node")}.src`)
      add("impl" in node ? node.impl : undefined, `${String(node.id ?? node.tag ?? "node")}.impl`)
    }
  }
  const byIdentity = new Map<string, ExecutableDependency>()
  for (const ref of refs) byIdentity.set(`${ref.scope}\u0000${ref.sourcePath}`, ref)
  return Object.freeze([...byIdentity.values()].sort((left, right) => (
    compareCodeUnits(left.frozenPath, right.frozenPath)
    || compareCodeUnits(left.scope, right.scope)
  )))
}

export function normalizeFrozenWorkflowCodeReference(reference: string): string {
  const prefix = "vfs://@/"
  return reference.startsWith(prefix)
    ? `vfs://./${reference.slice(prefix.length)}`
    : reference
}
