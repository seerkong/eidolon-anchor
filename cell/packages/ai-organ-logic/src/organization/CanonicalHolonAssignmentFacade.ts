import { randomUUID } from "node:crypto"

import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
import {
  HOLON_TASK_RUNTIME_INVOCATION_SCHEMA_VERSION,
  type HolonTaskRuntimeAssignmentReceipt,
  type HolonTaskRuntimeInvocation,
  type HolonTaskSelector,
} from "@cell/ai-organ-contract"

import {
  assignHolonTaskThroughMountedCapability,
  requireHolonTaskRuntimeCapability,
} from "./HolonTaskRuntimeCapability"
import { getOrganizationManager, type OrganizationHolonRecord } from "./OrganizationManager"

type ProductHolonTaskSelector = Extract<HolonTaskSelector, { readonly kind: "holon" | "member" }>

export type CanonicalHolonReplyMode = "final" | "none" | "stream"

export interface CanonicalHolonAssignmentInput {
  readonly runtime: AiAgentOneActorRuntime
  readonly target: string
  readonly mode: CanonicalHolonReplyMode
  readonly content: string
}

/** Deprecated Workflow projection retained only until its caller is migrated. */
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
  readonly service_runtime_ref: string
  readonly admission_id: string
  readonly definition_ref: string
  readonly task_space_id: string
  readonly task_id: string
  readonly command_id: string
  readonly reply_mode: CanonicalHolonReplyMode
  readonly completion_status: "settled" | "waiting" | "not_requested"
  readonly settlement_receipt_id: string | null
  readonly terminal_status: "Succeeded" | "Failed" | null
  readonly result: unknown
}

/** Deprecated compatibility input. New Workflow code registers an effect route. */
export interface CanonicalHolonAssignmentAuthority {
  readonly authorityId: string
  readonly rootHolonRef: string
  assign(input: CanonicalHolonAssignmentRequest): Promise<CanonicalHolonAssignmentReceipt>
}

export interface CanonicalHolonBindingRequiredResult {
  readonly ok: false
  readonly error: "canonical_holon_binding_required"
  readonly target: string
  readonly target_type: "holon" | "member"
  readonly holon_id: string
  readonly governance: "autonomous"
  readonly required_authority: readonly [
    "HolonEffectiveSnapshot",
    "HolonExecutionBinding",
    "HolonTaskRuntimeDefinition",
  ]
}

const LEGACY_AUTHORITY_FACET = "eidolon.legacy-canonical-holon-authority/v1"

/**
 * Temporary source-compatibility shim. State is VM-owned rather than module
 * global, and the product path deliberately does not read it.
 */
export function registerCanonicalHolonAssignmentAuthority(
  vm: object,
  authority: CanonicalHolonAssignmentAuthority,
): void {
  const authorityId = String(authority.authorityId ?? "").trim()
  const rootHolonRef = String(authority.rootHolonRef ?? "").trim()
  const actorRuntime = (vm as { actorRuntime?: { ensureFacet?<T>(key: string, factory: () => T): T } }).actorRuntime
  if (!authorityId || !rootHolonRef || typeof actorRuntime?.ensureFacet !== "function") {
    throw new Error("EIDOLON_CANONICAL_HOLON_ASSIGNMENT_AUTHORITY_INVALID")
  }
  const authorities = actorRuntime.ensureFacet(
    LEGACY_AUTHORITY_FACET,
    () => new Map<string, CanonicalHolonAssignmentAuthority>(),
  )
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

function runtimeErrorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : ""
}

function holonAliases(holon: OrganizationHolonRecord, requested: string): ReadonlySet<string> {
  return new Set([holon.holonId, holon.name, stripTypePrefix(requested)])
}

function runtimeHolonRef(
  runtime: AiAgentOneActorRuntime,
  holon: OrganizationHolonRecord,
  requested: string,
): string | undefined {
  const catalog = requireHolonTaskRuntimeCapability(runtime.vm).readCatalog()
  const aliases = holonAliases(holon, requested)
  const roots = new Set(catalog.admissions
    .map(({ definition }) => definition.rootHolonRef)
    .filter((rootHolonRef) => aliases.has(rootHolonRef)))
  if (roots.size > 1) {
    throw new Error("EIDOLON_CANONICAL_HOLON_RUNTIME_ROOT_AMBIGUOUS")
  }
  return [...roots][0]
}

function invocation(
  input: CanonicalHolonAssignmentInput,
  surface: "HolonAssign" | "ActorAssign" | "MemberAssign",
): HolonTaskRuntimeInvocation {
  const requestId = runtimeToolCallId(input.runtime) ?? randomUUID()
  return Object.freeze({
    kind: "holon-task-runtime-invocation",
    schemaVersion: HOLON_TASK_RUNTIME_INVOCATION_SCHEMA_VERSION,
    requestId,
    idempotencyKey: `eidolon.product-holon-assignment:${surface}:${requestId}`,
    replyMode: input.mode,
    occurredAt: new Date().toISOString(),
    origin: Object.freeze({ kind: "product", surface, requestRef: requestId }),
    taskRequest: Object.freeze({
      kind: "derive",
      name: input.content.slice(0, 120) || "Holon assignment",
    }),
    input: Object.freeze({ content: input.content }),
  })
}

function bindingRequired(
  target: string,
  targetType: "holon" | "member",
  holon: OrganizationHolonRecord,
): CanonicalHolonBindingRequiredResult {
  return Object.freeze({
    ok: false,
    error: "canonical_holon_binding_required",
    target,
    target_type: targetType,
    holon_id: holon.holonId,
    governance: "autonomous",
    required_authority: Object.freeze([
      "HolonEffectiveSnapshot",
      "HolonExecutionBinding",
      "HolonTaskRuntimeDefinition",
    ] as const),
  })
}

function receiptProjection(
  runtime: AiAgentOneActorRuntime,
  receipt: HolonTaskRuntimeAssignmentReceipt,
): CanonicalHolonAssignmentReceipt {
  const serviceRuntimeRef = requireHolonTaskRuntimeCapability(runtime.vm).serviceRuntimeRef
  return Object.freeze({
    ok: true,
    accepted: true,
    service_runtime_ref: serviceRuntimeRef,
    admission_id: receipt.admissionId,
    definition_ref: receipt.definitionRef,
    task_space_id: receipt.task.taskSpaceId,
    task_id: receipt.task.taskId,
    command_id: receipt.task.commandId,
    reply_mode: receipt.replyMode,
    completion_status: receipt.settlement
      ? "settled"
      : receipt.replyMode === "none" ? "not_requested" : "waiting",
    settlement_receipt_id: receipt.settlement?.settlementCommandId ?? null,
    terminal_status: receipt.settlement
      ? receipt.settlement.status === "succeeded" ? "Succeeded" : "Failed"
      : null,
    result: receipt.settlement?.result ?? null,
  })
}

async function assign(
  input: CanonicalHolonAssignmentInput,
  holon: OrganizationHolonRecord,
  selector: ProductHolonTaskSelector,
  surface: "HolonAssign" | "ActorAssign" | "MemberAssign",
): Promise<string> {
  try {
    const accepted = await assignHolonTaskThroughMountedCapability(
      input.runtime.vm,
      selector,
      invocation(input, surface),
    )
    return JSON.stringify({
      ...receiptProjection(input.runtime, accepted),
      target: input.target,
      target_type: selector.kind,
      holon_id: holon.holonId,
      governance: "autonomous",
    })
  } catch (error) {
    const code = runtimeErrorCode(error)
    if (code === "EIDOLON_HOLON_TASK_BINDING_REQUIRED"
      || code === "EIDOLON_HOLON_TASK_CAPABILITY_NOT_MOUNTED") {
      return JSON.stringify(bindingRequired(input.target, selector.kind, holon))
    }
    return JSON.stringify({
      ok: false,
      error: code === "EIDOLON_HOLON_TASK_BINDING_AMBIGUOUS"
        ? "canonical_holon_binding_ambiguous"
        : "canonical_holon_assignment_failed",
      target: input.target,
      target_type: selector.kind,
      holon_id: holon.holonId,
      governance: "autonomous",
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}

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
  try {
    const holonRef = runtimeHolonRef(input.runtime, holon, target)
    if (!holonRef) return JSON.stringify(bindingRequired(target, "holon", holon))
    return assign(input, holon, { kind: "holon", holonRef }, "HolonAssign")
  } catch (error) {
    if (runtimeErrorCode(error) === "EIDOLON_HOLON_TASK_CAPABILITY_NOT_MOUNTED") {
      return JSON.stringify(bindingRequired(target, "holon", holon))
    }
    return JSON.stringify({
      ok: false,
      error: "canonical_holon_binding_ambiguous",
      target,
      target_type: "holon",
      holon_id: holon.holonId,
      governance: "autonomous",
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function assignCanonicalAutonomousMember(
  input: CanonicalHolonAssignmentInput & Readonly<{
    readonly memberId: string
    readonly memberName: string
    readonly surface: "ActorAssign" | "MemberAssign"
  }>,
): Promise<string> {
  const organizations = getOrganizationManager()
  const holons = organizations.listAutonomousHolons(input.runtime.vm)
    .filter(({ memberIds }) => memberIds.includes(input.memberId))
  if (holons.length === 0) {
    return JSON.stringify({ ok: false, error: "canonical_member_holon_not_found", target: input.target })
  }
  if (holons.length > 1) {
    return JSON.stringify({
      ok: false,
      error: "canonical_member_holon_ambiguous",
      target: input.target,
      target_type: "member",
      member_id: input.memberId,
      holon_ids: holons.map(({ holonId }) => holonId).sort(),
    })
  }
  const holon = holons[0]!
  try {
    const holonRef = runtimeHolonRef(input.runtime, holon, holon.holonId)
    if (!holonRef) return JSON.stringify(bindingRequired(input.target, "member", holon))
    const admissions = requireHolonTaskRuntimeCapability(input.runtime.vm).readCatalog().admissions
      .filter((candidate) => candidate.definition.rootHolonRef === holonRef
        && candidate.executionTarget.kind === "member"
        && [input.memberId, input.memberName].includes(candidate.executionTarget.memberRef))
    const memberRefs = new Set(admissions.map((candidate) => (
      candidate.executionTarget.kind === "member" ? candidate.executionTarget.memberRef : ""
    )))
    if (admissions.length === 0 || memberRefs.size !== 1) {
      return JSON.stringify(bindingRequired(input.target, "member", holon))
    }
    return assign(input, holon, {
      kind: "member",
      holonRef,
      memberRef: [...memberRefs][0]!,
    }, input.surface)
  } catch (error) {
    if (runtimeErrorCode(error) === "EIDOLON_HOLON_TASK_CAPABILITY_NOT_MOUNTED") {
      return JSON.stringify(bindingRequired(input.target, "member", holon))
    }
    return JSON.stringify({
      ok: false,
      error: "canonical_holon_assignment_failed",
      target: input.target,
      target_type: "member",
      holon_id: holon.holonId,
      governance: "autonomous",
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}
