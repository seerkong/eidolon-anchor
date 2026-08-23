import { randomUUID } from "node:crypto"

import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { recordAiRuntimeEffectLifecycleEvent } from "@cell/ai-runtime-control-composer"
import { readRuntimeControlEffectEvidence } from "@cell/ai-file-store-logic"
import { normalizeFlowClosedValue } from "ai-workflow-logic"
import type { AiRuntimeEffectLifecycleEvent } from "@cell/ai-runtime-control-contract"
import type {
  AIWorkflowEffectProvider,
  AIWorkflowEffectRequest,
  AIAgentHostEffectPort,
  AIAgentHostRunRequest,
  AIAgentHostRunResult,
  AIAgentHostTargetedRunRequest,
  AIWorkflowRunEvent,
  AIWorkflowRunRef,
} from "@cell/ai-workflow-contract"
import {
  invokeAddressedChildExecutionActor,
  spawnChildExecutionActor,
  type AddressedChildExecutionReference,
} from "../../agent/DelegateActor"
import { hashWorkflowSources, type WorkflowAuthoringStore } from "../authoring"
import type { WorkflowFactStore } from "../runtime/WorkflowFactStore"
import type { AiWorkflowForm } from "@cell/ai-workflow-contract"
import type {
  EidolonAppResourceRegistryAdapter,
  EidolonPreparedWorkflowAgentExecution,
} from "../../resources"
import { normalizeAgentExecutionValue, projectAgentExecutionOutput } from "../../agent/AgentExecutionContract"
import type { WorkflowStepExtensionAuthoredFacade } from "./WorkflowStepExtensionAuthoredFacade"

export type { WorkflowStepExtensionAuthoredFacade } from "./WorkflowStepExtensionAuthoredFacade"

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
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "")
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

export class EidolonWorkflowEffectProvider implements AIWorkflowEffectProvider, AIAgentHostEffectPort {
  private readonly resourceAgentInvocations = new Map<string, Promise<unknown>>()

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
    private readonly stepExtensions?: WorkflowStepExtensionAuthoredFacade,
  ) {}

  mutateRunStepExtension(
    selector: Parameters<WorkflowStepExtensionAuthoredFacade["mutateRunStepExtension"]>[0],
    invocation: Parameters<WorkflowStepExtensionAuthoredFacade["mutateRunStepExtension"]>[1],
    config: Parameters<WorkflowStepExtensionAuthoredFacade["mutateRunStepExtension"]>[2],
  ) {
    if (!this.stepExtensions) throw new Error("Workflow StepExtension mutation capability is not bound")
    return this.stepExtensions.mutateRunStepExtension(selector, invocation, config)
  }

  runAgent(request: AIAgentHostRunRequest): Promise<AIAgentHostRunResult> {
    return this.runTypedAgent(request)
  }

  runTargetedAgent(request: AIAgentHostTargetedRunRequest): Promise<AIAgentHostRunResult> {
    return this.runTypedAgent(request, request.instance)
  }

  private async runTypedAgent(
    request: AIAgentHostRunRequest,
    target?: AIAgentHostTargetedRunRequest["instance"],
  ): Promise<AIAgentHostRunResult> {
    const active = this.resolveRunAuthority()
    if (active.runId !== request.runId) throw new Error("Typed Agent request does not match active run authority")
    const effectId = `agent:${request.flowInstanceId}:${request.runId}:${request.invocationKey}`
    const hostConfig = normalizeFlowClosedValue({
      typedHost: true,
      ...(request.instanceName === undefined ? {} : { instanceName: request.instanceName }),
      ...(request.materialRefs === undefined ? {} : { materialRefs: request.materialRefs }),
      ...(request.effectPolicy === undefined ? {} : { effectPolicy: request.effectPolicy }),
      ...(request.metadata === undefined ? {} : { invocationMetadata: request.metadata }),
      ...(target === undefined ? {} : { targetInstance: target }),
    }, "typedAgent.hostConfig") as NonNullable<AIWorkflowEffectRequest["config"]>
    return await this.invoke({
      run: active,
      effectId,
      operation: "ai.agent",
      nodeId: request.nodeId,
      input: { agentDefinitionRef: request.agentDefinitionRef, payload: request.input },
      config: hostConfig,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
  }

  async invoke<Input = unknown, Output = unknown>(request: AIWorkflowEffectRequest<Input>): Promise<Output> {
    if (!request?.run || typeof request.run.runId !== "string" || !request.run.runId.trim()) {
      throw new Error("Workflow effect request requires run.runId from the active runtime capability")
    }
    const activeRun = this.resolveRunAuthority()
    if (!isSameRunAuthority(request.run, activeRun)) {
      throw new Error("Workflow effect request run does not match active runtime run authority")
    }
    if (request.operation === "ai.agent" && request.run.workflow.scheme === "resource") {
      const key = `${request.run.runId}\u0000${request.run.generation}\u0000${request.effectId}`
      const existing = this.resourceAgentInvocations.get(key)
      if (existing) return await existing as Output
      const invocation = this.invokeOnce(request, true)
      this.resourceAgentInvocations.set(key, invocation)
      try {
        return await invocation as Output
      } finally {
        if (this.resourceAgentInvocations.get(key) === invocation) {
          this.resourceAgentInvocations.delete(key)
        }
      }
    }
    return await this.invokeOnce(request, false) as Output
  }

  private async invokeOnce(
    request: AIWorkflowEffectRequest,
    recoverResourceAgentResult: boolean,
  ): Promise<unknown> {
    if (recoverResourceAgentResult) {
      const recovered = await this.readResourceAgentEffectState(request)
      if (recovered.kind === "completed") return recovered.output
      if (recovered.kind === "pending") {
        return await this.waitForResourceAgentEffectResult(request)
      }
      if (recovered.kind === "failed") {
        throw new Error(`WORKFLOW_RESOURCE_AGENT_EFFECT_FAILED: ${recovered.error}`)
      }
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
      payload: {
        run: request.run,
        nodeId: request.nodeId,
        input: request.input,
        config: request.config === undefined ? {} : request.config,
      },
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
      return output
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

  private async waitForResourceAgentEffectResult(request: AIWorkflowEffectRequest): Promise<unknown> {
    for (;;) {
      if (request.signal?.aborted) {
        throw new Error("WORKFLOW_RESOURCE_AGENT_EFFECT_WAIT_ABORTED: waiting for the existing effect was cancelled")
      }
      await waitForEffectEvidence(20, request.signal)
      const state = await this.readResourceAgentEffectState(request)
      if (state.kind === "completed") return state.output
      if (state.kind === "failed") {
        throw new Error(`WORKFLOW_RESOURCE_AGENT_EFFECT_FAILED: ${state.error}`)
      }
      if (state.kind === "absent") {
        throw new Error("WORKFLOW_RESOURCE_AGENT_EFFECT_EVIDENCE_MISSING: pending effect evidence disappeared")
      }
    }
  }

  private async readResourceAgentEffectState(request: AIWorkflowEffectRequest): Promise<
    | { readonly kind: "absent" }
    | { readonly kind: "pending" }
    | { readonly kind: "completed"; readonly output: unknown }
    | { readonly kind: "failed"; readonly error: string }
  > {
    const root = sessionDir(this.runtime)
    if (!root) return { kind: "absent" }
    const matching = (await readRuntimeControlEffectEvidence(root))
      .filter((event) => event.effectId === request.effectId)
    if (matching.length === 0) return { kind: "absent" }
    const requested = matching.find((event) => event.kind === "request" || event.kind === "waiting")
    if (!requested || !sameResourceAgentLifecycleRequest(requested, request)) {
      throw new Error("WORKFLOW_RESOURCE_AGENT_EFFECT_AUTHORITY_MISMATCH: persisted effect request differs from the active request")
    }
    for (let index = matching.length - 1; index >= 0; index -= 1) {
      const event = matching[index]!
      if (event.kind === "result") {
        if (event.handlerKey !== `workflow:${request.operation}` || event.resultId !== `${request.effectId}:result`) {
          throw new Error("WORKFLOW_RESOURCE_AGENT_EFFECT_AUTHORITY_MISMATCH: persisted result identity differs from the active request")
        }
        return { kind: "completed", output: event.payload }
      }
      if (event.kind === "failed") {
        if (event.handlerKey !== `workflow:${request.operation}`) {
          throw new Error("WORKFLOW_RESOURCE_AGENT_EFFECT_AUTHORITY_MISMATCH: persisted failure identity differs from the active request")
        }
        return { kind: "failed", error: event.error }
      }
    }
    return { kind: "pending" }
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
  ): Promise<unknown> {
    if (!this.agentResources) {
      throw new Error("Resource workflow Agent execution requires a bound resource registry")
    }
    const agentDefinitionRef = selectExactAgentDefinitionRef(input, config)
    const nodeId = typeof request.nodeId === "string" ? request.nodeId : ""
    if (!nodeId || nodeId !== nodeId.trim()) {
      throw new Error("Resource workflow ai.agent requires an exact nodeId")
    }
    if (Object.prototype.hasOwnProperty.call(input, "prompt")) {
      throw new Error("Resource workflow ai.agent does not accept a free prompt; use the explicit payload field")
    }
    const payload = normalizeAgentExecutionValue(input.payload ?? null, "input.payload")
    const prepared: EidolonPreparedWorkflowAgentExecution = await this.agentResources.resourceRegistry.prepareWorkflowAgentExecution({
      workflowKind: this.agentResources.workflowForm,
      workflowRef: request.run.workflow.ref as `resource://${string}`,
      nodeId,
      agentDefinitionRef,
    }, { payload })
    if (prepared.plan.agentDefinitionRef !== agentDefinitionRef) {
      throw new Error("Prepared resource Agent plan does not match the requested Agent definition")
    }
    const prompt = JSON.stringify(prepared.plan.executionContract.input)
    const typedHost = config.typedHost === true
    if (typedHost) {
      const targetValue = config.targetInstance
      const target = targetValue === undefined
        ? undefined
        : addressedReference(targetValue, agentDefinitionRef)
      const invoked = await invokeAddressedChildExecutionActor(this.runtime.vm, this.runtime.actor, {
        description: text(input.description, `Workflow node ${nodeId}`),
        prompt,
        agentType: agentDefinitionRef,
        resolvedConfig: prepared.plan.agentConfig,
        toolCallId: request.effectId,
        ...(target === undefined ? {} : { target }),
      })
      const output = projectAgentExecutionOutput(prepared.plan.executionContract, invoked.output)
      return {
        output,
        instance: {
          authority: invoked.reference.authority,
          instanceId: invoked.reference.actorId,
          ...(typeof config.instanceName === "string"
            ? { instanceName: config.instanceName }
            : typeof record(targetValue).instanceName === "string" ? { instanceName: record(targetValue).instanceName as string } : {}),
          ...(invoked.reference.sessionId === undefined ? {} : { sessionId: invoked.reference.sessionId }),
          agentDefinitionRef,
          metadata: { actorKey: invoked.reference.actorKey },
        },
        hostReceipt: { effectId: request.effectId },
      }
    }
    const outputText = await spawnChildExecutionActor(this.runtime.vm, this.runtime.actor, {
      description: text(input.description, `Workflow node ${nodeId}`),
      prompt,
      agentType: agentDefinitionRef,
      resolvedConfig: prepared.plan.agentConfig,
      mode: "sync_wait",
      toolCallId: request.effectId,
    })
    return projectAgentExecutionOutput(prepared.plan.executionContract, outputText)
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

function sameResourceAgentLifecycleRequest(
  event: Extract<AiRuntimeEffectLifecycleEvent, { kind: "request" | "waiting" }>,
  request: AIWorkflowEffectRequest,
): boolean {
  if (event.handlerKey !== `workflow:${request.operation}` || event.idempotencyKey !== request.effectId) return false
  const payload = record(event.payload)
  const persistedRun = record(payload.run)
  const expectedRun = request.run
  const persistedWorkflow = record(persistedRun.workflow)
  if (persistedRun.runId !== expectedRun.runId
    || persistedRun.generation !== expectedRun.generation
    || persistedRun.parentGeneration !== expectedRun.parentGeneration
    || persistedWorkflow.ref !== expectedRun.workflow.ref
    || persistedWorkflow.scheme !== expectedRun.workflow.scheme
    || persistedWorkflow.fqn !== expectedRun.workflow.fqn
    || persistedWorkflow.revision !== expectedRun.workflow.revision
    || payload.nodeId !== request.nodeId) {
    return false
  }
  return canonicalAgentExecutionValue(normalizeAgentExecutionValue(record(payload.input)))
      === canonicalAgentExecutionValue(normalizeAgentExecutionValue(record(request.input)))
    && canonicalAgentExecutionValue(normalizeAgentExecutionValue(record(payload.config)))
      === canonicalAgentExecutionValue(normalizeAgentExecutionValue(record(request.config)))
}

function waitForEffectEvidence(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("WORKFLOW_RESOURCE_AGENT_EFFECT_WAIT_ABORTED: waiting for the existing effect was cancelled"))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, delayMs)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      reject(new Error("WORKFLOW_RESOURCE_AGENT_EFFECT_WAIT_ABORTED: waiting for the existing effect was cancelled"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function addressedReference(value: unknown, agentDefinitionRef: string): AddressedChildExecutionReference {
  const instance = record(value)
  const metadata = record(instance.metadata)
  const allowedMetadata = Object.keys(metadata)
  if (allowedMetadata.length !== 1 || allowedMetadata[0] !== "actorKey" || typeof metadata.actorKey !== "string" || !metadata.actorKey.trim()) {
    throw new Error("ADDRESSED_AGENT_OWNER_REFERENCE_INVALID: target metadata must contain exact actorKey")
  }
  if (instance.authority !== "eidolon.actor-runtime/v1"
    || typeof instance.instanceId !== "string" || !instance.instanceId.trim()
    || instance.agentDefinitionRef !== agentDefinitionRef) {
    throw new Error("ADDRESSED_AGENT_OWNER_REFERENCE_INVALID: target identity differs")
  }
  return Object.freeze({
    authority: "eidolon.actor-runtime/v1",
    actorKey: metadata.actorKey,
    actorId: instance.instanceId,
    ...(typeof instance.sessionId === "string" ? { sessionId: instance.sessionId } : {}),
    agentDefinitionRef,
  })
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

function canonicalAgentExecutionValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalAgentExecutionValue).join(",")}]`
  return `{${Object.keys(value).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .map((key) => `${JSON.stringify(key)}:${canonicalAgentExecutionValue((value as Record<string, unknown>)[key])}`)
    .join(",")}}`
}
