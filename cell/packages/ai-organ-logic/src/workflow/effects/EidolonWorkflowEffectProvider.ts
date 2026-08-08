import { randomUUID } from "node:crypto"

import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { recordAiRuntimeEffectLifecycleEvent } from "@cell/ai-runtime-control-composer"
import type {
  AIWorkflowEffectProvider,
  AIWorkflowEffectRequest,
  AIWorkflowRunEvent,
} from "@cell/ai-workflow-contract"
import { spawnChildExecutionActor } from "../../agent/DelegateActor"
import { hashWorkflowSources, type WorkflowAuthoringStore } from "../authoring"
import type { WorkflowFactStore } from "../runtime/WorkflowFactStore"

type WorkflowRuntime = AiAgentOneActorRuntime<any, any>

export interface WorkflowMaterialAccess {
  read(materialPath: string): Promise<{ path: string; content: string }>
  write(materialPath: string, content: string): Promise<{ path: string; revision: string }>
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

export class EidolonWorkflowEffectProvider implements AIWorkflowEffectProvider {
  constructor(
    private readonly runtime: WorkflowRuntime,
    private readonly materials: WorkflowMaterialAccess,
    private readonly facts: WorkflowFactStore,
    private readonly onMaterialWrite?: (
      request: AIWorkflowEffectRequest,
      output: { path: string; revision: string },
    ) => Promise<void>,
  ) {}

  async invoke<Input = unknown, Output = unknown>(request: AIWorkflowEffectRequest<Input>): Promise<Output> {
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
