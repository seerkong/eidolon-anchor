import { createHash } from "node:crypto"
import type { ConversationSessionForkReceipt, ConversationSessionRewindReceipt } from "@cell/ai-organ-contract"
import { projectConversationForkReceipt } from "@cell/ai-organ-logic/conversation/ConversationSessionFork"
import { parseConversationOperation, type CommandEnvelope, type ConversationOperation, type ConversationOperationResult, type HostRequest } from "@cell/ai-runtime-host-contract"
import { HostCommandOutcomeUnknown, HostProtocolFailure } from "@cell/ai-runtime-host-logic"
import type { ConversationPublicationStore, StoredConversationPublication, StoredHostSession } from "@cell/ai-runtime-host-support"
import type { SessionRuntimeBridge, SessionRuntimeReady } from "./session/SessionRuntimeAssembly"

type ConversationCommand = Extract<CommandEnvelope, { kind: "fork_conversation" | "rewind_conversation" }>
type Prepared = { kind: "fork"; receipt: ConversationSessionForkReceipt } | { kind: "rewind"; receipt: ConversationSessionRewindReceipt }
type Options = {
  stored: StoredHostSession
  epoch: string
  store: ConversationPublicationStore
  bridge: SessionRuntimeBridge
  persistence: NonNullable<SessionRuntimeReady["conversationPersistence"]>
  identity: { newId(): string; now(): number }
  validate(request: HostRequest, actorId: string, action: ConversationCommand["kind"]): void
  permits(request: HostRequest, actorId: string, action: ConversationCommand["kind"]): boolean
  requireIdle(request: HostRequest): void
  historyRevision(actorId: string): string
}

/** Shell publication coordinates existing Conversation commands; it never copies history. */
export function createConversationHost(options: Options) {
  const active = new Set<string>()
  const { store, stored, epoch } = options
  const fail = (request: HostRequest, status: number, code: string): never => {
    throw new HostProtocolFailure(status, { code, requestId: request.requestId, retryable: false })
  }
  const actionFor = (record: StoredConversationPublication) => record.kind === "fork" ? "fork_conversation" as const : "rewind_conversation" as const
  const scope = (request: HostRequest, operationId: string) => ({ operationId, principalId: request.principal.principalId, sourceSessionId: stored.sessionId })
  function project(record: StoredConversationPublication): ConversationOperation {
    const identity = { operationId: record.operationId, sessionId: record.sourceSessionId, actorId: record.actorId, commandId: record.commandId,
      epoch, submittedEpoch: record.epoch, kind: record.kind }
    if (record.phase === "published") return parseConversationOperation({ ...identity, state: "applied", result: JSON.parse(record.result!) })
    if (record.phase === "rejected") return parseConversationOperation({ ...identity, state: "rejected", errorCode: JSON.parse(record.result!) })
    if (active.has(record.operationId)) return parseConversationOperation({ ...identity, state: "pending" })
    return parseConversationOperation({ ...identity, state: "unknown", errorCode: "conversation_outcome_unresolved" })
  }
  const unresolved = (record: StoredConversationPublication): never => {
    active.delete(record.operationId)
    throw new HostCommandOutcomeUnknown("conversation_outcome_unresolved", { actorId: record.actorId, conversation: project(record) })
  }
  const guard = (request: HostRequest, command: ConversationCommand) => {
    options.validate(request, command.payload.actorId, command.kind)
    options.requireIdle(request)
    if (options.historyRevision(command.payload.actorId) !== command.payload.expectedHistoryRevision) fail(request, 409, "history_revision_changed")
  }
  const reject = (record: StoredConversationPublication, code: string) => store.reject(record, JSON.stringify(code))
  const decodePrepared = (record: StoredConversationPublication): Prepared => {
    if (!record.prepared || new TextEncoder().encode(record.prepared).byteLength > 32768) throw new Error("invalid_prepared_proof")
    const proof = JSON.parse(record.prepared) as Prepared
    if (!proof || proof.kind !== record.kind || !proof.receipt || !/^sha256:[0-9a-f]{64}$/.test(proof.receipt.transactionId)
      || proof.receipt.proof?.sourceActorId !== record.actorId || proof.receipt.proof?.sourceSessionId !== stored.storageKey) throw new Error("invalid_prepared_proof")
    if (proof.kind === "fork") {
      if (proof.receipt.schemaVersion !== "conversation.session-fork-receipt/v1" || proof.receipt.mode !== "create"
        || proof.receipt.sourceSessionId !== stored.storageKey || proof.receipt.targetSessionId !== record.child?.storageKey) throw new Error("invalid_prepared_proof")
    } else if (proof.receipt.schemaVersion !== "conversation.session-rewind-receipt/v1" || proof.receipt.sessionId !== stored.storageKey
      || proof.receipt.actorId !== record.actorId) throw new Error("invalid_prepared_proof")
    return proof
  }
  const publishCommitted = async (request: HostRequest, record: StoredConversationPublication, synchronize: boolean): Promise<StoredConversationPublication> => {
    const prepared = decodePrepared(record)
    let result: ConversationOperationResult
    if (prepared.kind === "fork") {
      const evidence = await options.persistence.readForkCommit(prepared.receipt)
      if (evidence.status !== "committed") return record
      options.validate(request, record.actorId, actionFor(record))
      result = { kind: "fork", targetSessionId: record.child!.sessionId, targetActorId: evidence.receipt.childActorId,
        ...(evidence.receipt.proof.cutoffMessageId ? { cutoffMessageId: evidence.receipt.proof.cutoffMessageId } : {}), transactionId: evidence.receipt.transactionId }
    } else {
      const evidence = await options.persistence.readRewindCommit(prepared.receipt)
      if (evidence.status !== "committed") return record
      const validate = () => { options.validate(request, record.actorId, actionFor(record)); options.requireIdle(request) }
      validate()
      if (synchronize) await options.persistence.synchronizeActor(record.actorId, validate)
      result = { kind: "rewind", retainedMessageCount: evidence.receipt.retainedMessageCount, removedMessageCount: evidence.receipt.removedMessageCount,
        cutoffMessageId: evidence.receipt.proof.cutoffMessageId!, historyRevision: options.historyRevision(record.actorId), transactionId: evidence.receipt.transactionId }
    }
    // Validate the public projection before the directory mapping becomes visible.
    const { errorCode: _error, ...operation } = project(record)
    parseConversationOperation({ ...operation, state: "applied", result })
    return store.publish(record, { prepared: record.prepared!, result: JSON.stringify(result) })
  }
  return {
    hasUnresolved: () => store.hasUnresolved(stored.sessionId),
    reserve(request: HostRequest, command: ConversationCommand) {
      if (store.byCommand({ principalId: request.principal.principalId, sourceSessionId: stored.sessionId, commandId: command.commandId })) return fail(request, 409, "conversation_operation_exists")
      guard(request, command)
      const id = options.identity.newId(), createdAt = options.identity.now()
      let record: StoredConversationPublication
      try {
        record = store.reserve({ operationId: options.identity.newId(), principalId: request.principal.principalId,
          sourceSessionId: stored.sessionId, commandId: command.commandId, actorId: command.payload.actorId, epoch,
          kind: command.kind === "fork_conversation" ? "fork" : "rewind", createdAt,
          payloadDigest: `sha256:${createHash("sha256").update(JSON.stringify([command.kind, command.payload])).digest("hex")}`,
          ...(command.kind === "fork_conversation" ? { child: { sessionId: id, storageKey: id, profileId: stored.profileId, displayName: "Conversation branch", createdAt, ...(stored.projectContext ? { projectContext: stored.projectContext } : {}) } } : {}),
        })
      } catch { return fail(request, 503, "conversation_publication_unavailable") }
      return {
        commit() { active.add(record.operationId) },
        release() {
          active.delete(record.operationId)
          // Cleanup cannot turn an uncertain durable outcome into rejection.
          // A failed registry read/write leaves its reservation for explicit repair.
          try {
            const current = store.get(record)
            if (current?.phase === "reserved") reject(current, "conversation_not_committed")
          } catch { /* The durable journal remains the recovery authority. */ }
        },
      }
    },
    async execute(request: HostRequest, command: ConversationCommand) {
      const record = store.byCommand({ principalId: request.principal.principalId, sourceSessionId: stored.sessionId, commandId: command.commandId })
      if (!record || record.phase !== "reserved" || record.epoch !== epoch || !active.has(record.operationId)) return fail(request, 409, "conversation_operation_exists")
      const validate = () => guard(request, command)
      try {
        validate()
        const beforeCommit = (prepared: Prepared) => {
          validate()
          store.prepare(record, JSON.stringify(prepared))
        }
        const outcome = command.kind === "fork_conversation"
          ? await options.bridge.forkConversationSession!({ schemaVersion: "conversation.session-fork-command/v1", sourceSessionId: stored.storageKey,
              targetSessionId: record.child!.storageKey, selector: command.payload.selector, occurredAt: new Date(record.createdAt).toISOString() },
              { actorId: record.actorId, beforeSourceRead: async () => validate(), beforeCommit: async ({ generation }) => beforeCommit({ kind: "fork", receipt: projectConversationForkReceipt(generation) }) })
          : await options.bridge.rewindConversationSession!({ schemaVersion: "conversation.session-rewind-command/v1", sessionId: stored.storageKey,
              selector: command.payload.selector, occurredAt: new Date(record.createdAt).toISOString() },
              { actorId: record.actorId, beforeSourceRead: async () => validate(), beforeCommit: async ({ plan }) => beforeCommit({ kind: "rewind", receipt: plan.receipt }) })
        let current = store.get(record)!
        if (outcome.status === "rejected" && current.phase === "reserved") {
          current = reject(current, outcome.rejection.code.toLowerCase())
          return fail(request, 409, JSON.parse(current.result!))
        }
        if (current.phase === "prepared") current = await publishCommitted(request, current, false)
        if (current.phase !== "published") unresolved(current)
        return { actorId: record.actorId, conversation: project(current) }
      } catch (error) {
        active.delete(record.operationId)
        let current: StoredConversationPublication
        try { current = store.get(record)! }
        catch { return unresolved(record) }
        if (!current) return unresolved(record)
        if (current.phase === "prepared") unresolved(current)
        if (current.phase === "published") return { actorId: record.actorId, conversation: project(current) }
        if (current.phase === "reserved") current = reject(current, "conversation_not_committed")
        throw error
      } finally { active.delete(record.operationId) }
    },
    list(request: HostRequest, input: { expectedEpoch: string; limit?: number }) {
      if (input.expectedEpoch !== epoch) return fail(request, 409, "epoch_mismatch")
      if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200)) return fail(request, 400, "invalid_limit")
      const records = store.list({ principalId: request.principal.principalId, sourceSessionId: stored.sessionId, limit: input.limit })
      return { epoch, operations: records.filter(record => options.permits(request, record.actorId, actionFor(record))).map(project) }
    },
    async read(request: HostRequest, input: { expectedEpoch: string; operationId: string; reconcile?: boolean }) {
      if (input.expectedEpoch !== epoch) return fail(request, 409, "epoch_mismatch")
      let record = store.get(scope(request, input.operationId))
      if (!record || !options.permits(request, record.actorId, actionFor(record))) return fail(request, 404, "conversation_operation_not_found")
      if (input.reconcile && record.phase !== "published" && record.phase !== "rejected") {
        options.validate(request, record.actorId, actionFor(record))
        options.requireIdle(request)
        if (active.has(record.operationId)) return fail(request, 409, "conversation_operation_busy")
        if (record.phase === "reserved") record = reject(record, "conversation_not_committed")
        else {
          // Unproven/corrupt owner evidence stays unresolved. No command replay.
          try { record = await publishCommitted(request, record, true) }
          catch (error) { if (error instanceof HostProtocolFailure) throw error }
        }
      }
      return project(record)
    },
  }
}
