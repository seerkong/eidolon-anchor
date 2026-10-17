import { createHash } from "node:crypto"
import path from "node:path"
import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor"
import { getActorWorkContext, invokeAddressedChildExecutionActor, type HolonGenericActorOwnerPort } from "@cell/ai-organ-logic"
import { openLocalHolonTaskRuntime,type OpenLocalHolonTaskRuntimeInput } from "./LocalHolonTaskRuntimeBootstrap"
import type {EidolonAppResourceRegistryAdapter} from '@cell/ai-organ-logic/resources'
import { createStandaloneHolonExecutionAdapters, type StandaloneHolonExecutionRuntime } from "./StandaloneHolonExecutionAdapters"
import type { SessionRuntimeExtensionContext } from "./SessionRuntimeAssembly"
import type { HolonExecutionAdapterInput } from '@cell/ai-organ-logic/organization/HolonLocalActorRuntime'
import { executeAdmittedLeaderLedHolon } from '@cell/ai-organ-logic/organization/AdmittedLeaderLedHolonExecution'
import type { ParticipantConversation } from '../participantConversation'

export type StandaloneHolonSessionOptions = Readonly<{
  supportRoot?:string
  resourceRegistry?:EidolonAppResourceRegistryAdapter
  storageFactory?:OpenLocalHolonTaskRuntimeInput['storageFactory']
  automaticPump?:OpenLocalHolonTaskRuntimeInput['automaticPump']
  prepareManagedTask?:OpenLocalHolonTaskRuntimeInput['prepareManagedTask']
  recoverPending?: boolean
  allowHumanInput?: boolean
  /** Trusted execution container shutdown; preserve unresolved task/journal facts. */
  executionInterrupted?: () => boolean
  executionConversation?: (input: HolonExecutionAdapterInput) => ParticipantConversation
  prepareRetainedActor?:(actorId:string)=>Promise<void>
  onActorAdmitted?: (input: HolonExecutionAdapterInput, reference: Awaited<ReturnType<typeof invokeAddressedChildExecutionActor>>['reference']) => void
  onExecutionCompleted?: (input: HolonExecutionAdapterInput) => Promise<void>
}>

// Optional composition extension. Ordinary sessions do not import or open it.
export async function openStandaloneHolonSessionExtension(context: SessionRuntimeExtensionContext, options: StandaloneHolonSessionOptions = {}) {
  const { vm, actor, sessionDir, workDir, workflowComponent, activateSessionMaterialization } = context
  const holonActorReferences = new Map<
    string,
    Awaited<ReturnType<typeof invokeAddressedChildExecutionActor>>["reference"]
  >()
  const stableHolonRef = (kind: string, value: unknown): string => (
    `${kind}-${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 40)}`
  )
  const recoveredHolonActorReference = (
    sessionRef: string,
    agentDefinitionRef: string,
  ) => {
    for (const candidate of Object.values(vm.actors) as AiAgentActor[]) {
      if (!candidate || candidate.agentName !== agentDefinitionRef) continue
      const work = getActorWorkContext(candidate)
      if (work.sessionId !== sessionRef) continue
      return Object.freeze({
        authority: "eidolon.actor-runtime/v1" as const,
        actorKey: candidate.key,
        actorId: candidate.id,
        sessionId: sessionRef,
        agentDefinitionRef,
      })
    }
    return undefined
  }
  async function executeOriginalAddressedAgent(input: Parameters<StandaloneHolonExecutionRuntime['executeAddressedAgent']>[0]): Promise<string> {
    const { agentDefinitionRef, resolvedConfig, invocation, sessionRef, idempotencyKey } = input
    // Child execution owns its own driver even when the invoking tool owns the interactive turn.
    const target = holonActorReferences.get(sessionRef) ?? recoveredHolonActorReference(sessionRef, agentDefinitionRef)
    if (target) await options.prepareRetainedActor?.(target.actorId)
    const conversation = target ? undefined : options.executionConversation?.(input)
    const executionConfig = conversation?.messages.length ? {
      ...resolvedConfig,
      seedMessages: [...(resolvedConfig.seedMessages ?? resolvedConfig.prompt.map(content => ({ role: 'system' as const, content }))), ...conversation.messages],
    } : resolvedConfig
    try {
      const invoked = await invokeAddressedChildExecutionActor(vm, actor, {
        description: `Holon task ${invocation.taskRef}`,
        prompt: JSON.stringify(invocation.input),
        agentType: agentDefinitionRef,
        resolvedConfig: executionConfig,
        ...(conversation ? { durableMaterials: conversation.durableMaterials } : {}),
        toolCallId: idempotencyKey,
        allowHumanInput: options.allowHumanInput,
        signal: input.signal,
        onActorAdmitted(reference) {
          holonActorReferences.set(sessionRef, reference)
          options.onActorAdmitted?.(input, reference)
        },
        ...(target ? { target } : { sessionId: sessionRef }),
      })
      holonActorReferences.set(sessionRef, invoked.reference)
      activateSessionMaterialization()
      return invoked.output
    } catch(error) {
      if(options.executionInterrupted?.())throw Object.assign(new Error('Owned execution container interrupted'),{code:'EIDOLON_HOLON_EXECUTION_INTERRUPTED'})
      throw error
    } finally {
      await options.onExecutionCompleted?.(input)
    }
  }
  return await openLocalHolonTaskRuntime({
    vm,
    supportRoot: options.supportRoot??path.join(sessionDir, "holon-task-runtime"),
    registryRef: `resource://eidolon.effective-resource-registry/${createHash("sha256")
      .update(workDir)
      .digest("hex")}`,
    resourceRegistry: options.resourceRegistry??workflowComponent.resourceRegistry,
    recoverPending: options.recoverPending,
    storageFactory:options.storageFactory,
    automaticPump:options.automaticPump,
    prepareManagedTask:options.prepareManagedTask,
    createGenericActorOwner: ({ admission }) => {
      const owner: HolonGenericActorOwnerPort = {
        ensureActor: ({ address }) => Object.freeze({
          actorRef: stableHolonRef("holon-actor", address),
        }),
        ensureTaskAttemptSession: (input) => Object.freeze({
          sessionRef: stableHolonRef("holon-task-session", {
            deploymentId: input.deploymentId,
            runtimeRef: input.runtimeRef,
            scopeRef: input.scopeRef,
            taskAttempt: input.taskAttempt,
          }),
        }),
        resolveTargetedAgentSession: ({ bindingReceipt, selector }) => {
          if (bindingReceipt.agentProofs.length !== 1) {
            throw new Error("EIDOLON_HOLON_TARGETED_AGENT_SESSION_AMBIGUOUS")
          }
          const agentDefinitionRef = bindingReceipt.agentProofs[0]!.agentDefinitionRef
          return Object.freeze({
            sessionRef: stableHolonRef("holon-targeted-session", {
              admissionId: admission.admission.admissionId,
              selector,
              agentDefinitionRef,
            }),
            agentDefinitionRef,
          })
        },
      }
      return Object.freeze(owner)
    },
    createExecutionAdapters: async ({ deployment }) => {
      const frozen = await deployment.resourceRegistry.snapshot()
      const definitions = frozen.holonTaskRuntimeDefinitions.filter(p => p.bindingProjection.binding.bindingRef === deployment.definition.bindingRef)
      const policy = definitions.find(p => p.governance)?.governance
      if (policy && definitions.some(p => JSON.stringify(p.governance) !== JSON.stringify(policy))) {
        throw new Error('EIDOLON_HOLON_GOVERNANCE_BINDING_AMBIGUOUS')
      }
      return createStandaloneHolonExecutionAdapters({
        deployment,
        executeAddressedAgent(input) {
          if (!policy) return executeOriginalAddressedAgent(input)
          return executeAdmittedLeaderLedHolon({
            vm, initiator: actor, policy, execution: input,
            proof: {
              bindingRef: deployment.definition.bindingRef,
              semanticFingerprint: deployment.bindingFreezeReceipt.semanticFingerprint,
            },
            executeLeader: () => executeOriginalAddressedAgent(input),
            checkpoint: async () => {
              activateSessionMaterialization()
              await context.persistSnapshot()
            },
          })
        },
      })
    },
  })
}
