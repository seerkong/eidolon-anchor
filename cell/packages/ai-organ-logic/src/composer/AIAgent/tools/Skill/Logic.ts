import type { StdInnerLogic } from "depa-processor"
import type { SkillInnerConfig, SkillInnerInput, SkillInnerOutput, SkillInnerRuntime } from "./InnerTypes"
import { SkillRegistry } from "@cell/ai-core-logic/runtime/SkillRegistry"
import path from "path"

export const skillCoreLogic: StdInnerLogic<SkillInnerRuntime, SkillInnerInput, SkillInnerConfig, SkillInnerOutput> = async (
  runtime,
  input,
  _config,
) => {
  const workDir = runtime.vm.outerCtx.workDir
  if (typeof workDir !== "string" || !workDir.trim()) {
    return "Error: workDir not configured"
  }

  const skillsDir = path.join(workDir, ".eidolon", "skills")
  SkillRegistry.reloadFromDir(runtime.vm.registries.skillRegistry, skillsDir)
  const content = SkillRegistry.getSkillContent(runtime.vm.registries.skillRegistry, String(input.skill ?? ""))
  if (!content) {
    const available = SkillRegistry.keys(runtime.vm.registries.skillRegistry).join(", ") || "none"
    return `Error: Unknown skill '${input.skill}'. Available: ${available}`
  }
  return `<skill-loaded name="${input.skill}">\n${content}\n</skill-loaded>\n\nFollow the instructions in the skill above to complete the user's task.`
}
