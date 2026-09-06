import type { AIAgentCodeResourceProjection, CompiledAIAgentCodeExecution } from "ai-workflow-contract"
import { compileAgentContextPipeline, compileAgentMessageSource } from "ai-workflow-logic/agent-code-execution"
import { canonicalResourcePackageSourcePath, type ResourcePackageReadPort } from "halfcode-compiler.xnl/resource-core"
import standardContextSource from "./compat/standard-context.ts.txt" with { type: "text" }
import workspaceAgentsSource from "./compat/workspace-agents.ts.txt" with { type: "text" }
import { normalizeAgentContextFactPresentationRecipe } from "@cell/ai-core-logic/runtime/AgentContextFactPresentation"
import type { AgentContextFactPresentationRecipe } from "@cell/ai-core-contract/runtime/AgentContextFactPresentation"

/** ABI of the narrow host processors; frozen artifacts reject an incompatible host. */
export const EIDOLON_AGENT_CODE_ENVIRONMENT = Object.freeze({
  hostIdentity: "eidolon.agent-resource-runtime/v1",
  ambient: Object.freeze({}),
})

/** Optional preparation ABI; no mutable VM/history or workspace capability is exposed. */
export function prepareEidolonContextFactPresentation(code: CompiledAIAgentCodeExecution): AgentContextFactPresentationRecipe | undefined {
  const protocol = code.artifact.config.factPresentationProtocol
  if (protocol === undefined) return undefined
  if (protocol !== "eidolon.context-fact-presentation/v1") throw new Error("EIDOLON_CONTEXT_FACT_PRESENTATION_PROTOCOL_UNSUPPORTED")
  return normalizeAgentContextFactPresentationRecipe(code.execute(Object.freeze({}), Object.freeze({ kind: "describe-fact-presentation" })))
}

const STANDARD_STAGES = Object.freeze([
  "prompt-plan", "conversation-prelude", "provider-context-facts-at-history-anchors",
  "stable-message-prefix", "conversation-boundary-overlays", "provider-conversion",
])

/** Explicit migration adapter for the two historically shipped resource recipes. */
function legacyRecipe(code: Extract<AIAgentCodeResourceProjection, { mode: "legacy" }>) {
  const descriptor: unknown = JSON.parse(code.content)
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) throw new Error("EIDOLON_AGENT_LEGACY_DESCRIPTOR_INVALID")
  const value = descriptor as Record<string, unknown>
  const context = code.kind === "AgentContextPipeline"
  const expected = context ? "eidolon.standard-context-pipeline/v1" : "eidolon.workspace-agents/v1"
  if (value.implementation !== expected) throw new Error(context ? "EIDOLON_AGENT_CONTEXT_PIPELINE_IMPLEMENTATION_UNSUPPORTED" : "EIDOLON_AGENT_MESSAGE_SOURCE_IMPLEMENTATION_UNSUPPORTED")
  if (context && JSON.stringify(value.stages) !== JSON.stringify(STANDARD_STAGES)) throw new Error("EIDOLON_AGENT_LEGACY_STAGES_INVALID")
  if (Object.keys(value).some(key => !["implementation", ...(context ? ["stages"] : [])].includes(key))) throw new Error("EIDOLON_AGENT_LEGACY_DESCRIPTOR_INVALID")
  const module = context ? "./__compat__/standard-context.ts" : "./__compat__/workspace-agents.ts"
  return {
    binding: { packageName: "eidolon-builtin", module, moduleSpecifier: `eidolon-builtin/${module.slice(2)}`, exportName: context ? "buildContext" : "loadMessages" },
    config: Object.freeze({}),
    source: context ? standardContextSource : workspaceAgentsSource,
  }
}

/** Read-only bytes, usable by native compiler/loader without a physical workspace. */
export function createAgentCodeMemoryReadPort(files: Readonly<Record<string, string>>, encoding: "utf8" | "base64" = "utf8"): ResourcePackageReadPort {
  const entries = new Map(Object.entries(files).map(([key, value]) => {
    const bytes = encoding === "base64" ? Buffer.from(value, "base64") : new TextEncoder().encode(value)
    if (encoding === "base64" && Buffer.from(bytes).toString("base64") !== value) throw new Error("EIDOLON_AGENT_CODE_BYTES_INVALID")
    return [canonicalResourcePackageSourcePath(`/${key}`), bytes] as const
  }))
  const directories = new Set<string>(["/"])
  for (const key of entries.keys()) {
    const parts = key.split("/")
    for (let index = 2; index < parts.length; index++) directories.add(parts.slice(0, index).join("/"))
  }
  return Object.freeze({
    async stat(sourcePath: string) {
      const key = canonicalResourcePackageSourcePath(sourcePath)
      return entries.has(key) ? { kind: "file" as const } : directories.has(key) ? { kind: "directory" as const } : undefined
    },
    async readDirectory(sourcePath: string) {
      const key = canonicalResourcePackageSourcePath(sourcePath)
      if (!directories.has(key)) return undefined
      const prefix = key === "/" ? "/" : `${key}/`
      return [...directories, ...entries.keys()].filter(value => value.startsWith(prefix) && value !== key && !value.slice(prefix.length).includes("/"))
        .sort().map(value => ({ name: value.slice(prefix.length), kind: directories.has(value) ? "directory" as const : "file" as const }))
    },
    async readBytes(sourcePath: string) { return entries.get(canonicalResourcePackageSourcePath(sourcePath))?.slice() },
  })
}

export async function compileEidolonAgentCodeResource(
  runtime: { source: ResourcePackageReadPort; sourceRoot: string },
  code: AIAgentCodeResourceProjection,
): Promise<CompiledAIAgentCodeExecution> {
  const compiler = code.kind === "AgentContextPipeline" ? compileAgentContextPipeline : compileAgentMessageSource
  if (code.mode === "legacy") {
    const recipe = legacyRecipe(code)
    return compiler({
      source: createAgentCodeMemoryReadPort({ [recipe.binding.module.slice(2)]: recipe.source }),
      sourceRoot: "/", entryPath: `/${recipe.binding.module.slice(2)}`,
      environment: EIDOLON_AGENT_CODE_ENVIRONMENT,
      resolveLegacy: () => ({ binding: recipe.binding, config: recipe.config }),
    }, code)
  }
  return compiler({ ...runtime,
    entryPath: canonicalResourcePackageSourcePath(`${runtime.sourceRoot.replace(/\/$/, "")}/${code.binding.module.slice(2)}`),
    environment: EIDOLON_AGENT_CODE_ENVIRONMENT,
  }, code)
}
