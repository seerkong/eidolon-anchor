import type { StdInnerLogic } from "depa-processor"
import type { SkillInnerConfig, SkillInnerInput, SkillInnerOutput, SkillInnerRuntime } from "./InnerTypes"
import { SkillRegistry } from "@cell/ai-core-logic/runtime/SkillRegistry"
import { loadLocalTextResource } from "@cell/ai-organ-logic/runtime/LocalTextResourceLoader"
import path from "path"
import { pathToFileURL } from "node:url"
import {
  loadSkillEntriesWithSystemAuthority,
  resolveEidolonGlobalRootFromOuterContext,
} from "@cell/ai-support/system-skill/SystemSkillInstaller"

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
  const content = SkillRegistry.getSkillContent(runtime.vm.registries.skillRegistry, skillName) ?? ""
  const documentPath = skill.documentPath ?? path.join(skill.dir, "SKILL.md")
  return loadLocalTextResource({
    vm: runtime.vm,
    actorKey: runtime.actor.key,
    actorId: runtime.actor.id,
    toolCallId: String((runtime as any).toolCallId ?? ""),
    fullPath: documentPath,
    canonicalResourceId: `${pathToFileURL(documentPath).href}#instruction-document`,
    sourceText: content,
    offset: 1,
    limit: Math.max(1, content.split(/\r?\n/).length),
  })
}
