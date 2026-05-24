import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor"
import type { AiAgentVm } from "@cell/ai-core-logic/runtime/runtime"
import { getOrganizationManager } from "@cell/ai-organ-logic/organization/OrganizationManager"

export type FormalAssignMode = "final" | "none" | "stream"

export function parseFormalAssignMode(input: unknown): FormalAssignMode | null {
  if (input === "final" || input === "none" || input === "stream") return input
  return null
}

export function requireNonEmptyContent(input: unknown): string | null {
  const content = String(input ?? "").trim()
  return content ? content : null
}

export function stripTargetTypePrefix(value: string): string {
  const idx = value.indexOf(":")
  return idx < 0 ? value : value.slice(idx + 1)
}

export function setTargetWatchState(params: {
  vm: AiAgentVm
  targetQuery: string
  target:
    | AiAgentActor
    | {
        identity?: { kind?: string }
      }
  watchState: "watched" | "unwatched"
}): "watched" | "unwatched" {
  const { vm, targetQuery, target, watchState } = params
  const kind = (target as any)?.identity?.kind
  const governance = (target as any)?.identity?.governance ?? (target as any)?.governance
  if (kind === "holon" && (governance === "autonomous" || governance === "leader_led")) {
    getOrganizationManager().setHolonWatchState(vm, targetQuery, watchState)
    return watchState
  }
  ;(target as any).watchState = watchState
  return watchState
}

export function getTargetWatchState(target: unknown): "watched" | "unwatched" {
  return (target as any)?.watchState === "watched" ? "watched" : "unwatched"
}

export function getLatestAssistantText(actor: AiAgentActor | null | undefined): string | null {
  if (!actor) return null
  for (let i = actor.messages.length - 1; i >= 0; i -= 1) {
    const msg = actor.messages[i]
    if (msg?.role === "assistant") {
      const content = typeof msg.content === "string" ? msg.content.trim() : ""
      if (content) return content
    }
  }
  return null
}
