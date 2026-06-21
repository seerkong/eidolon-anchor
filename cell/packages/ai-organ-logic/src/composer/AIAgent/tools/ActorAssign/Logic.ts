import type { StdInnerLogic } from "depa-processor"
import {
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor"
import { getControlRuntimeContext } from "../_controlRuntime"
import { getOrganizationManager } from "@cell/ai-organ-logic/organization/OrganizationManager"
import { resolveActorTarget } from "../_resolveActorTarget"
import { queueAutonomousHolonAssign } from "../_autonomousHolonAssignCore"
import { queueLeaderLedHolonAssign } from "../_leaderLedHolonAssignCore"
import { getLatestAssistantText, parseFormalAssignMode, requireNonEmptyContent, setTargetWatchState } from "../_formalTooling"
import type { ActorAssignInnerConfig, ActorAssignInnerInput, ActorAssignInnerOutput, ActorAssignInnerRuntime } from "./InnerTypes"

function countAssistantMessages(actor: { messages?: any[] } | null | undefined): number {
  const messages = Array.isArray(actor?.messages) ? actor.messages : []
  return messages.filter((msg) => msg?.role === "assistant").length
}

function stripTypePrefix(value: string): string {
  const idx = value.indexOf(":")
  return idx < 0 ? value : value.slice(idx + 1)
}

export const makeActorAssignOuterComputed = stdMakeNullOuterComputed
export const makeActorAssignInnerRuntime = stdMakeIdentityInnerRuntime
export const makeActorAssignInnerInput = stdMakeIdentityInnerInput
export const makeActorAssignInnerConfig = stdMakeIdentityInnerConfig
export const makeActorAssignOuterOutput = stdMakeIdentityOuterOutput

export const actorAssignCoreLogic: StdInnerLogic<
  ActorAssignInnerRuntime,
  ActorAssignInnerInput,
  ActorAssignInnerConfig,
  ActorAssignInnerOutput
> = async (runtime, input) => {
  const targetQuery = String(input?.target ?? "").trim()
  const mode = parseFormalAssignMode(input?.mode ?? "final")
  const content = requireNonEmptyContent(input?.content)
  if (!mode) return JSON.stringify({ ok: false, error: "invalid_assign_mode", target: targetQuery })
  if (!content) return JSON.stringify({ ok: false, error: "empty_content", target: targetQuery })
  const targetRef = stripTypePrefix(targetQuery)
  const { members } = getControlRuntimeContext(runtime.vm, runtime.actor)
  const memberByQuery = members.resolveMember(targetQuery)
  const targetActor = resolveActorTarget(runtime.vm, targetQuery) ?? memberByQuery?.actor ?? null
  if (!targetActor) {
    const organizations = getOrganizationManager()
    const holon = organizations.resolveHolon(runtime.vm, targetRef)
    if (holon?.governance === "autonomous") {
      return queueAutonomousHolonAssign({
        runtime,
        target: targetQuery,
        mode,
        content,
      })
    }

    if (holon?.governance === "leader_led") {
      return queueLeaderLedHolonAssign({
        runtime,
        target: targetQuery,
        mode,
        content,
      })
    }

    return JSON.stringify({ ok: false, error: "actor_not_found", target: targetQuery })
  }

  if (targetActor.identity?.kind === "member") {
    const member = memberByQuery
    if (!member || member.actor.key !== targetActor.key) {
      return JSON.stringify({ ok: false, error: "member_not_found", target: targetQuery })
    }
    members.sendMessage({
      to: member.memberId,
      from: runtime.actor.identity?.kind === "member" ? runtime.actor.identity.name : runtime.actor.key,
      text: content,
    })
    if (mode === "stream") {
      setTargetWatchState({ vm: runtime.vm, targetQuery, target: targetActor, watchState: "watched" })
      return JSON.stringify({
        ok: true,
        target: targetQuery,
        target_type: "member",
        actor_key: targetActor.key,
        actor_id: targetActor.id,
        actor_type: targetActor.type,
        reply_mode: "stream",
        stream_opened: true,
        watch_state: (targetActor as any).watchState ?? "unwatched",
      })
    }
    if (mode === "final") {
      const { driver } = getControlRuntimeContext(runtime.vm, runtime.actor)
      const assistantCountBefore = countAssistantMessages(targetActor)
      try {
        await driver.tickUntilForegroundSettled({ now: Date.now(), maxTicks: 120, maxWallMs: 2000 })
      } catch (error) {
        return JSON.stringify({
          ok: true,
          target: targetQuery,
          target_type: "member",
          actor_key: targetActor.key,
          actor_id: targetActor.id,
          actor_type: targetActor.type,
          reply_mode: "final",
          accepted: true,
          completion_status: "timeout",
          result_text: null,
          error: error instanceof Error ? error.message : String(error),
          watch_state: (targetActor as any).watchState ?? "unwatched",
        })
      }
      const assistantCountAfter = countAssistantMessages(targetActor)
      const resultText = assistantCountAfter > assistantCountBefore ? getLatestAssistantText(targetActor) : null
      return JSON.stringify({
        ok: true,
        target: targetQuery,
        target_type: "member",
        actor_key: targetActor.key,
        actor_id: targetActor.id,
        actor_type: targetActor.type,
        reply_mode: "final",
        accepted: true,
        completion_status: resultText ? "settled" : "pending",
        result_text: resultText,
        watch_state: (targetActor as any).watchState ?? "unwatched",
      })
    }
    return JSON.stringify({
      ok: true,
      target: targetQuery,
      target_type: "member",
      actor_key: targetActor.key,
      actor_id: targetActor.id,
      actor_type: targetActor.type,
      reply_mode: "none",
      accepted: true,
      completion_status: "not_requested",
      watch_state: (targetActor as any).watchState ?? "unwatched",
    })
  }

  if (targetActor.identity?.kind === "holon" && targetActor.identity.governance === "autonomous") {
    return queueAutonomousHolonAssign({
      runtime,
      target: targetQuery,
      mode,
      content,
    })
  }
  if (targetActor.identity?.kind === "holon" && targetActor.identity.governance === "leader_led") {
    return queueLeaderLedHolonAssign({
      runtime,
      target: targetQuery,
      mode,
      content,
    })
  }

  return JSON.stringify({ ok: false, error: "actor_assign_target_unsupported", target: targetQuery })
}
