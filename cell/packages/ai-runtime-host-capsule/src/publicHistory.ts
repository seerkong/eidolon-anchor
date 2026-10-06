import type { AiAgentVm } from "@cell/ai-core-logic/runtime/runtime"
import type { ActorCommittedMessageRef } from "@cell/ai-organ-contract"
import { captureAndSubscribeConversationHistory, getVmConversationDomainRuntime } from "@cell/ai-organ-logic/conversation/ConversationDomainRuntime"
import type { ConversationHistoryRuntimeState, ConversationReadCapture } from "@cell/ai-organ-logic/conversation/ConversationDomainRuntime"
import type { HistoryWindow, HostAuthorizationEffects, HostIdentityEffects, HostRequest, ObservationPayloads } from "@cell/ai-runtime-host-contract"
import { capturePublicHistory, closeHistoryReads, createHistoryReadState, publicHistoryRevision, readPublicContent, readPublicHistory, type HistoryReadRuntime, type PublicHistoryMessage, type PublicHistoryView } from "@cell/ai-runtime-host-logic"
import { createHistoryCursorEffects, createPublicMessageRead, measurePublicMessage, readPublicMessageBytes } from "@cell/ai-runtime-host-support"

type Generation = { id: string; count: number; first?: string; last?: string }
type Descriptor = { actorId: string; generations: Generation[]; count: number; metadataBytes: number }
const byteSize = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
function describe(state: ConversationHistoryRuntimeState): Descriptor {
  const generations: Generation[] = []; let count = 0; let metadataBytes = byteSize(state.actorId) + 256
  for (const generation of state.generations) {
    const item = { id: generation.generationId, count: generation.messages.length, first: generation.messages[0]?.recordId, last: generation.messages.at(-1)?.recordId }
    metadataBytes += byteSize(item); if (metadataBytes > 32 * 1024 * 1024) throw new Error("history_capacity")
    generations.push(item); count += item.count
  }
  return { actorId: state.actorId, generations, count, metadataBytes }
}
function resolves(descriptor: Descriptor, state: ConversationHistoryRuntimeState | undefined): boolean {
  return !!state && descriptor.generations.every(saved => {
    const current = state.generations.find(g => g.generationId === saved.id)
    return !!current && current.messages.length >= saved.count && (!saved.count || current.messages[0]?.recordId === saved.first && current.messages[saved.count - 1]?.recordId === saved.last)
  })
}
function readRecord(record: ActorCommittedMessageRef): PublicHistoryMessage {
  const read = createPublicMessageRead(record)
  return { messageId: read.messageId, totalBytes: () => measurePublicMessage(read), preview: read.preview, bytes: (offset, length) => readPublicMessageBytes(read, offset, length) }
}
export function createPublicHistoryReader(options: {
  vm: AiAgentVm; sessionId: string; epoch: string; authorization: HostAuthorizationEffects; identity: HostIdentityEffects
  limits?: HistoryReadRuntime["limits"]
  onCommitted?: (payload: ObservationPayloads["history.committed"]) => void
  onHistoryReset?: (actorId: string, window: HistoryWindow) => void
  onError?: (error: unknown) => void
}) {
  const owner = getVmConversationDomainRuntime(options.vm)
  if (!owner) throw new Error("conversation_owner_unavailable")
  let closed = false
  // Only lives during one synchronous owner notification. Revision handles retain descriptors, never this state.
  let deliveredCapture: ConversationReadCapture<Readonly<Record<string, ConversationHistoryRuntimeState>>> | undefined
  const belongs = (actorId: string) => Object.values(options.vm.actors).some(actor => actor.id === actorId)
  const find = (actorId: string) => belongs(actorId) ? Object.values(owner.historyStateSignal.get()).find(state => state.actorId === actorId) : undefined
  const capture = (actorId: string): PublicHistoryView | undefined => {
    const lease = deliveredCapture ? undefined : captureAndSubscribeConversationHistory(owner, () => {}, options.onError ?? (() => {}))
    const fence = deliveredCapture ?? lease!.snapshot
    const current = belongs(actorId) ? Object.values(fence.value).find(state => state.actorId === actorId) : undefined
    const revision = fence.revision; lease?.unsubscribe()
    if (!current && !Object.values(options.vm.actors).some(actor => actor.id === actorId)) return undefined
    const descriptor = current ? describe(current) : { actorId, generations: [], count: 0, metadataBytes: 256 }
    let released = false
    return { revision, count: descriptor.count, metadataBytes: descriptor.metadataBytes,
      valid: () => !closed && !released && (descriptor.count === 0 || resolves(descriptor, find(actorId))),
      message(index) {
        const current = find(actorId); if (released || !resolves(descriptor, current)) return undefined
        let offset = index
        for (const saved of descriptor.generations) {
          if (offset < saved.count) { const record = current!.generations.find(g => g.generationId === saved.id)!.messages[offset]; return record ? readRecord(record) : undefined }
          offset -= saved.count
        }
        return undefined
      },
      release() { released = true },
    }
  }
  const runtime: HistoryReadRuntime = { sessionId: options.sessionId, epoch: options.epoch, state: createHistoryReadState(), authorization: options.authorization, identity: options.identity, limits: options.limits,
    effects: { capture, ...createHistoryCursorEffects() } }
  function snapshot(actorId: string): HistoryWindow {
    const registered = capturePublicHistory(runtime, actorId)
    const source = runtime.state.views.get(JSON.stringify([actorId, registered.historyRevision]))!.source
    const messages = []; let remaining = 1024 * 1024
    for (let index = source.count - 1; index >= 0 && messages.length < 200; index--) {
      const read = source.message(index); if (!read) throw new Error("history_cursor_expired")
      const preview = { ...read.preview(256 * 1024, read.totalBytes()), contentRef: { messageId: read.messageId, historyRevision: registered.historyRevision } }
      const size = byteSize(preview); if (size > remaining) break; remaining -= size; messages.unshift(preview)
    }
    return { actorId, historyRevision: registered.historyRevision, messages, historyWindowTruncated: messages.length < source.count }
  }
  const previous = new Map<string, Descriptor>()
  const remember = (next: Descriptor) => {
    const total = [...previous.values()].reduce((n, old) => n + (old.actorId === next.actorId ? 0 : old.metadataBytes), next.metadataBytes)
    if (total > 32 * 1024 * 1024) throw new Error("history_capacity")
    previous.set(next.actorId, next)
  }
  for (const actor of Object.values(options.vm.actors)) previous.set(actor.id, { actorId: actor.id, generations: [], count: 0, metadataBytes: 256 })
  const lease = captureAndSubscribeConversationHistory(owner, event => {
    deliveredCapture = event
    try {
    const seen = new Set<string>()
    for (const state of Object.values(event.value)) {
      if (!belongs(state.actorId)) continue
      seen.add(state.actorId)
      const old = previous.get(state.actorId) ?? { actorId: state.actorId, generations: [], count: 0, metadataBytes: 256 }
      const next = describe(state); remember(next)
      const appendOnly = resolves(old, state) && state.generations.every(g => old.generations.some(saved => saved.id === g.generationId) || ["append", "bootstrap"].includes(g.createdReason))
      if (!appendOnly) { options.onHistoryReset?.(state.actorId, snapshot(state.actorId)); continue }
      const revision = publicHistoryRevision(options.epoch, event.revision)
      for (const generation of state.generations) {
        const count = old.generations.find(saved => saved.id === generation.generationId)?.count ?? 0
        for (let index = count; index < generation.messages.length; index++) {
          const record = generation.messages[index]; const read = readRecord(record)
          // Retain only a revision handle; the contentRef can resolve without retaining the message here.
          capturePublicHistory(runtime, state.actorId)
          const origin = record.message.executionOrigin
          options.onCommitted?.({ actorId: state.actorId, historyRevision: revision,
            message: { ...read.preview(256 * 1024, read.totalBytes()), contentRef: { messageId: read.messageId, historyRevision: revision } },
            ...(typeof origin?.turnId === "string" ? { turnId: origin.turnId } : {}),
            ...(record.message.providerAttemptId ? { attemptId: record.message.providerAttemptId } : {}) })
        }
      }
    }
    for (const [actorId, old] of previous) if (!seen.has(actorId)) {
      if (old.count) {
        previous.set(actorId, { actorId, generations: [], count: 0, metadataBytes: 256 })
        options.onHistoryReset?.(actorId, { actorId, historyRevision: publicHistoryRevision(options.epoch, event.revision), messages: [], historyWindowTruncated: false })
      }
      if (!Object.values(options.vm.actors).some(actor => actor.id === actorId)) previous.delete(actorId)
    }
    } finally { deliveredCapture = undefined }
  }, options.onError ?? (() => {}))
  for (const state of Object.values(lease.snapshot.value)) if (belongs(state.actorId)) remember(describe(state))
  const unsubscribe = lease.unsubscribe
  return {
    capture: (actorId: string) => capturePublicHistory(runtime, actorId), snapshot,
    history: (request: HostRequest, actorId: string, input: { before?: string; limit?: number } = {}) => readPublicHistory(runtime, request, actorId, input),
    content: (request: HostRequest, actorId: string, input: { messageId: string; historyRevision: string; cursor?: string; maxBytes?: number }) => readPublicContent(runtime, request, actorId, input),
    close() { if (closed) return; closed = true; unsubscribe(); closeHistoryReads(runtime); previous.clear() },
    diagnostics: () => ({ views: runtime.state.views.size, metadataBytes: [...runtime.state.views.values()].reduce((n, view) => n + view.source.metadataBytes, 0), closed }),
  }
}
