export const WORKFLOW_DOMAIN_PROGRESS_KIND = "workflow.domainProgressFact" as const
export const WORKFLOW_DOMAIN_PROGRESS_SCHEMA_VERSION = "workflow.domain-progress-fact/v1" as const

export type WorkflowDomainProgressOwner =
  | "workflow.authoring"
  | "workflow.publication"
  | "workflow.runtime"

export type WorkflowDomainProgressTransition =
  | "workspace_opened"
  | "workspace_revision_changed"
  | "proof_prepared"
  | "lifecycle_completed"
  | "publication_created"
  | "instance_prepared"
  | "run_started"
  | "run_advanced"
  | "result_observed"

export type WorkflowDomainProgressFact = Readonly<{
  kind: typeof WORKFLOW_DOMAIN_PROGRESS_KIND
  schemaVersion: typeof WORKFLOW_DOMAIN_PROGRESS_SCHEMA_VERSION
  owner: WorkflowDomainProgressOwner
  transition: WorkflowDomainProgressTransition
  subjectId: string
  revision: string
}>

const OWNERS = new Set<WorkflowDomainProgressOwner>([
  "workflow.authoring",
  "workflow.publication",
  "workflow.runtime",
])

const TRANSITIONS = new Set<WorkflowDomainProgressTransition>([
  "workspace_opened",
  "workspace_revision_changed",
  "proof_prepared",
  "lifecycle_completed",
  "publication_created",
  "instance_prepared",
  "run_started",
  "run_advanced",
  "result_observed",
])

const FACT_KEYS = ["kind", "owner", "revision", "schemaVersion", "subjectId", "transition"] as const

function compareUtf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function isClosedPlainDataRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  if (Object.getOwnPropertySymbols(value).length > 0) return false
  const actualKeys = Object.keys(value).sort(compareUtf16)
  const expectedKeys = [...keys].sort(compareUtf16)
  if (actualKeys.length !== expectedKeys.length) return false
  for (let index = 0; index < expectedKeys.length; index += 1) {
    if (actualKeys[index] !== expectedKeys[index]) return false
    const descriptor = Object.getOwnPropertyDescriptor(value, expectedKeys[index]!)
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false
  }
  return true
}

function exactText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    ? value
    : undefined
}

export function createWorkflowDomainProgressFact(input: {
  owner: WorkflowDomainProgressOwner
  transition: WorkflowDomainProgressTransition
  subjectId: string
  revision: string
}): WorkflowDomainProgressFact {
  const subjectId = exactText(input.subjectId)
  const revision = exactText(input.revision)
  if (!OWNERS.has(input.owner)) throw new Error("Workflow progress owner is not supported")
  if (!TRANSITIONS.has(input.transition)) throw new Error("Workflow progress transition is not supported")
  if (!subjectId) throw new Error("Workflow progress subjectId must be exact non-empty text")
  if (!revision) throw new Error("Workflow progress revision must be exact non-empty text")
  return Object.freeze({
    kind: WORKFLOW_DOMAIN_PROGRESS_KIND,
    schemaVersion: WORKFLOW_DOMAIN_PROGRESS_SCHEMA_VERSION,
    owner: input.owner,
    transition: input.transition,
    subjectId,
    revision,
  })
}

export function withWorkflowDomainProgress<T extends object>(
  value: T,
  input: Parameters<typeof createWorkflowDomainProgressFact>[0],
): T & { workflow_progress: WorkflowDomainProgressFact } {
  return {
    ...value,
    workflow_progress: createWorkflowDomainProgressFact(input),
  }
}

export function parseWorkflowDomainProgressFact(outputText: string | undefined): WorkflowDomainProgressFact | undefined {
  if (!outputText) return undefined
  let envelope: unknown
  try {
    envelope = JSON.parse(outputText)
  } catch {
    return undefined
  }
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) return undefined
  const envelopePrototype = Object.getPrototypeOf(envelope)
  if (envelopePrototype !== Object.prototype && envelopePrototype !== null) return undefined
  if (Object.getOwnPropertySymbols(envelope).length > 0) return undefined
  const ok = Object.getOwnPropertyDescriptor(envelope, "ok")
  const progress = Object.getOwnPropertyDescriptor(envelope, "workflow_progress")
  if (!ok || !("value" in ok) || !ok.enumerable || ok.value !== true) return undefined
  if (!progress || !("value" in progress) || !progress.enumerable) return undefined
  if (!isClosedPlainDataRecord(progress.value, FACT_KEYS)) return undefined
  const fact = progress.value
  const subjectId = exactText(fact.subjectId)
  const revision = exactText(fact.revision)
  if (fact.kind !== WORKFLOW_DOMAIN_PROGRESS_KIND) return undefined
  if (fact.schemaVersion !== WORKFLOW_DOMAIN_PROGRESS_SCHEMA_VERSION) return undefined
  if (!OWNERS.has(fact.owner as WorkflowDomainProgressOwner)) return undefined
  if (!TRANSITIONS.has(fact.transition as WorkflowDomainProgressTransition)) return undefined
  if (!subjectId || !revision) return undefined
  return createWorkflowDomainProgressFact({
    owner: fact.owner as WorkflowDomainProgressOwner,
    transition: fact.transition as WorkflowDomainProgressTransition,
    subjectId,
    revision,
  })
}
