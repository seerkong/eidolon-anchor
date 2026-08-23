import type { StdInnerLogic } from "depa-processor"
import type { SkillInnerConfig, SkillInnerInput, SkillInnerOutput, SkillInnerRuntime } from "./InnerTypes"
import { SkillRegistry } from "@cell/ai-core-logic/runtime/SkillRegistry"
import { loadLocalTextResource } from "@cell/ai-organ-logic/runtime/LocalTextResourceLoader"
import { lstat, readFile, realpath } from "node:fs/promises"
import path from "path"
import { pathToFileURL } from "node:url"
import {
  loadSkillEntriesWithSystemAuthority,
  readInstalledSystemSkillResource,
  resolveEidolonGlobalRootFromOuterContext,
} from "@cell/ai-support/system-skill/SystemSkillInstaller"

const ROOT_RESOURCE = "SKILL.md"
const MAX_RESOURCE_BATCH = 8

function exactResourceIssue(resource: string): string | undefined {
  if (!resource) return "must be a non-empty relative path"
  if (resource.includes("\\")) return "must use forward slashes"
  if (resource.includes("\0")) return "must not contain a null byte"
  if (path.isAbsolute(resource) || path.posix.isAbsolute(resource)) return "must be relative"
  const segments = resource.split("/")
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return "must not contain empty, current, or parent segments"
  }
  if (path.posix.normalize(resource) !== resource) return "must be canonical"
  return undefined
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  )
}

async function readOrdinarySkillResource(skillDir: string, resource: string): Promise<{
  fullPath: string
  sourceText: string
  sizeBytes: number
}> {
  const rootStat = await lstat(skillDir)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Skill root must be a physical directory")
  }
  const realRoot = await realpath(skillDir)
  const fullPath = path.resolve(skillDir, ...resource.split("/"))
  if (!isWithin(path.resolve(skillDir), fullPath)) throw new Error("Skill resource escapes its lexical root")
  const resourceStat = await lstat(fullPath)
  if (!resourceStat.isFile() || resourceStat.isSymbolicLink()) {
    throw new Error("Skill resource must be a physical file")
  }
  const realFile = await realpath(fullPath)
  if (!isWithin(realRoot, realFile)) throw new Error("Skill resource escapes its real root")
  const bytes = await readFile(realFile)
  return {
    fullPath: realFile,
    sourceText: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    sizeBytes: bytes.byteLength,
  }
}

function requestedResources(input: SkillInnerInput): string[] | string {
  if (input.resource !== undefined && input.resources !== undefined) {
    return "Error: Skill resource and resources are mutually exclusive"
  }
  if (input.resources === undefined) {
    return [input.resource === undefined ? ROOT_RESOURCE : String(input.resource)]
  }
  if (!Array.isArray(input.resources) || input.resources.length < 1 || input.resources.length > MAX_RESOURCE_BATCH) {
    return `Error: Skill resources must contain between 1 and ${MAX_RESOURCE_BATCH} exact paths`
  }
  if (Object.getOwnPropertySymbols(input.resources).length > 0 || Object.keys(input.resources).length !== input.resources.length) {
    return "Error: Skill resources must be a dense plain data array"
  }
  const resources: string[] = []
  for (let index = 0; index < input.resources.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(input.resources, String(index))
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || typeof descriptor.value !== "string") {
      return "Error: Skill resources must be a dense plain data array of strings"
    }
    resources.push(descriptor.value)
  }
  if (new Set(resources).size !== resources.length) return "Error: Skill resources must be unique"
  return resources
}

export const skillCoreLogic: StdInnerLogic<SkillInnerRuntime, SkillInnerInput, SkillInnerConfig, SkillInnerOutput> = async (
  runtime,
  input,
  _config,
) => {
  const workDir = runtime.vm.outerCtx.workDir
  if (typeof workDir !== "string" || !workDir.trim()) {
    return "Error: workDir not configured"
  }

  SkillRegistry.reload(runtime.vm.registries.skillRegistry, loadSkillEntriesWithSystemAuthority({
    globalRoot: resolveEidolonGlobalRootFromOuterContext(runtime.vm.outerCtx),
    workspaceRoot: workDir,
  }))
  const skillName = String(input.skill ?? "")
  const skill = SkillRegistry.get(runtime.vm.registries.skillRegistry, skillName)
  if (!skill) {
    const available = SkillRegistry.keys(runtime.vm.registries.skillRegistry).join(", ") || "none"
    return `Error: Unknown skill '${input.skill}'. Available: ${available}`
  }
  const selectedResources = requestedResources(input)
  if (typeof selectedResources === "string") return selectedResources
  for (const resource of selectedResources) {
    const issue = exactResourceIssue(resource)
    if (issue) return `Error: Skill resource '${resource}' ${issue}`
    if (resource !== ROOT_RESOURCE && !skill.resources?.includes(resource)) {
      return `Error: Skill resource '${resource}' is not declared by '${skillName}'`
    }
  }

  const globalRoot = resolveEidolonGlobalRootFromOuterContext(runtime.vm.outerCtx)
  const resolved: Array<{ resource: string; fullPath: string; sourceText: string; sizeBytes: number }> = []
  for (const resource of selectedResources) {
    let fullPath = path.resolve(skill.dir, ...resource.split("/"))
    let sourceText: string
    let sizeBytes: number
    if (skillName.startsWith("sys-")) {
      const installedText = await readInstalledSystemSkillResource({
        globalRoot,
        skillName,
        relativePath: resource,
      })
      sourceText = resource === ROOT_RESOURCE
        ? SkillRegistry.getSkillContent(runtime.vm.registries.skillRegistry, skillName) ?? installedText
        : installedText
      sizeBytes = Buffer.byteLength(sourceText)
    } else {
      try {
        const ordinary = await readOrdinarySkillResource(skill.dir, resource)
        fullPath = ordinary.fullPath
        sourceText = resource === ROOT_RESOURCE
          ? SkillRegistry.getSkillContent(runtime.vm.registries.skillRegistry, skillName) ?? ordinary.sourceText
          : ordinary.sourceText
        sizeBytes = Buffer.byteLength(sourceText)
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    resolved.push({ resource, fullPath, sourceText, sizeBytes })
  }

  return resolved.map(({ resource, fullPath, sourceText, sizeBytes }) => loadLocalTextResource({
    vm: runtime.vm,
    actorKey: runtime.actor.key,
    actorId: runtime.actor.id,
    toolCallId: String((runtime as any).toolCallId ?? ""),
    fullPath,
    canonicalResourceId: resource === ROOT_RESOURCE
      ? `${pathToFileURL(fullPath).href}#instruction-document`
      : pathToFileURL(fullPath).href,
    sourceText,
    offset: input.offset,
    limit: input.limit,
    sizeBytes,
  })).join("\n\n")
}
