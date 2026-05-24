import type { StdInnerLogic } from "depa-processor"
import {
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor"
import { getTargetWatchState, setTargetWatchState } from "../_formalTooling"
import { resolveActorSubject } from "../_resolveActorTarget"
import type { ActorWatchInnerConfig, ActorWatchInnerInput, ActorWatchInnerOutput, ActorWatchInnerRuntime } from "./InnerTypes"

export const makeActorWatchOuterComputed = stdMakeNullOuterComputed
export const makeActorWatchInnerRuntime = stdMakeIdentityInnerRuntime
export const makeActorWatchInnerInput = stdMakeIdentityInnerInput
export const makeActorWatchInnerConfig = stdMakeIdentityInnerConfig
export const makeActorWatchOuterOutput = stdMakeIdentityOuterOutput

export const actorWatchCoreLogic: StdInnerLogic<
  ActorWatchInnerRuntime,
  ActorWatchInnerInput,
  ActorWatchInnerConfig,
  ActorWatchInnerOutput
> = async (runtime, input) => {
  const targetQuery = String(input?.target ?? "")
  const target = resolveActorSubject(runtime.vm, targetQuery)
  if (!target) return JSON.stringify({ ok: false, error: "actor_not_found", target: String(input?.target ?? "") })

  const previous = getTargetWatchState(target)
  setTargetWatchState({ vm: runtime.vm, targetQuery, target, watchState: "watched" })

  return JSON.stringify({ ok: true, actor_key: target.key, actor_id: target.id, watch_state: "watched", changed: previous !== "watched" })
}
