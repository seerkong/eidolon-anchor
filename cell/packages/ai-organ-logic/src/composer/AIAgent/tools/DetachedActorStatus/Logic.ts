import type { StdInnerLogic } from "depa-processor"

import { getDetachedActorRegistry } from "@cell/ai-organ-logic/detached/DetachedActorRegistry"

import type {
  DetachedActorStatusInnerConfig,
  DetachedActorStatusInnerInput,
  DetachedActorStatusInnerOutput,
  DetachedActorStatusInnerRuntime,
} from "./InnerTypes"

function toFormalDetachedActorKind(kind: string): string {
  return kind
}

function getDetachedRecordFromActor(runtime: DetachedActorStatusInnerRuntime, taskId: string) {
  for (const actor of Object.values(runtime.vm.actors)) {
    if (actor.type !== "detached") continue
    if (actor.detachedTask?.taskId !== taskId) continue
    return {
      taskId,
      kind: actor.detachedTask.kind,
      status: actor.detachedTask.status,
      createdAt: actor.detachedTask.createdAt,
      updatedAt: actor.detachedTask.updatedAt,
      toolCallId: actor.detachedTask.toolCallId,
      parentFiberId: actor.detachedTask.parentFiberId,
      childFiberId: actor.detachedTask.childFiberId,
      childActorKey: actor.key,
      childActorId: actor.id,
      outputText: actor.detachedTask.outputText,
      error: actor.detachedTask.error,
    }
  }
  return null
}

export const detachedActorStatusCoreLogic: StdInnerLogic<
  DetachedActorStatusInnerRuntime,
  DetachedActorStatusInnerInput,
  DetachedActorStatusInnerConfig,
  DetachedActorStatusInnerOutput
> = async (runtime, input, _config) => {
  try {
    const taskId = String((input as any)?.task_id ?? "").trim()
    if (!taskId) {
      return JSON.stringify({ ok: false, error: "missing_task_id" })
    }

    const registry = getDetachedActorRegistry(runtime.vm)
    const rec = getDetachedRecordFromActor(runtime, taskId) ?? registry.get(taskId)
    if (!rec) {
      return JSON.stringify({ ok: false, error: "not_found", task_id: taskId })
    }

    return JSON.stringify({
      ok: true,
      task_id: rec.taskId,
      kind: rec.kind,
      kind_formal: toFormalDetachedActorKind(rec.kind),
      status: rec.status,
      created_at: rec.createdAt,
      updated_at: rec.updatedAt,
      tool_call_id: rec.toolCallId ?? null,
      parent_fiber_id: rec.parentFiberId ?? null,
      child_fiber_id: rec.childFiberId ?? null,
      child_actor_key: rec.childActorKey ?? null,
      child_actor_id: rec.childActorId ?? null,
      output_text: rec.outputText ?? null,
      error: rec.error ?? null,
    })
  } catch (e: any) {
    return JSON.stringify({ ok: false, error: String(e?.message ?? e ?? "unknown") })
  }
}
