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
import type { ActorUnwatchInnerConfig, ActorUnwatchInnerInput, ActorUnwatchInnerOutput, ActorUnwatchInnerRuntime } from "./InnerTypes"

export const makeActorUnwatchOuterComputed = stdMakeNullOuterComputed
export const makeActorUnwatchInnerRuntime = stdMakeIdentityInnerRuntime
export const makeActorUnwatchInnerInput = stdMakeIdentityInnerInput
export const makeActorUnwatchInnerConfig = stdMakeIdentityInnerConfig
export const makeActorUnwatchOuterOutput = stdMakeIdentityOuterOutput

export const actorUnwatchCoreLogic: StdInnerLogic<
  ActorUnwatchInnerRuntime,
  ActorUnwatchInnerInput,
  ActorUnwatchInnerConfig,
  ActorUnwatchInnerOutput
> = async (runtime, input) => {
  const targetQuery = String(input?.target ?? "")
  const target = resolveActorSubject(runtime.vm, targetQuery)
  if (!target) return JSON.stringify({ ok: false, error: "actor_not_found", target: String(input?.target ?? "") })

  const previous = getTargetWatchState(target)
  setTargetWatchState({ vm: runtime.vm, targetQuery, target, watchState: "unwatched" })

  return JSON.stringify({ ok: true, actor_key: target.key, actor_id: target.id, watch_state: "unwatched", changed: previous !== "unwatched" })
}
