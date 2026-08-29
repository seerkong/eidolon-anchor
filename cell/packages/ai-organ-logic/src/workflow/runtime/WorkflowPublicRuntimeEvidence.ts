import type { AiAgentVm } from "@cell/ai-core-logic/runtime/runtime"
import {
  WORKFLOW_PUBLIC_RUNTIME_EVIDENCE_SCHEMA,
  WORKFLOW_PUBLIC_RUNTIME_EVIDENCE_SOURCE,
  type WorkflowPublicNodeExecutionEvidence,
  type WorkflowPublicRuntimeEvidence,
} from "@cell/ai-organ-contract/workflow/WorkflowPublicRuntimeEvidence"

type MutableEvidence = {
  kind: "AICtrlWorkflow" | "AIDataWorkflow"
  definitionRef: string
  instanceId: string
  runId: string
  nodeExecutions: WorkflowPublicNodeExecutionEvidence[]
}

const EVIDENCE = new WeakMap<AiAgentVm, Map<string, MutableEvidence>>()

function requireText(value: string, label: string): string {
  if (!value.trim()) throw new Error(`workflow public evidence requires ${label}`)
  return value
}

function evidenceMap(vm: AiAgentVm): Map<string, MutableEvidence> {
  const existing = EVIDENCE.get(vm)
  if (existing) return existing
  const created = new Map<string, MutableEvidence>()
  EVIDENCE.set(vm, created)
  return created
}

export function recordWorkflowPublicRunEvidence(vm: AiAgentVm, input: Readonly<{
  kind: "AICtrlWorkflow" | "AIDataWorkflow"
  definitionRef: string
  instanceId: string
  runId: string
}>): void {
  const normalized = {
    kind: input.kind,
    definitionRef: requireText(input.definitionRef, "definitionRef"),
    instanceId: requireText(input.instanceId, "instanceId"),
    runId: requireText(input.runId, "runId"),
  }
  const entries = evidenceMap(vm)
  const existing = entries.get(normalized.runId)
  if (existing) {
    if (existing.kind !== normalized.kind
      || existing.definitionRef !== normalized.definitionRef
      || existing.instanceId !== normalized.instanceId) {
      throw new Error(`workflow public evidence identity collision: ${normalized.runId}`)
    }
    return
  }
  entries.set(normalized.runId, { ...normalized, nodeExecutions: [] })
}

export function recordWorkflowPublicNodeExecutionEvidence(vm: AiAgentVm, input: Readonly<{
  kind: "AICtrlWorkflow" | "AIDataWorkflow"
  definitionRef: string
  instanceId: string
  runId: string
  nodeId: string
  actorId: string
  actorKey: string
  agentDefinitionRef: string
}>): void {
  recordWorkflowPublicRunEvidence(vm, input)
  const target = evidenceMap(vm).get(input.runId)!
  const node: WorkflowPublicNodeExecutionEvidence = Object.freeze({
    nodeId: requireText(input.nodeId, "nodeId"),
    actorId: requireText(input.actorId, "actorId"),
    actorKey: requireText(input.actorKey, "actorKey"),
    agentDefinitionRef: requireText(input.agentDefinitionRef, "agentDefinitionRef"),
  })
  const existing = target.nodeExecutions.find((candidate) => candidate.actorId === node.actorId)
  if (existing) {
    if (existing.nodeId !== node.nodeId || existing.actorKey !== node.actorKey
      || existing.agentDefinitionRef !== node.agentDefinitionRef) {
      throw new Error(`workflow public actor evidence collision: ${input.runId}/${node.actorId}`)
    }
    return
  }
  target.nodeExecutions.push(node)
}

export function readWorkflowPublicRuntimeEvidence(vm: AiAgentVm): readonly WorkflowPublicRuntimeEvidence[] {
  return Object.freeze([...evidenceMap(vm).values()].map((entry) => Object.freeze({
    schemaVersion: WORKFLOW_PUBLIC_RUNTIME_EVIDENCE_SCHEMA,
    evidenceSource: WORKFLOW_PUBLIC_RUNTIME_EVIDENCE_SOURCE,
    kind: entry.kind,
    definitionRef: entry.definitionRef,
    instanceId: entry.instanceId,
    runId: entry.runId,
    nodeExecutions: Object.freeze([...entry.nodeExecutions]),
  })))
}
