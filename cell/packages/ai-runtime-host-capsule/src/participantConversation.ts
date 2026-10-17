import type { AgentSeedMessage } from '@cell/ai-core-contract/runtime/AgentConfig'
import type { ActorDurableMaterialIndex } from '@cell/ai-core-contract/runtime/ActorDurableMaterial'
import type { ParticipantContextCut } from '@cell/ai-runtime-host-contract'
import { createActorDurableMaterial } from '@cell/ai-core-logic/runtime/ActorDurableMaterial'

export type ParticipantConversation = Readonly<{
  messages: readonly AgentSeedMessage[]; durableMaterials: ActorDurableMaterialIndex
}>

/** Supplied statements retain their speakers; peers never become this Actor's assistant history. */
export function projectParticipantConversation(cut: ParticipantContextCut): ParticipantConversation {
  const bytes = new TextEncoder().encode(JSON.stringify(cut))
  if (cut.schemaVersion !== 'bridge.im-context/v1' || bytes.length > 128 * 1024 || cut.messages.length > 4096)
    throw new Error('execution_context_capacity')
  const messages: AgentSeedMessage[] = cut.messages.map(message => ({ role: 'user', content:
    `[IM statement ${message.messageId}; speaker ${message.sender.name} (${message.sender.kind}:${message.sender.ref}); addressed to ${message.addressedRefs.join(', ') || 'all'}${message.sender.source ? `; source ${message.sender.source.endpointId} / ${message.sender.source.ownerScopeRef}` : ''}${message.replyTo ? `; reply to ${message.replyTo}` : ''}]\n${message.text}` }))
  if (cut.purpose) messages.unshift({ role: 'user', content: `[Conversation purpose]\n${cut.purpose}` })
  const material = createActorDurableMaterial(bytes, 'application/vnd.bridge.im-context+json')
  return { messages, durableMaterials: { [material.digest]: material } }
}
