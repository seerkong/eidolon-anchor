import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"

import { getOrganizationManager } from "./OrganizationManager"

export type CanonicalHolonReplyMode = "final" | "none" | "stream"

export interface CanonicalHolonAssignmentInput {
  readonly runtime: AiAgentOneActorRuntime
  readonly target: string
  readonly mode: CanonicalHolonReplyMode
  readonly content: string
}

export interface CanonicalHolonAssignmentRequest {
  readonly target: string
  readonly holonId: string
  readonly mode: CanonicalHolonReplyMode
  readonly content: string
  readonly requestId?: string
}

export interface CanonicalHolonAssignmentReceipt {
  readonly ok: true
  readonly accepted: true
  readonly authority_id: string
  readonly workflow_run_id: string
  readonly workflow_instance_id: string
  readonly node_id: string
  readonly task_space_id: string
  readonly task_id: string
  readonly open_receipt_id: string
  readonly snapshot_receipt_id: string
  readonly subscription_id: string
  readonly reply_mode: CanonicalHolonReplyMode
  readonly completion_status: "settled" | "waiting" | "yielded" | "not_requested"
  readonly settlement_receipt_id: string | null
  readonly terminal_status: "Succeeded" | "Failed" | "Cancelled" | null
}

/** Runtime-only capability projected from one authentic frozen workflow target. */
export interface CanonicalHolonAssignmentAuthority {
  readonly authorityId: string
  readonly rootHolonRef: string
  assign(input: CanonicalHolonAssignmentRequest): Promise<CanonicalHolonAssignmentReceipt>
}

export interface CanonicalHolonBindingRequiredResult {
  readonly ok: false
  readonly error: "canonical_holon_binding_required"
  readonly target: string
  readonly target_type: "holon"
  readonly holon_id: string
  readonly governance: "autonomous"
  readonly required_authority: readonly [
    "HolonEffectiveSnapshot",
    "HolonExecutionBinding",
    "HolonTaskTarget",
  ]
}

const authoritiesByVm = new WeakMap<object, Map<string, CanonicalHolonAssignmentAuthority>>()

export function registerCanonicalHolonAssignmentAuthority(
  vm: object,
  authority: CanonicalHolonAssignmentAuthority,
): void {
  const authorityId = String(authority.authorityId ?? "").trim()
  const rootHolonRef = String(authority.rootHolonRef ?? "").trim()
  if (!authorityId || !rootHolonRef) {
    throw new Error("EIDOLON_CANONICAL_HOLON_ASSIGNMENT_AUTHORITY_INVALID")
  }
  let authorities = authoritiesByVm.get(vm)
  if (!authorities) {
    authorities = new Map()
    authoritiesByVm.set(vm, authorities)
  }
  authorities.set(authorityId, Object.freeze({ ...authority, authorityId, rootHolonRef }))
}

function stripTypePrefix(value: string): string {
  const separator = value.indexOf(":")
  return separator < 0 ? value : value.slice(separator + 1)
}

function runtimeToolCallId(runtime: AiAgentOneActorRuntime): string | undefined {
  const value = (runtime as AiAgentOneActorRuntime & { toolCallId?: unknown }).toolCallId
  return typeof value === "string" && value.trim() ? value : undefined
}

/**
 * Product boundary for autonomous Holon assignment.
 *
 * Canonical execution is admitted by a frozen HolonTaskTarget inside the
 * Ctrl/Data workflow runtime. An ordinary VM Holon record has governance
 * identity only, so it cannot manufacture a TaskSpace task or fall back to
 * the retired actor task board.
 */
export async function assignCanonicalAutonomousHolon(
  input: CanonicalHolonAssignmentInput,
): Promise<string> {
  const target = String(input.target ?? "").trim()
  const holon = getOrganizationManager().resolveAutonomousHolon(
    input.runtime.vm,
    stripTypePrefix(target),
  )
  if (!holon) {
    return JSON.stringify({ ok: false, error: "holon_not_found", target, target_type: "holon" })
  }
  const aliases = new Set([stripTypePrefix(target), holon.holonId, holon.name])
  const authorities = [...(authoritiesByVm.get(input.runtime.vm)?.values() ?? [])]
    .filter((candidate) => aliases.has(candidate.rootHolonRef))
  if (authorities.length > 1) {
    return JSON.stringify({
      ok: false,
      error: "canonical_holon_binding_ambiguous",
      target,
      target_type: "holon",
      holon_id: holon.holonId,
      governance: "autonomous",
      authority_ids: authorities.map(({ authorityId }) => authorityId).sort(),
    })
  }
  const authority = authorities[0]
  if (authority) {
    try {
      const requestId = runtimeToolCallId(input.runtime)
      const accepted = await authority.assign({
        target,
        holonId: holon.holonId,
        mode: input.mode,
        content: input.content,
        ...(requestId ? { requestId } : {}),
      })
      return JSON.stringify({
        ...accepted,
        target,
        target_type: "holon",
        holon_id: holon.holonId,
        governance: "autonomous",
      })
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: "canonical_holon_assignment_failed",
        target,
        target_type: "holon",
        holon_id: holon.holonId,
        governance: "autonomous",
        authority_id: authority.authorityId,
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const result: CanonicalHolonBindingRequiredResult = Object.freeze({
    ok: false,
    error: "canonical_holon_binding_required",
    target,
    target_type: "holon",
    holon_id: holon.holonId,
    governance: "autonomous",
    required_authority: Object.freeze([
      "HolonEffectiveSnapshot",
      "HolonExecutionBinding",
      "HolonTaskTarget",
    ] as const),
  })
  return JSON.stringify(result)
}
