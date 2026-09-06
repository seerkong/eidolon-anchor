import type { AIDataWorkflowRunGraph, AIDataWorkflowGraphPatchOperation } from "ai-data-workflow-contract"
import { applyAIDataWorkflowGraphPatch } from "ai-data-workflow-logic"
import type { AIAgentTaskRequirement, FlowRunStepExtensions } from "ai-workflow-contract"
import { normalizeAIAgentTaskRequirement } from "ai-workflow-logic"
import type { DefinitionStepExtensionCodecRegistryPort, DefinitionStepValue } from "flow-step-space-contract"
import type { AIDataPreparedAgentCapabilityInput, AIDataPreparedAgentResource } from "./AIDataAgentResourcePreparation"
import { findAIDataAutonomousControlStateInExtensions, normalizeAIDataAutonomousControlState, writeAIDataAutonomousControlExtension, type AIDataExecutionFailure } from "./AIDataAutonomousControlLoop"
export type { AIDataExecutionFailure } from "./AIDataAutonomousControlLoop"

export const AI_DATA_CHILD_AGENT_PREPARATION_EXTENSION_KIND = "eidolon.ai-data-child-agent-preparation" as const
export const AI_DATA_CHILD_AGENT_PREPARATION_SCHEMA_REF = "schema://eidolon.ai-data-child-agent-preparation/v1" as const

/** Frozen child resource policy; the selection itself remains an Agent decision. */
export type AIDataChildAgentPreparationDeclaration = Readonly<{
  schemaVersion: "eidolon.ai-data-child-agent-preparation/v1"
  sourceNodeInput: string
  nodeId: string
  instanceName: string
  requirement: AIAgentTaskRequirement
  capability: AIDataPreparedAgentCapabilityInput
}>

export function normalizeAIDataChildAgentPreparationDeclaration(value: unknown): AIDataChildAgentPreparationDeclaration {
  const parsed = typeof value === "string" ? JSON.parse(value) : value
  const declaration = object(parsed)
  if (Object.keys(declaration).sort().join(",") !== "capability,instanceName,nodeId,requirement,schemaVersion,sourceNodeInput"
    || declaration.schemaVersion !== "eidolon.ai-data-child-agent-preparation/v1") {
    throw new Error("AI_DATA_CHILD_AGENT_PREPARATION_DECLARATION_INVALID")
  }
  for (const field of ["sourceNodeInput", "nodeId", "instanceName"]) exactString(declaration[field])
  normalizeAIAgentTaskRequirement(declaration.requirement as AIAgentTaskRequirement)
  const capability = object(declaration.capability)
  if (Object.keys(capability).sort().join(",") !== "capabilityId,fixedConfig,inputSchemaRefs,outputSchemaRefs,tag"
    || !["TransformNode", "SinkNode"].includes(String(capability.tag))) {
    throw new Error("AI_DATA_CHILD_AGENT_PREPARATION_CAPABILITY_INVALID")
  }
  exactString(capability.capabilityId)
  for (const refs of [capability.inputSchemaRefs, capability.outputSchemaRefs]) {
    for (const [port, ref] of Object.entries(object(refs))) { exactString(port); exactString(ref) }
  }
  const config = object(capability.fixedConfig)
  if (config.agent !== undefined || config.preparedAgent !== undefined || config.instanceName !== undefined) {
    throw new Error("AI_DATA_CHILD_AGENT_PREPARATION_CONFIG_RESERVED")
  }
  return Object.freeze(JSON.parse(JSON.stringify(declaration)))
}

export function createAIDataChildAgentPreparationExtensionCodecRegistry(
  fallback?: DefinitionStepExtensionCodecRegistryPort,
): DefinitionStepExtensionCodecRegistryPort {
  return Object.freeze({ resolve: (kind: string) => kind === AI_DATA_CHILD_AGENT_PREPARATION_EXTENSION_KIND
    ? { schemaRef: AI_DATA_CHILD_AGENT_PREPARATION_SCHEMA_REF, codec: {
        normalize: (value: DefinitionStepValue) => normalizeAIDataChildAgentPreparationDeclaration(value) as unknown as DefinitionStepValue,
      } }
    : fallback?.resolve(kind) })
}

export function readAIDataChildAgentPreparationDeclaration(
  extensions: FlowRunStepExtensions | undefined,
): AIDataChildAgentPreparationDeclaration | undefined {
  const slots = Object.values(extensions?.byStepId ?? {}).flatMap(byKind => {
    const fact = byKind[AI_DATA_CHILD_AGENT_PREPARATION_EXTENSION_KIND]
    if (!fact) return []
    if (fact.schemaRef !== AI_DATA_CHILD_AGENT_PREPARATION_SCHEMA_REF) throw new Error("AI_DATA_CHILD_AGENT_PREPARATION_SCHEMA_MISMATCH")
    return [normalizeAIDataChildAgentPreparationDeclaration(fact.value)]
  })
  if (slots.length > 1) throw new Error("AI_DATA_CHILD_AGENT_PREPARATION_SLOT_DUPLICATE")
  return slots[0]
}

/** Resolve only explicitly declared slots, using the immutable prepared task receipt. */
export function bindAIDataPreparedAgentSlots(
  graph: AIDataWorkflowRunGraph,
  prepared: readonly AIDataPreparedAgentResource[],
): AIDataWorkflowRunGraph {
  const operations: AIDataWorkflowGraphPatchOperation[] = []
  for (const node of Object.values(graph.nodes)) {
    if (node.config.preparedAgent === undefined) continue
    const capabilityId = exactString(node.config.preparedAgent)
    const item = prepared.find(value => value.receipt.task.nodeId === node.id
      && value.receipt.capability.capabilityId === capabilityId)
    if (!item || item.receipt.capability.tag !== node.tag || node.config.agent !== undefined) {
      throw new Error(`AI_DATA_CHILD_AGENT_PREPARATION_SLOT_UNBOUND: ${node.id}`)
    }
    const capability = item.receipt.capability
    const inputPorts = Object.keys(capability.inputSchemaRefs).sort()
    const outputPorts = Object.keys(capability.outputSchemaRefs).sort()
    if (JSON.stringify(Object.keys(node.inputs).sort()) !== JSON.stringify(inputPorts)
      || JSON.stringify([...node.outputs].sort()) !== JSON.stringify(outputPorts)) {
      throw new Error(`AI_DATA_CHILD_AGENT_PREPARATION_SLOT_CONTRACT_MISMATCH: ${node.id}`)
    }
    const { preparedAgent: _slot, ...config } = node.config
    operations.push({ op: "update-node", nodeId: node.id, changes: { nodeType: "agent", config: {
      ...config, ...capability.fixedConfig,
      preparationReceiptDigest: item.receipt.receiptDigest,
      agent: { agentDefinitionRef: item.receipt.agentDefinitionRef, taskProofRef: item.receipt.taskProofRef },
    } } })
  }
  return operations.length === 0 ? graph : applyAIDataWorkflowGraphPatch(graph, {
    patchId: `prepared-agents:${graph.runId}`, generation: graph.currentGeneration + 1, operations,
  })
}

/** Historical observations live in the existing autonomous checkpoint extension. */
export function writeAIDataExecutionFailures(
  extensions: FlowRunStepExtensions | undefined,
  failures: readonly AIDataExecutionFailure[],
): FlowRunStepExtensions | undefined {
  const state = findAIDataAutonomousControlStateInExtensions(extensions)
  if (!state || failures.length === 0) return extensions
  const prior = state.executionFailures ?? []
  const byAttempt = new Map([...prior, ...failures].map(failure => [`${failure.nodeId}#${failure.generation}`, failure]))
  return writeAIDataAutonomousControlExtension(extensions, normalizeAIDataAutonomousControlState({ ...state,
    executionFailures: [...byAttempt.values()],
  }))
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("AI_DATA_CHILD_AGENT_PREPARATION_OBJECT_REQUIRED")
  return value as Record<string, unknown>
}

function exactString(value: unknown): string {
  if (typeof value !== "string" || !value || value !== value.trim()) throw new Error("AI_DATA_CHILD_AGENT_PREPARATION_IDENTITY_INVALID")
  return value
}
