import { randomUUID } from "node:crypto"

import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { recordAiRuntimeEffectLifecycleEvent } from "@cell/ai-runtime-control-composer"
import type {
  AIWorkflowEffectProvider,
  AIWorkflowEffectRequest,
  AIWorkflowRunEvent,
  AIWorkflowRunRef,
} from "@cell/ai-workflow-contract"
import { spawnChildExecutionActor } from "../../agent/DelegateActor"
import { hashWorkflowSources, type WorkflowAuthoringStore } from "../authoring"
import type { WorkflowFactStore } from "../runtime/WorkflowFactStore"
import type { AiWorkflowForm } from "@cell/ai-workflow-contract"
import type {
  EidolonAppResourceRegistryAdapter,
  EidolonPreparedWorkflowAgentExecution,
} from "../../resources"
import type { WorkflowAgentExecutionFact } from "../runtime/WorkflowLifecycleFacts"

type WorkflowRuntime = AiAgentOneActorRuntime<any, any>

export interface WorkflowMaterialAccess {
  read(materialPath: string): Promise<{ path: string; content: string }>
  write(materialPath: string, content: string): Promise<{ path: string; revision: string }>
}

export type WorkflowAgentResourceBinding = {
  readonly workflowForm: AiWorkflowForm
  readonly resourceRegistry: Pick<EidolonAppResourceRegistryAdapter, "prepareWorkflowAgentExecution">
}

function controlledMaterialPath(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "")
  if (!normalized.startsWith("materials/") || normalized.split("/").some((part) => !part || part === "..")) {
    throw new Error("Workflow material access is restricted to containment-safe materials/** paths")
  }
  return normalized
}

export class StoreBackedWorkflowMaterialAccess implements WorkflowMaterialAccess {
  constructor(private readonly store: WorkflowAuthoringStore) {}

  async read(materialPath: string): Promise<{ path: string; content: string }> {
    const path = controlledMaterialPath(materialPath)
    return { path, content: await this.store.read(path) }
  }

  async write(materialPath: string, content: string): Promise<{ path: string; revision: string }> {
    const path = controlledMaterialPath(materialPath)
    await this.store.writeAtomic(path, content)
    return { path, revision: hashWorkflowSources([{ path, content }]) }
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback
}

function sessionDir(runtime: WorkflowRuntime): string | undefined {
  const value = runtime.vm?.outerCtx?.metadata?.sessionDir
  return typeof value === "string" && value.trim() ? value : undefined
}

function isSameRunAuthority(actual: AIWorkflowRunRef, expected: AIWorkflowRunRef): boolean {
  return actual === expected
    && actual.runId === expected.runId
    && actual.generation === expected.generation
    && actual.parentGeneration === expected.parentGeneration
    && actual.workflow.ref === expected.workflow.ref
    && actual.workflow.scheme === expected.workflow.scheme
    && actual.workflow.fqn === expected.workflow.fqn
    && actual.workflow.revision === expected.workflow.revision
}

export class EidolonWorkflowEffectProvider implements AIWorkflowEffectProvider {
  constructor(
    private readonly runtime: WorkflowRuntime,
    private readonly materials: WorkflowMaterialAccess,
    private readonly facts: WorkflowFactStore,
    private readonly onMaterialWrite: ((
      request: AIWorkflowEffectRequest,
      output: { path: string; revision: string },
    ) => Promise<void>) | undefined,
    private readonly resolveRunAuthority: () => AIWorkflowRunRef,
    private readonly agentResources?: WorkflowAgentResourceBinding,
  ) {}

  async invoke<Input = unknown, Output = unknown>(request: AIWorkflowEffectRequest<Input>): Promise<Output> {
    if (!request?.run || typeof request.run.runId !== "string" || !request.run.runId.trim()) {
      throw new Error("Workflow effect request requires run.runId from the active runtime capability")
    }
    const activeRun = this.resolveRunAuthority()
    if (!isSameRunAuthority(request.run, activeRun)) {
      throw new Error("Workflow effect request run does not match active runtime run authority")
    }
    const eventBase = {
      runId: request.run.runId,
      generation: request.run.generation,
      nodeId: request.nodeId,
      atMs: Date.now(),
    }
    await this.appendEvent(request, {
      ...eventBase,
      eventId: randomUUID(),
      type: "workflow.effect.requested",
      payload: { effectId: request.effectId, operation: request.operation },
    })
    await this.recordLifecycle(request, {
      kind: "request",
      effectKind: "tool_call",
      effectId: request.effectId,
      handlerKey: `workflow:${request.operation}`,
      idempotencyKey: request.effectId,
      payload: { run: request.run, nodeId: request.nodeId, input: request.input, config: request.config },
    })

    try {
      const output = await this.dispatch(request)
      if (request.operation === "material.write" && this.onMaterialWrite) {
        const materialOutput = record(output)
        await this.onMaterialWrite(request, {
          path: text(materialOutput.path),
          revision: text(materialOutput.revision),
        })
      }
      await this.appendEvent(request, {
        ...eventBase,
        eventId: randomUUID(),
        type: "workflow.effect.completed",
        atMs: Date.now(),
        payload: { effectId: request.effectId, operation: request.operation, output },
      })
      await this.recordLifecycle(request, {
        kind: "result",
        effectKind: "tool_call",
        effectId: request.effectId,
        handlerKey: `workflow:${request.operation}`,
        resultId: `${request.effectId}:result`,
        payload: output,
      })
      return output as Output
    } catch (error) {
      const message = String((error as Error)?.message ?? error)
      await this.appendEvent(request, {
        ...eventBase,
        eventId: randomUUID(),
        type: "workflow.effect.failed",
        atMs: Date.now(),
        payload: { effectId: request.effectId, operation: request.operation, error: message },
      })
      await this.recordLifecycle(request, {
        kind: "failed",
        effectKind: "tool_call",
        effectId: request.effectId,
        handlerKey: `workflow:${request.operation}`,
        error: message,
        retryable: false,
      })
      throw error
    }
  }

  private async dispatch(request: AIWorkflowEffectRequest): Promise<unknown> {
    const input = record(request.input)
    const config = record(request.config)
    switch (request.operation) {
      case "identity":
        return request.input
      case "tool.call": {
        const toolName = text(input.toolName ?? input.tool_name ?? input.name, text(config.toolName ?? config.tool_name))
        if (!toolName) throw new Error("tool.call requires input.toolName")
        const args = input.args ?? input.input ?? {}
        return ToolFuncRegistry.call(
          this.runtime.vm.registries.toolRegistry,
          toolName,
          this.runtime.vm,
          this.runtime.actor,
          args,
          { toolCallId: request.effectId, signal: request.signal },
        )
      }
      case "ai.agent": {
        if (request.run.workflow.scheme === "resource") {
          return this.dispatchResourceAgent(request, input, config)
        }
        const agentType = text(input.agentType ?? input.agent_type, text(config.agentType ?? config.agent_type, "code"))
        const prompt = text(input.prompt, typeof request.input === "string" ? request.input : JSON.stringify(request.input, null, 2))
        return spawnChildExecutionActor(this.runtime.vm, this.runtime.actor, {
          description: text(input.description, `Workflow node ${request.nodeId ?? request.effectId}`),
          prompt,
          agentType,
          mode: "sync_wait",
          toolCallId: request.effectId,
        })
      }
      case "material.read": {
        const materialPath = text(input.path ?? input.materialPath ?? config.path)
        if (!materialPath) throw new Error("material.read requires input.path")
        return this.materials.read(materialPath)
      }
      case "material.write": {
        const materialPath = text(input.path ?? input.materialPath ?? config.path)
        if (!materialPath) throw new Error("material.write requires input.path")
        const content = typeof input.content === "string" ? input.content : JSON.stringify(input.content ?? "", null, 2)
        return this.materials.write(materialPath, content)
      }
      default:
        throw new Error(`Unsupported Eidolon workflow effect operation: ${request.operation}`)
    }
  }

  private async dispatchResourceAgent(
    request: AIWorkflowEffectRequest,
    input: Record<string, unknown>,
    config: Record<string, unknown>,
  ): Promise<string> {
    if (!this.agentResources) {
      throw new Error("Resource workflow Agent execution requires a bound resource registry")
    }
    const agentDefinitionRef = selectExactAgentDefinitionRef(input, config)
    const nodeId = typeof request.nodeId === "string" ? request.nodeId : ""
    if (!nodeId || nodeId !== nodeId.trim()) {
      throw new Error("Resource workflow ai.agent requires an exact nodeId")
    }
    let prepared: EidolonPreparedWorkflowAgentExecution
    const existing = await this.facts.loadAgentExecutionFact(
      request.run.runId,
      request.run.generation,
      request.effectId,
    )
    if (existing) {
      assertSameAgentExecutionFact(existing, {
        workflowForm: this.agentResources.workflowForm,
        workflowRef: request.run.workflow.ref,
        nodeId,
        agentDefinitionRef,
      })
      prepared = Object.freeze({ plan: existing.plan, receipt: existing.resourceReceipt })
    } else {
      prepared = await this.agentResources.resourceRegistry.prepareWorkflowAgentExecution({
        workflowKind: this.agentResources.workflowForm,
        workflowRef: request.run.workflow.ref as `resource://${string}`,
        nodeId,
        agentDefinitionRef,
      })
      if (prepared.plan.agentDefinitionRef !== agentDefinitionRef) {
        throw new Error("Prepared resource Agent plan does not match the requested Agent definition")
      }
      const fact: WorkflowAgentExecutionFact = {
        schemaVersion: "eidolon.workflow-agent-execution-fact/v1",
        runId: request.run.runId,
        generation: request.run.generation,
        effectId: request.effectId,
        nodeId,
        workflowForm: this.agentResources.workflowForm,
        workflowRef: request.run.workflow.ref,
        agentDefinitionRef,
        plan: prepared.plan,
        resourceReceipt: prepared.receipt,
        createdAt: Date.now(),
      }
      await this.facts.saveAgentExecutionFact(fact)
    }
    const prompt = text(
      input.prompt,
      typeof request.input === "string" ? request.input : JSON.stringify(request.input, null, 2),
    )
    return spawnChildExecutionActor(this.runtime.vm, this.runtime.actor, {
      description: text(input.description, `Workflow node ${nodeId}`),
      prompt,
      agentType: agentDefinitionRef,
      resolvedConfig: prepared.plan.agentConfig,
      mode: "sync_wait",
      toolCallId: request.effectId,
    })
  }

  private appendEvent(request: AIWorkflowEffectRequest, event: AIWorkflowRunEvent): Promise<void> {
    return this.facts.appendRunEvent(request.run, event)
  }

  private async recordLifecycle(
    _request: AIWorkflowEffectRequest,
    event: Parameters<typeof recordAiRuntimeEffectLifecycleEvent>[0]["event"],
  ): Promise<void> {
    const root = sessionDir(this.runtime)
    if (root) await recordAiRuntimeEffectLifecycleEvent({ sessionDir: root, event })
  }
}

function selectExactAgentDefinitionRef(
  input: Record<string, unknown>,
  config: Record<string, unknown>,
): `resource://${string}` {
  const values = [input.agentDefinitionRef, config.agentDefinitionRef]
    .filter((value): value is string => typeof value === "string")
  const unique = [...new Set(values)]
  if (unique.length !== 1) {
    throw new Error("Resource workflow ai.agent requires one exact agentDefinitionRef")
  }
  const value = unique[0]!
  const prefix = "resource://"
  if (value !== value.trim() || !value.startsWith(prefix)) {
    throw new Error("Resource workflow ai.agent requires one exact agentDefinitionRef")
  }
  const id = value.slice(prefix.length)
  if (!id || id !== id.trim() || id.includes("://")) {
    throw new Error("Resource workflow ai.agent requires one exact agentDefinitionRef")
  }
  return value as `resource://${string}`
}

function assertSameAgentExecutionFact(
  fact: WorkflowAgentExecutionFact,
  expected: {
    workflowForm: AiWorkflowForm
    workflowRef: string
    nodeId: string
    agentDefinitionRef: `resource://${string}`
  },
): void {
  if (fact.workflowForm !== expected.workflowForm
    || fact.workflowRef !== expected.workflowRef
    || fact.nodeId !== expected.nodeId
    || fact.agentDefinitionRef !== expected.agentDefinitionRef
    || fact.resourceReceipt.task.workflowKind !== expected.workflowForm
    || fact.resourceReceipt.task.workflowRef !== expected.workflowRef
    || fact.resourceReceipt.task.nodeId !== expected.nodeId
    || fact.resourceReceipt.task.agentDefinitionRef !== expected.agentDefinitionRef
    || fact.plan.agentDefinitionRef !== expected.agentDefinitionRef) {
    throw new Error("Workflow Agent execution fact does not match the active effect authority")
  }
}
