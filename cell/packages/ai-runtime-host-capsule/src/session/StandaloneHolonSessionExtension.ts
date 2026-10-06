import { createHash } from "node:crypto"
import path from "node:path"
import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor"
import { getActorWorkContext, invokeAddressedChildExecutionActor, type HolonGenericActorOwnerPort } from "@cell/ai-organ-logic"
import { openLocalHolonTaskRuntime } from "./LocalHolonTaskRuntimeBootstrap"
import { createStandaloneHolonExecutionAdapters } from "./StandaloneHolonExecutionAdapters"
import type { SessionRuntimeExtensionContext } from "./SessionRuntimeAssembly"

// Optional composition extension. Ordinary sessions do not import or open it.
export async function openStandaloneHolonSessionExtension(context: SessionRuntimeExtensionContext) {
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
  return await openLocalHolonTaskRuntime({
    vm,
    supportRoot: path.join(sessionDir, "holon-task-runtime"),
    registryRef: `resource://eidolon.effective-resource-registry/${createHash("sha256")
      .update(workDir)
      .digest("hex")}`,
    resourceRegistry: workflowComponent.resourceRegistry,
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
    createExecutionAdapters: ({ deployment }) => createStandaloneHolonExecutionAdapters({
      deployment,
      executeAddressedAgent: async ({ agentDefinitionRef, resolvedConfig, invocation, sessionRef, idempotencyKey }) => {
        // The invoking tool may already own the interactive turn. Child execution
        // runs through its actor boundary, not behind that same turn's queue.
        const target = holonActorReferences.get(sessionRef)
          ?? recoveredHolonActorReference(sessionRef, agentDefinitionRef)
        const invoked = await invokeAddressedChildExecutionActor(vm, actor, {
          description: `Holon task ${invocation.taskRef}`,
          prompt: JSON.stringify(invocation.input),
          agentType: agentDefinitionRef,
          resolvedConfig,
          toolCallId: idempotencyKey,
          ...(target ? { target } : { sessionId: sessionRef }),
        })
        holonActorReferences.set(sessionRef, invoked.reference)
        activateSessionMaterialization()
        return invoked.output
      },
    }),
  })
}
