import { createHash } from "node:crypto"
import { mkdir, open, readFile } from "node:fs/promises"
import path from "node:path"
import { isDeepStrictEqual } from "node:util"
import { AI_AGENT_DEFINITION_SELECTION_SCHEMA_VERSION } from "ai-workflow-contract"
import { openLocalHolonTaskRuntime } from "@terminal/organ/AIAgent/LocalHolonTaskRuntimeBootstrap"
import { createStandaloneHolonExecutionAdapters } from "../../../../../../terminal/packages/organ/src/AIAgent/StandaloneHolonExecutionAdapters"
import { createLocalHolonTaskRuntimeStorage } from "@cell/ai-support/organization/LocalHolonTaskRuntimeSupport"
import { bootstrapLocalHolonTaskRuntime } from "../../../src/organization/HolonTaskRuntimeComposition"
import { EidolonAppResourceRegistryAdapter } from "../../../src/resources"
import { invokeAddressedChildExecutionActor } from "../../../src/agent/DelegateActor"
import { appendLiveHistoryMessageToConversationDomainRuntime } from "../../../src/conversation/ConversationDomainRuntime"
import { createSubgraphPreparationFixture } from "./subgraph-worker-preparation-runtime"
import { addProductHolonPackage, productRefs, productWorkerSource, writeProductFiles } from "./holonRepairResourceProductPackage"
import { createHolonProductProviderTransport, readHolonProductProviderMessage } from "./holonProductProviderTransport"

export const productOrder = Object.freeze({ orderId: "order-314", shippingCents: 275, lines: [{ sku: "tea", quantity: 3, unitCents: 425 }, { sku: "cup", quantity: 2, unitCents: 1199 }] })
export const productInput = Object.freeze({ value: JSON.stringify(productOrder) })
const digest = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`

/** Independent observer: never uses model output, recipe version, or call count as success. */
export async function verifyProductArtifact(root: string, artifact: string, order = productOrder) {
  try {
    if (path.basename(artifact) !== artifact) throw new Error("non-local artifact name")
    const actual = JSON.parse(await readFile(path.join(root, "artifacts", artifact), "utf8"))
    const lines = order.lines.map(({ sku, quantity, unitCents }) => ({ sku, quantity, unitCents, lineCents: quantity * unitCents }))
    const expected = { orderId: order.orderId, inputDigest: digest(order), lines, totalCents: lines.reduce((total, line) => total + line.lineCents, order.shippingCents) }
    const passed = isDeepStrictEqual(actual, expected)
    return { passed, actual, expected, diagnostics: passed ? [] : [{ code: "ORDER_ARTIFACT_MISMATCH", message: "Artifact must preserve input digest, every line, and include shipping in integer-cent total" }] }
  } catch (error) {
    return { passed: false, diagnostics: [{ code: "ORDER_ARTIFACT_UNREADABLE", message: String(error) }] }
  }
}

/** Explicit external effect: stores decoded model bytes, without correcting the business result. */
export async function acceptProductArtifact(root: string, logicalKey: string, bytes: string) {
  const filename = `${createHash("sha256").update(logicalKey).digest("hex")}.json`
  const directory = path.join(root, "artifacts")
  await mkdir(directory, { recursive: true })
  const target = path.join(directory, filename)
  let accepted = false
  try {
    const file = await open(target, "wx")
    try { await file.writeFile(bytes); await file.sync(); accepted = true } finally { await file.close() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    if (await readFile(target, "utf8") !== bytes) throw new Error("PRODUCT_EFFECT_IDEMPOTENCY_CONFLICT")
  }
  if (accepted) {
    const directoryHandle = await open(directory, "r")
    try { await directoryHandle.sync() } finally { await directoryHandle.close() }
  }
  return { value: filename, accepted }
}

export function productRequestPayload(messages: readonly any[]) {
  const user = [...messages].reverse().find(message => message.role === "user")
  const content = typeof user?.content === "string" ? user.content : (user?.content ?? []).map((item: any) => item.text ?? "").join("")
  const parsed = JSON.parse(content)
  return parsed.payload ?? parsed
}

export async function createHolonRepairResourceProductFixture(options: { root?: string; version?: 1 | 2; existing?: boolean } = {}) {
  const base = await createSubgraphPreparationFixture({ root: options.root, existing: options.existing })
  const { root, resources, actor, vm } = base
  const pkg = options.existing
    ? { issuer: JSON.parse(await readFile(path.join(root, "product-issuer.json"), "utf8")), packageRoot: resources, refs: productRefs }
    : await addProductHolonPackage(root, resources, options.version ?? 2, options.version === 1)
  if (!options.existing) await writeProductFiles(root, { "product-issuer.json": JSON.stringify(pkg.issuer) })
  const requests: any[] = []
  const effects: { key: string; value: string; accepted: boolean }[] = []
  const controlPayloads: any[] = []
  let selectedPayload: any
  let failNextEffect = false
  const orderInput = productInput

  // The local model only interprets real request payload and ordered prefix content.
  // Its JSON result is consumed by the separate external effect below.
  async function respond(wire: { messages: readonly any[] }) {
    const payload = productRequestPayload(wire.messages)
    requests.push(structuredClone(wire))
    if (payload.schemaVersion === "eidolon.ai-data-child-worker-selection/v1") {
      selectedPayload = payload
      const candidate = payload.observation.candidateSet.candidates.find((item: any) => item.agentDefinitionRef === productRefs.worker)
      const authority = payload.authoring.candidates.find((item: any) => item.agentDefinitionRef === productRefs.worker)
      return { schemaVersion: AI_AGENT_DEFINITION_SELECTION_SCHEMA_VERSION, mode: "revise-existing", requirementDigest: payload.observation.requirement.requirementDigest,
        candidateSetDigest: payload.observation.candidateSet.candidateSetDigest, candidateRef: productRefs.worker, candidateDigest: candidate.candidateDigest,
        feedback: { observationRef: payload.feedback.observationRef, attemptRef: payload.feedback.attemptRef, verificationRef: payload.feedback.verificationRef,
          requirementDigest: payload.observation.requirement.requirementDigest, candidateSetDigest: payload.observation.candidateSet.candidateSetDigest,
          candidateDigest: candidate.candidateDigest, previousExecutionFingerprint: payload.feedback.previousExecutionFingerprint },
        proposal: { schemaVersion: "halfcode.resource-authoring/v1", operation: "update", catalogId: "agents", resourceId: "eidolon.child.Worker", kind: "AIAgentDefinition",
          envelopeVersion: "halfcode.resource-envelope/v1", writerSpecVersion: 1, sourceShape: "single-file", documentUri: "vfs://@/agents/Worker.xnl", authorityText: productWorkerSource(2, options.version === 1),
          expected: { state: "present", authorityDigest: authority.authorityDigest, registryRevision: payload.observation.candidateSet.registryRevision } }, reason: "Original artifact verifier found missing shipping; include it in the next adopted worker recipe." }
    }
    if (payload.observation?.graph && payload.observation?.verifier) {
      controlPayloads.push(payload)
      const observation = payload.observation
      const common = { schemaVersion: "depa.ai-data-control/v1", decisionId: `decision-${observation.graph.generation}`, goalId: observation.goalId, observationId: observation.observationId,
        observationDigest: observation.observationDigest, catalogDigest: observation.catalogDigest, reason: "Use the independent order artifact verification" }
      return observation.verifier.status === "passed"
        ? { ...common, kind: "complete", verifierFactId: observation.verifier.factId, outputNodeId: "repair-child", outputPort: "value", outputSchemaRef: "schema://eidolon.child/value" }
        : { ...common, kind: "revise", operations: [{ op: "add-subflow", nodeId: "repair-child", subflowCapabilityId: "repair", inputs: { value: { kind: "literal", schemaRef: "schema://eidolon.child/value", value: orderInput.value }, failedWorker: { kind: "literal", schemaRef: "schema://eidolon.child/value", value: "old" } } }] }
    }
    const order = JSON.parse(payload.value)
    const prefix = JSON.stringify(wire.messages.filter(message => message.role === "system" || message.role === "developer"))
    if (!prefix.includes("ORDER_RECIPE:")) throw new Error("PRODUCT_WORKER_RECIPE_MISSING")
    const lines = order.lines.map((line: any) => ({ ...line, lineCents: line.quantity * line.unitCents }))
    const totalCents = lines.reduce((total: number, line: any) => total + line.lineCents, 0) + (prefix.includes("include shippingCents") ? order.shippingCents : 0)
    return { value: JSON.stringify({ orderId: order.orderId, inputDigest: digest(order), lines, totalCents }) }
  }

  async function afterResponse(output: any, child: any) {
    if (child.agentName !== productRefs.worker) return output
    if (failNextEffect) { failNextEffect = false; throw new Error("PRODUCT_ARTIFACT_STORAGE_UNAVAILABLE") }
    const key = child.sessionId ?? `${child.key}:${child.id}`
    const receipt = await acceptProductArtifact(root, key, output.value)
    effects.push({ key, ...receipt })
    return { value: receipt.value }
  }

  const transport = createHolonProductProviderTransport({ sessionId: "product-fixture", respond })
  actor.llmClient = transport.adapter
  actor.modelConfig = { model: "deepseek-chat", adapter: "deepseek" }
  actor.callbacks.processStream = async (runtimeVm, child, stream) => {
    const decoded = await readHolonProductProviderMessage(stream)
    const output = await afterResponse(JSON.parse(decoded.content), child)
    const message = { role: "assistant" as const, content: JSON.stringify(output) }
    appendLiveHistoryMessageToConversationDomainRuntime({ vm: runtimeVm, actorKey: child.key, actorId: child.id, message })
    return message
  }
  const supportRoot = path.join(root, "session", "holon-task-runtime")
  const registryRef = `resource://eidolon.effective-resource-registry/${createHash("sha256").update(root).digest("hex")}` as const
  bootstrapLocalHolonTaskRuntime({ vm: vm as any, supportRoot, registryRef }, { storageFactory: createLocalHolonTaskRuntimeStorage, now: Date.now })
  const standaloneActors = new Map<string, any>()
  const acceptanceRoot = path.join(root, "artifact-acceptances")
  async function openStandalone(hooks: { afterAccepted?: (fact: { idempotencyKey: string; output: unknown }) => Promise<void> } = {}) {
    return openLocalHolonTaskRuntime({ vm: vm as any, supportRoot, registryRef,
      resourceRegistry: new EidolonAppResourceRegistryAdapter({ layers: [{ id: "workspace", rootDir: resources }], workspaceRoot: root }),
      createGenericActorOwner: () => ({
        ensureActor: ({ address }) => ({ actorRef: `product-actor:${address.deploymentId}:${address.actorKind}:${address.logicalKey}` }),
        ensureTaskAttemptSession: ({ deploymentId, runtimeRef, scopeRef }) => ({ sessionRef: `product-session:${deploymentId}:${runtimeRef}:${scopeRef}` }),
        resolveTargetedAgentSession: () => ({ sessionRef: "product-targeted", agentDefinitionRef: productRefs.worker }),
      }),
      createExecutionAdapters: ({ deployment }) => createStandaloneHolonExecutionAdapters({ deployment,
        executeAddressedAgent: async ({ agentDefinitionRef, resolvedConfig, invocation, sessionRef, idempotencyKey }) => {
          const inputDigest = digest(invocation.input)
          const acceptancePath = path.join(acceptanceRoot, `${createHash("sha256").update(idempotencyKey).digest("hex")}.json`)
          try {
            const prior = JSON.parse(await readFile(acceptancePath, "utf8"))
            if (prior.idempotencyKey !== idempotencyKey || prior.inputDigest !== inputDigest) throw new Error("PRODUCT_ADAPTER_ACCEPTANCE_CONFLICT")
            return prior.output
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
          const target = standaloneActors.get(sessionRef)
          const result = await invokeAddressedChildExecutionActor(vm, actor, { description: "Compute order artifact", prompt: JSON.stringify(invocation.input), agentType: agentDefinitionRef,
            resolvedConfig, toolCallId: idempotencyKey, ...(target ? { target } : { sessionId: sessionRef }) })
          standaloneActors.set(sessionRef, result.reference)
          const output = JSON.parse(result.output)
          await mkdir(acceptanceRoot, { recursive: true })
          const receipt = await open(acceptancePath, "wx")
          try { await receipt.writeFile(JSON.stringify({ idempotencyKey, inputDigest, output })); await receipt.sync() } finally { await receipt.close() }
          const directory = await open(acceptanceRoot, "r")
          try { await directory.sync() } finally { await directory.close() }
          await hooks.afterAccepted?.({ idempotencyKey, output })
          return output
        } }),
      processorConfig: { leaseDurationMs: 5_000, maxSteps: 16 }, supportOptions: { waitingProbeMs: 1 },
    })
  }
  const verifier = { verify: async ({ graph }: any) => {
    const artifact = graph.nodes["repair-child"]?.result?.output?.value ?? graph.nodes.old?.result?.output?.value ?? "missing.json"
    const result = await verifyProductArtifact(root, artifact)
    return { schemaVersion: "depa.ai-data-control/v1", goalId: "repair-answer", objective: "Produce the verified answer", verifierRef: "resource://eidolon.child.Verifier", requiredOutputSchemaRef: "schema://eidolon.child/value",
      factId: `verify-${graph.currentGeneration}`, graphGeneration: graph.currentGeneration, status: result.passed ? "passed" : "failed", diagnostics: result.diagnostics }
  } }
  return { ...pkg, root, resources, supportRoot, acceptanceRoot, actor, vm, get service() { return base.service }, input: orderInput, requests, effects, controlPayloads, selectionPayload: () => selectedPayload,
    respond, afterResponse, transport, verifier, openStandalone, failNextEffect() { failNextEffect = true }, verify: (artifact: string) => verifyProductArtifact(root, artifact) }
}
