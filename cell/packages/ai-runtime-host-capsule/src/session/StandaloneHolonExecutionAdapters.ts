import type { AgentConfig } from "@cell/ai-core-contract/runtime/AgentConfig"
import type { MaterializedHolonDeploymentDefinition } from "@cell/ai-organ-logic/organization/HolonDeploymentDefinition"
import type { HolonExecutionAdapterInput, HolonExecutionAdapterPorts } from "@cell/ai-organ-logic/organization/HolonLocalActorRuntime"

export interface StandaloneHolonExecutionRuntime {
  readonly deployment: MaterializedHolonDeploymentDefinition
  readonly executeAddressedAgent: (input: HolonExecutionAdapterInput & Readonly<{
    agentDefinitionRef: `resource://${string}`
    resolvedConfig: AgentConfig
  }>) => ReturnType<HolonExecutionAdapterPorts["aiAgent"]["executeIdempotent"]>
}

export function createStandaloneHolonExecutionAdapters(runtime: StandaloneHolonExecutionRuntime): HolonExecutionAdapterPorts {
  return Object.freeze({
    aiAgent: {
      async executeIdempotent(input: HolonExecutionAdapterInput) {
        if (input.binding.binding.adapter.kind !== "ai-agent") throw new Error("EIDOLON_HOLON_AI_ADAPTER_BINDING_MISMATCH")
        const agentDefinitionRef = input.binding.binding.adapter.agentDefinitionRef
        const plan = await runtime.deployment.materializeAgentExecutionPlan(agentDefinitionRef, {
          scope: "standalone", payload: input.invocation.input,
        })
        return runtime.executeAddressedAgent({ ...input, agentDefinitionRef, resolvedConfig: plan.agentConfig })
      },
    },
    humanEndpoint: { executeIdempotent() { throw new Error("EIDOLON_HOLON_HUMAN_ENDPOINT_NOT_BOUND") } },
    service: { executeIdempotent() { throw new Error("EIDOLON_HOLON_SERVICE_ADAPTER_NOT_BOUND") } },
    hybrid: { executeIdempotent() { throw new Error("EIDOLON_HOLON_HYBRID_ADAPTER_NOT_BOUND") } },
  })
}
