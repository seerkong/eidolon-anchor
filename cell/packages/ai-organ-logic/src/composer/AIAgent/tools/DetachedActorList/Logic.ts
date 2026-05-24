import type { StdInnerLogic } from "depa-processor"
import {
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor"
import { getDetachedActorRegistry } from "@cell/ai-organ-logic/detached/DetachedActorRegistry"
import type { DetachedActorListInnerConfig, DetachedActorListInnerInput, DetachedActorListInnerOutput, DetachedActorListInnerRuntime } from "./InnerTypes"

function toFormalDetachedActorKind(kind: string): string {
  return kind
}

export const makeDetachedActorListOuterComputed = stdMakeNullOuterComputed
export const makeDetachedActorListInnerRuntime = stdMakeIdentityInnerRuntime
export const makeDetachedActorListInnerInput = stdMakeIdentityInnerInput
export const makeDetachedActorListInnerConfig = stdMakeIdentityInnerConfig
export const makeDetachedActorListOuterOutput = stdMakeIdentityOuterOutput

export const detachedActorListCoreLogic: StdInnerLogic<DetachedActorListInnerRuntime, DetachedActorListInnerInput, DetachedActorListInnerConfig, DetachedActorListInnerOutput> = async (runtime) => {
  const tasks = getDetachedActorRegistry(runtime.vm).list().map((entry) => ({
    task_id: entry.taskId,
    kind: entry.kind,
    kind_formal: toFormalDetachedActorKind(entry.kind),
    status: entry.status,
    created_at: entry.createdAt,
    updated_at: entry.updatedAt,
    output_text: entry.outputText ?? null,
    error: entry.error ?? null,
  }))
  return JSON.stringify({ ok: true, tasks })
}
