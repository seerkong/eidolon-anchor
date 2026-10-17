import type { VmThreadGoalActivation, VmThreadGoalSuspensionReason } from "@cell/ai-core-contract/runtime/AiAgentVm"
import { clearThreadGoal, getThreadGoal, setThreadGoal, updateThreadGoalStatus } from "@cell/ai-organ-logic/goals/ThreadGoalManager"
import type { ThreadGoalContinuationAdmission } from "@cell/ai-organ-logic/goals/ThreadGoalRuntime"
import type { CommandAdmission, CommandEnvelope, GoalControl, GoalControlReceipt, HostAuthorizationEffects, HostIdentityEffects, HostRequest, SessionGoalView } from "@cell/ai-runtime-host-contract"
import { HostCommandOutcomeUnknown, HostProtocolFailure } from "@cell/ai-runtime-host-logic"
import type { SessionRuntimeReady } from "./session/SessionRuntimeAssembly"

/** Shell execution authorization and admission; ThreadGoalManager remains the goal authority. */
export function createGoalHost(options: {
  ready: SessionRuntimeReady
  sessionId: string
  epoch: string
  authorization: HostAuthorizationEffects
  identity: HostIdentityEffects
  requireIdle(request: HostRequest): void
  unavailable(): boolean
  continuationBlocked(): boolean
  refresh(): void
  checkpoint(state: "pending" | "saved" | "failed", request: HostRequest): void
  command(request: HostRequest, command: CommandEnvelope): CommandAdmission
}) {
  const { ready, sessionId, epoch } = options
  // Only a successful checkpoint in this live Host can install execution authorization.
  let savedActivationId: string | undefined
  const fail = (request: HostRequest, status: number, code: string): never => { throw new HostProtocolFailure(status, { code, requestId: request.requestId, retryable: false }) }
  const primaryId = () => ready.vm.actors[ready.vm.controlActorKey]?.id
  const receipt = (): GoalControlReceipt => {
    const goal = getThreadGoal(ready.vm)
    return goal ? { cleared: false, goalId: goal.goalId, status: goal.status } : { cleared: true }
  }
  const installedActivation = () => {
    const activation = getThreadGoal(ready.vm)?.activation
    return activation?.source === "web" && activation.sessionId === sessionId && activation.actorId === primaryId()
      && activation.epoch === epoch && activation.commandId === savedActivationId ? activation : undefined
  }
  const view = (): SessionGoalView => {
    const goal = getThreadGoal(ready.vm)
    return { scope: "session", controlActorId: primaryId()!, accounting: "session_estimate", resumeRequired: Boolean(goal && (goal.status === "paused" || goal.status === "active" && !installedActivation())),
      record: goal ? { goalId: goal.goalId, objective: goal.objective, status: goal.status, tokensUsed: goal.tokensUsed, timeUsedSeconds: goal.timeUsedSeconds,
        createdAt: goal.createdAt, updatedAt: goal.updatedAt,
        ...(goal.tokenBudget !== undefined ? { tokenBudget: goal.tokenBudget } : {}),
        ...(goal.completionAudit !== undefined ? { completionAudit: goal.completionAudit } : {}),
        ...(goal.blockedReason !== undefined ? { blockedReason: goal.blockedReason } : {}),
        ...(goal.suspensionReason !== undefined ? { suspensionReason: goal.suspensionReason } : {}) } : null }
  }
  const permits = (request: HostRequest, action: "set_goal" | "continue_goal" | "send_text") =>
    options.authorization.currentGrantsVersion(request.principal.principalId) === request.principal.grantsVersion
    && options.authorization.permits(request.principal, { kind: "session", sessionId, action: "open" })
    && options.authorization.permits(request.principal, { kind: "actor", sessionId, actorId: primaryId()!, action })
  const validateControl = (request: HostRequest, input: GoalControl) => {
    if (input.actorId !== primaryId()) return fail(request, 403, "goal_requires_primary")
    if (!permits(request, "set_goal")) return fail(request, 403, "forbidden")
    if ((getThreadGoal(ready.vm)?.goalId ?? null) !== input.expectedGoalId) return fail(request, 409, "goal_changed")
    if (input.operation === "set" && getThreadGoal(ready.vm) && getThreadGoal(ready.vm)!.status !== "complete") return fail(request, 409, "goal_already_exists")
    if (["pause", "resume", "edit"].includes(input.operation) && !getThreadGoal(ready.vm)) return fail(request, 409, "goal_not_found")
    if (["set", "edit", "resume"].includes(input.operation) && (!permits(request, "continue_goal") || !permits(request, "send_text"))) return fail(request, 403, "forbidden")
  }
  const previewControl = (input: GoalControl): SessionGoalView => {
    const next = view()
    if (input.operation === "clear") return { ...next, record: null, resumeRequired: false }
    if (input.operation === "set" || input.operation === "edit") return { ...next, resumeRequired: true,
      record: { goalId: "00000000-0000-0000-0000-000000000000", objective: input.objective.trim(), status: "active",
        tokensUsed: 0, timeUsedSeconds: 0, createdAt: Number.MAX_SAFE_INTEGER, updatedAt: Number.MAX_SAFE_INTEGER,
        ...(input.tokenBudget !== undefined ? { tokenBudget: input.tokenBudget } : {}) } }
    return { ...next, record: next.record ? { ...next.record, status: input.operation === "pause" ? "paused" : "active" } : null }
  }
  const suspend = (reason: VmThreadGoalSuspensionReason) => {
    savedActivationId = undefined
    if (getThreadGoal(ready.vm)?.status === "active") updateThreadGoalStatus({ vm: ready.vm, status: "paused", suspensionReason: reason })
    options.refresh()
  }
  const validateContinuation = (request: HostRequest, input: { actorId: string; goalId: string }) => {
    const goal = getThreadGoal(ready.vm), activation = installedActivation()
    if (input.actorId !== primaryId()) return fail(request, 403, "goal_requires_primary")
    if (!goal || goal.goalId !== input.goalId || goal.status !== "active" || !activation) return fail(request, 409, "goal_not_active")
    if (activation.principalId !== request.principal.principalId || activation.grantsVersion !== request.principal.grantsVersion
      || !permits(request, "set_goal") || !permits(request, "continue_goal") || !permits(request, "send_text")) return fail(request, 403, "forbidden")
    return goal
  }
  const manage = async (request: HostRequest, input: GoalControl, commandId: string) => {
    validateControl(request, input)
    if (options.unavailable()) return fail(request, 409, "goal_control_unavailable")
    if (input.operation !== "pause") options.requireIdle(request)
    const activation: VmThreadGoalActivation = { source: "web", sessionId, actorId: input.actorId, epoch,
      principalId: request.principal.principalId, grantsVersion: request.principal.grantsVersion, commandId }
    savedActivationId = undefined
    const actions = {
      set: () => setThreadGoal({ vm: ready.vm, objective: "objective" in input ? input.objective : "", tokenBudget: "tokenBudget" in input ? input.tokenBudget : undefined, activation }),
      edit: () => setThreadGoal({ vm: ready.vm, objective: "objective" in input ? input.objective : "", tokenBudget: "tokenBudget" in input ? input.tokenBudget : undefined, activation }),
      pause: () => updateThreadGoalStatus({ vm: ready.vm, status: "paused" }),
      resume: () => updateThreadGoalStatus({ vm: ready.vm, status: "active", activation }),
      clear: () => clearThreadGoal(ready.vm),
    }
    const outcome = actions[input.operation]()
    if (!outcome.ok) return fail(request, 409, outcome.error || "goal_control_failed")
    options.checkpoint("pending", request)
    try {
      const checkpoint = await ready.checkpointWithoutExecution()
      if (checkpoint.status !== "saved") throw new Error("goal_checkpoint_not_saved")
      // The async checkpoint may outlive a grant, pause or owner transition.
      if (["set", "edit", "resume"].includes(input.operation)) {
        if (!permits(request, "set_goal") || !permits(request, "continue_goal") || !permits(request, "send_text")) throw new Error("goal_authorization_changed")
        if (getThreadGoal(ready.vm)?.activation?.commandId !== commandId || getThreadGoal(ready.vm)?.status !== "active") throw new Error("goal_activation_changed")
        savedActivationId = commandId
      }
      options.checkpoint("saved", request)
      options.refresh()
      return { actorId: input.actorId, goal: receipt() }
    } catch {
      suspend("checkpoint_failed")
      options.checkpoint("failed", request)
      throw new HostCommandOutcomeUnknown("goal_checkpoint_failed", { actorId: input.actorId, goal: receipt() })
    }
  }
  const admitContinuation: ThreadGoalContinuationAdmission = input => {
    if (options.unavailable() || options.continuationBlocked() || input.actorId !== primaryId()) return false
    const activation = installedActivation()
    if (!activation) return false
    const request: HostRequest = { principal: { principalId: activation.principalId, grantsVersion: activation.grantsVersion }, requestId: options.identity.newId() }
    try { validateContinuation(request, { actorId: input.actorId, goalId: input.goal.goalId }) }
    catch { suspend("authorization_revoked"); return false }
    try { options.requireIdle(request) } catch { return false }
    try {
      const result = options.command(request, { kind: "continue_goal", commandId: options.identity.newId(), surfaceId: "runtime-goal", expectedEpoch: epoch, payload: { actorId: input.actorId, goalId: input.goal.goalId } })
      return result.status === "accepted"
    } catch { suspend("continuation_failed"); return false }
  }
  return { view, previewControl, receipt, validateControl, validateContinuation, manage, admitContinuation, suspend }
}
