import type { WorkflowAuthoringSession } from "./WorkflowAuthoringSessionStore"

export const WORKFLOW_AUTHORING_DEFAULT_PAGE_SIZE = 20
export const WORKFLOW_AUTHORING_MAX_PAGE_SIZE = 100
export const WORKFLOW_AUTHORING_MAX_PROOF_REFERENCES = 20

export type WorkflowAuthoringBrief = {
  session_id: string
  form: WorkflowAuthoringSession["form"]
  status: WorkflowAuthoringSession["status"]
  lifecycle: WorkflowAuthoringSession["lifecycle"]
  dirty: boolean
  base_revision: string
  working_revision: string
  published_revision?: string
  latest_publication_receipt_id?: string
  created_at: string
  updated_at: string
}

type CursorFact = { updatedAt: string; sessionId: string }

function encodeCursor(value: CursorFact): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
}

function decodeCursor(value: string): CursorFact {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as CursorFact
    if (typeof parsed.updatedAt !== "string" || typeof parsed.sessionId !== "string") throw new Error("invalid")
    return parsed
  } catch {
    throw new Error("Invalid workflow authoring sessions cursor")
  }
}

export function projectWorkflowAuthoringBrief(session: WorkflowAuthoringSession): WorkflowAuthoringBrief {
  return {
    session_id: session.sessionId,
    form: session.form,
    status: session.status,
    lifecycle: session.lifecycle,
    dirty: session.dirty,
    base_revision: session.baseRevision,
    working_revision: session.workingRevision,
    published_revision: session.publishedRevision,
    latest_publication_receipt_id: session.latestPublicationReceiptId,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
  }
}

export function projectWorkflowAuthoringSessionPage(
  sessions: readonly WorkflowAuthoringSession[],
  input: { limit?: number; cursor?: string } = {},
): {
  sessions: WorkflowAuthoringBrief[]
  next_cursor?: string
  total: number
  truncated: boolean
} {
  const requested = Number.isFinite(input.limit) ? Math.trunc(input.limit!) : WORKFLOW_AUTHORING_DEFAULT_PAGE_SIZE
  if (requested < 1) throw new Error("Workflow authoring sessions limit must be positive")
  const limit = Math.min(requested, WORKFLOW_AUTHORING_MAX_PAGE_SIZE)
  const ordered = [...sessions].sort((left, right) => (
    right.updatedAt.localeCompare(left.updatedAt) || left.sessionId.localeCompare(right.sessionId)
  ))
  let offset = 0
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor)
    const index = ordered.findIndex((session) => (
      session.updatedAt === cursor.updatedAt && session.sessionId === cursor.sessionId
    ))
    if (index < 0) throw new Error("Workflow authoring sessions cursor is stale")
    offset = index + 1
  }
  const selected = ordered.slice(offset, offset + limit)
  const truncated = offset + selected.length < ordered.length
  const last = selected.at(-1)
  return {
    sessions: selected.map(projectWorkflowAuthoringBrief),
    next_cursor: truncated && last
      ? encodeCursor({ updatedAt: last.updatedAt, sessionId: last.sessionId })
      : undefined,
    total: ordered.length,
    truncated,
  }
}

export function projectWorkflowAuthoringSummary(session: WorkflowAuthoringSession): Record<string, unknown> {
  const references = [
    session.diffRevision ? { kind: "diff", revision: session.diffRevision } : undefined,
    session.validationRevision ? { kind: "validation", revision: session.validationRevision } : undefined,
    session.dryRunRevision ? { kind: "static_projection", revision: session.dryRunRevision } : undefined,
    session.latestPublicationReceiptId
      ? { kind: "publication", receipt_id: session.latestPublicationReceiptId, revision: session.publishedRevision }
      : undefined,
  ].filter((item): item is NonNullable<typeof item> => Boolean(item))
  const proofReferences = references.slice(0, WORKFLOW_AUTHORING_MAX_PROOF_REFERENCES)
  return {
    ...projectWorkflowAuthoringBrief(session),
    diff_summary: session.diffResult?.summary,
    diagnostic_count: session.validationResult?.diagnostics.length ?? 0,
    proof_references: proofReferences,
    proof_reference_count: references.length,
    proof_references_truncated: references.length > proofReferences.length,
  }
}
