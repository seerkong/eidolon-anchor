import type { AnyToolDef } from "@cell/ai-core-contract/types"
import { buildBashToolDef } from "./tools/Bash"
import { buildApplyPatchToolDef } from "./tools/ApplyPatch"
import { buildEditToolDef } from "./tools/Edit"
import { buildGlobToolDef } from "./tools/Glob"
import { buildGrepToolDef } from "./tools/Grep"
import { buildLsToolDef } from "./tools/Ls"
import { buildMultieditToolDef } from "./tools/Multiedit"
import { buildReadToolDef } from "./tools/Read"
import { buildWriteToolDef } from "./tools/Write"
import { buildGetWeatherToolDef } from "./tools/get_weather"
import { buildListCityMajorAtractionsToolDef } from "./tools/list_city_major_atractions"
import { buildSkillToolDef } from "./tools/Skill"
import { buildRunDelegateActorToolDef } from "./tools/RunDelegateActor"
import { buildQuestionnaireToolDef } from "./tools/Questionnaire"
import { buildActorStatusToolDef } from "./tools/ActorStatus"
import { buildActorAssignToolDef } from "./tools/ActorAssign"
import { buildActorWatchToolDef } from "./tools/ActorWatch"
import { buildActorUnwatchToolDef } from "./tools/ActorUnwatch"
import { buildMemberCreateToolDef } from "./tools/MemberCreate"
import { buildMemberListToolDef } from "./tools/MemberList"
import { buildMemberStatusToolDef } from "./tools/MemberStatus"
import { buildMemberAssignToolDef } from "./tools/MemberAssign"
import { buildHolonCreateToolDef } from "./tools/HolonCreate"
import { buildHolonAddToolDef } from "./tools/HolonAdd"
import { buildHolonAppointToolDef } from "./tools/HolonAppoint"
import { buildHolonStatusToolDef } from "./tools/HolonStatus"
import { buildHolonAssignToolDef } from "./tools/HolonAssign"
import { buildDetachedActorStatusToolDef } from "./tools/DetachedActorStatus"
import { buildDetachedActorListToolDef } from "./tools/DetachedActorList"
import { buildRunDetachedBashToolDef } from "./tools/RunDetachedBash"
import { buildDetachedToolCallToolDef } from "./tools/DetachedToolCall"
import { buildDetachedActorLogsToolDef } from "./tools/DetachedActorLogs"
import { buildDetachedActorMessagesToolDef } from "./tools/DetachedActorMessages"
import { buildDetachedActorResultToolDef } from "./tools/DetachedActorResult"
import { buildWebfetchToolDef } from "./tools/webfetch"
import { buildWebsearchToolDef } from "./tools/websearch"
import { buildShutdownRequestToolDef } from "./tools/ShutdownRequest"
import { buildShutdownStatusToolDef } from "./tools/ShutdownStatus"
import { buildPlanReviewToolDef } from "./tools/PlanReview"
import { buildCoordinationStatusToolDef } from "./tools/CoordinationStatus"
import { buildGoalCommandToolDef } from "./tools/GoalCommand"
import { buildSetTaskPhaseToolDef } from "./tools/SetTaskPhase"
import { buildGoalCreateToolDef } from "./tools/GoalCreate"
import { buildGoalGetToolDef } from "./tools/GoalGet"
import { buildGoalUpdateToolDef } from "./tools/GoalUpdate"
import { buildTaskTreeDefaultToolDefsFromManifest } from "./tools/taskTreeManifestBundle"
import {
  buildCancelScheduleToolDef,
  buildCreateIntervalToolDef,
  buildCreateTimeoutToolDef,
  buildListSchedulesToolDef,
} from "./tools/HeartbeatTools"

export const INTERNAL_ONLY_BUILTIN_TOOL_NAMES = new Set([
  "DetachedToolCall",
  "ShutdownRequest",
  "ShutdownStatus",
  "CoordinationStatus",
  "GoalCommand",
])

export function buildBuiltinToolDefs(options?: { includeInternalOnly?: boolean }): AnyToolDef[] {
  const taskTreeDefs = buildTaskTreeDefaultToolDefsFromManifest()
  const defs = [
    buildBashToolDef(),
    buildApplyPatchToolDef(),
    buildEditToolDef(),
    buildGlobToolDef(),
    buildGrepToolDef(),
    buildLsToolDef(),
    buildMultieditToolDef(),
    buildReadToolDef(),
    buildWriteToolDef(),
    ...taskTreeDefs,
    buildGetWeatherToolDef(),
    buildListCityMajorAtractionsToolDef(),
    buildQuestionnaireToolDef(),
    buildActorAssignToolDef(),
    buildActorStatusToolDef(),
    buildActorWatchToolDef(),
    buildActorUnwatchToolDef(),
    buildMemberCreateToolDef(),
    buildMemberListToolDef(),
    buildMemberStatusToolDef(),
    buildMemberAssignToolDef(),
    buildHolonCreateToolDef(),
    buildHolonAddToolDef(),
    buildHolonAppointToolDef(),
    buildHolonStatusToolDef(),
    buildHolonAssignToolDef(),
    buildSkillToolDef(),
    buildRunDelegateActorToolDef(),
    buildRunDetachedBashToolDef(),
    buildDetachedToolCallToolDef(),
    buildDetachedActorListToolDef(),
    buildDetachedActorStatusToolDef(),
    buildDetachedActorLogsToolDef(),
    buildDetachedActorMessagesToolDef(),
    buildDetachedActorResultToolDef(),
    buildShutdownRequestToolDef(),
    buildShutdownStatusToolDef(),
    buildPlanReviewToolDef(),
    buildCoordinationStatusToolDef(),
    buildGoalGetToolDef(),
    buildGoalCreateToolDef(),
    buildGoalUpdateToolDef(),
    buildGoalCommandToolDef(),
    buildSetTaskPhaseToolDef(),
    buildCreateTimeoutToolDef(),
    buildCreateIntervalToolDef(),
    buildListSchedulesToolDef(),
    buildCancelScheduleToolDef(),
    buildWebfetchToolDef(),
    buildWebsearchToolDef(),
  ]

  if (options?.includeInternalOnly === false) {
    return defs.filter((def) => !INTERNAL_ONLY_BUILTIN_TOOL_NAMES.has(def.schema.function.name))
  }

  return defs
}
