import type { SkillOuterInput, SkillOuterOutput, SkillOuterRuntime } from "./OuterTypes"

export type SkillInnerRuntime = SkillOuterRuntime
export type SkillInnerInput = SkillOuterInput
export type SkillInnerConfig = Record<string, unknown>
export type SkillInnerOutput = SkillOuterOutput
