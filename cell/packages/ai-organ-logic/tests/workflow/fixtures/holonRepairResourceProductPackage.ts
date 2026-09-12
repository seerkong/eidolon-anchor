import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { HOLON_EXECUTION_BINDING_KIND_DEFINITION_SOURCE, HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_SOURCE, HOLON_TASK_RUNTIME_DEFINITION_SCHEMA_VERSION, canonicalHolonExecutionBindingBytes } from "@cell/ai-organ-contract"
import { HOLON_EFFECTIVE_SNAPSHOT_KIND_DEFINITION_SOURCE } from "holarchy-core-contract"
import { createSyntheticTeamFixture } from "holarchy-test-support"
import { stringifyLiteral } from "xnl-core"
import { depaAIResourceKindContract } from "ai-workflow-contract"
import { issueFileXnlOrganizationFixture, type FileXnlHolonIssuerFixture } from "../fileXnlHolonIssuerFixture"
import { EidolonAppResourceRegistryAdapter } from "../../../src/resources"
import { canonicalHolonTaskRuntimeDefinitionBytes } from "../../../src/organization/HolonTaskRuntimeContract"
import { childWorkerSource } from "./subgraph-worker-preparation-runtime"

export const productRefs = {
  worker: "resource://eidolon.child.Worker",
  binding: "resource://eidolon.product.Binding",
  runtime: "resource://eidolon.product.Runtime",
  ctrl: "resource://eidolon.product.Ctrl",
  data: "resource://eidolon.product.Data",
  input: "resource://eidolon.product.OrderInput",
  output: "resource://eidolon.child.WorkerOutput",
  port: "resource://eidolon.product.Artifact",
} as const
const instant = "2026-01-01T00:00:00.000Z"
const profile = "resource://eidolon.product.Profile"
const policy = "resource://eidolon.product.RuntimePolicy"
const capability = "resource://eidolon.product.Capability"
const xnl = stringifyLiteral

export function productWorkerSource(version: 1 | 2, workflowMaterial = false) {
  const source = childWorkerSource(version)
    .replace('ref="resource://eidolon.child.Input"', `ref="${productRefs.input}"`)
    .replace("<MessagePrefix [", '<MessagePrefix [<MessageSource #workspace {kind="AgentMessageSource" ref="resource://eidolon.product.Workspace"}>')
    .replace("<ToolRefs []>", '<ContextPipeline {kind="AgentContextPipeline" ref="resource://eidolon.product.Context"}><ToolRefs []>')
  return workflowMaterial ? source : source.replace(/<MaterialPortRefs \[.*?\]>/s, "<MaterialPortRefs []>")
}

export function productOrganizationFixture() {
  return createSyntheticTeamFixture({ authorityId: "product-file-xnl-authority", teamId: "holon-product",
    teamName: "Order artifact team", purpose: "Produce order artifacts", boundary: "Order totals",
    members: [{ memberId: "member-worker", displayName: "Order worker", principalKind: "ai", membershipId: "membership-worker",
      roles: [{ roleId: "role-worker", roleName: "Order worker", assignmentId: "assignment-worker", purpose: "Produce artifacts",
        domains: ["orders"], accountabilities: ["verify totals"], capabilityRequirements: ["orders"] }] }],
  })
}

export async function writeProductFiles(root: string, files: Record<string, string | Uint8Array>) {
  for (const [name, bytes] of Object.entries(files)) {
    const target = path.join(root, name)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, bytes)
  }
}

export interface ProductOrganizationAdmission {
  readonly issuer: Pick<FileXnlHolonIssuerFixture, "snapshotBytes" | "issuanceReceiptBytes" | "provenance">
  readonly rootHolonRef: string
  readonly memberRef: string
  readonly requiredRoleRefs: readonly string[]
}

export function productOrganizationResource(issuer: ProductOrganizationAdmission["issuer"]): string {
  return `<HolonEffectiveSnapshot #eidolon.product.Organization envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 {snapshotBytesBase64="${Buffer.from(issuer.snapshotBytes).toString("base64")}" issuanceReceiptBytesBase64="${Buffer.from(issuer.issuanceReceiptBytes).toString("base64")}"}>`
}

/** Adds issuer-owned Holon resources to the shared product ResourcePackage. */
export async function addProductHolonPackage(root: string, resources: string, version: 1 | 2, workflowMaterial = false, organization?: ProductOrganizationAdmission) {
  const rootHolonRef = organization?.rootHolonRef ?? "holon-product"
  const memberRef = organization?.memberRef ?? "member-worker"
  const issuer = organization?.issuer ?? await issueFileXnlOrganizationFixture({
    authorityRoot: path.join(root, "authority"), authorityId: "product-file-xnl-authority", expectedRevision: 0,
    fixture: productOrganizationFixture(), executionId: "issue-product-organization", executionInstant: instant,
    rootHolonRef: "holon-product", effectiveAt: instant, issuedAt: "2026-01-01T00:00:01.000Z", projectionBounds: { maxDepth: 8, maxRecords: 100 },
  })
  const catalogs = { organizations: "HolonEffectiveSnapshot", holonBindings: "HolonExecutionBinding", taskRuntimes: "HolonTaskRuntimeDefinition", ctrl: "AICtrlWorkflow", productData: "AIDataWorkflow", sources: "AgentMessageSource", pipelines: "AgentContextPipeline", context: "ContextMaterial" }
  const binding = {
    apiVersion: "eidolon.ai/v1", kind: "HolonExecutionBinding", bindingRef: productRefs.binding,
    snapshotRef: "resource://eidolon.product.Organization", target: { kind: "member", memberRef },
    adapter: { kind: "ai-agent", agentDefinitionRef: productRefs.worker, runtimeProfileRef: policy },
    policy: { version: "1", runtime: { mode: "isolated-task-runtime" }, taskProfileRef: profile, capabilityRefs: [capability], toolRefs: [], materialRefs: [productRefs.port] },
  }
  const envelope = 'envelopeVersion="halfcode.resource-envelope/v1" specVersion=1'
  const files: Record<string, string> = {
    "manifest.xnl": (await readFile(path.join(resources, "manifest.xnl"), "utf8")).replace("<Catalogs [", `<Catalogs [\n${Object.entries(catalogs).map(([id, kind]) => `<Catalog #${id} {kind="${kind}" shape="single-file" root="vfs://./${id}/"}>`).join("\n")}`),
    "organizations/Product.xnl": productOrganizationResource(issuer),
    "holonBindings/Worker.xnl": `<HolonExecutionBinding #eidolon.product.Binding ${envelope} {bindingBytesBase64="${Buffer.from(canonicalHolonExecutionBindingBytes(binding)).toString("base64")}"}>`,
    "agents/Worker.xnl": productWorkerSource(version, workflowMaterial),
    "schemas/OrderInput.xnl": `<MessageSchema #eidolon.product.OrderInput ${envelope} {lifecycle="Stable" schema={type="object" required=["value"] properties={value={type="string"}}}}>`,
    "sources/Workspace.xnl": `<AgentMessageSource #eidolon.product.Workspace ${envelope} {lifecycle="Active"} (<Content ?>${JSON.stringify({ implementation: "eidolon.workspace-agents/v1" })}</?>)>`,
    "pipelines/Context.xnl": `<AgentContextPipeline #eidolon.product.Context ${envelope} {lifecycle="Active"} (<Content ?>${JSON.stringify({ implementation: "eidolon.standard-context-pipeline/v1", stages: ["prompt-plan", "conversation-prelude", "provider-context-facts-at-history-anchors", "stable-message-prefix", "conversation-boundary-overlays", "provider-conversion"] })}</?>)>`,
    "prompts/V1.xnl": `<Prompt #eidolon.child.PromptV1 ${envelope} {lifecycle="Active" template="ORDER_RECIPE: multiply quantity by unitCents; sum line totals; omit shippingCents from totalCents. Write JSON artifact including inputDigest and lines."}>`,
    "prompts/V2.xnl": `<Prompt #eidolon.child.PromptV2 ${envelope} {lifecycle="Active" template="ORDER_RECIPE: multiply quantity by unitCents; sum line totals; include shippingCents in totalCents. Write JSON artifact including inputDigest and lines."}>`,
    "ports/Artifact.xnl": `<MaterialPort #eidolon.product.Artifact ${envelope} {lifecycle="Active" materialKind="ContextMaterial" required=true cardinality="one"} (<SchemaRef {kind="MessageSchema" ref="${productRefs.output}"}>)>`,
    "context/Artifact.xnl": `<ContextMaterial #eidolon.product.ArtifactSeed ${envelope} {lifecycle="Active" value={value="pending.json"}}>`,
  }
  for (const [name, ref] of Object.entries({ Profile: profile, RuntimePolicy: policy, Capability: capability })) files[`context/${name}.xnl`] = `<ContextMaterial #${ref.slice(11)} ${envelope} {lifecycle="Active" value={name="${name}"}}>`
  for (const kind of Object.values(catalogs)) files[`KindDefinitions/${kind}/manifest.xnl`] = kind === "HolonEffectiveSnapshot" ? HOLON_EFFECTIVE_SNAPSHOT_KIND_DEFINITION_SOURCE : kind === "HolonExecutionBinding" ? HOLON_EXECUTION_BINDING_KIND_DEFINITION_SOURCE : kind === "HolonTaskRuntimeDefinition" ? HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_SOURCE : depaAIResourceKindContract(kind as any).kindDefinitionSource
  await writeProductFiles(resources, files)
  for (const name of Object.keys(catalogs)) await mkdir(path.join(resources, name), { recursive: true })
  await writeFile(path.join(root, "AGENTS.md"), "Order artifacts use integer cents. Preserve every input line and its SKU.\n")
  const snapshot = await new EidolonAppResourceRegistryAdapter({ layers: [{ id: "workspace", rootDir: resources }] }).snapshot().catch(error => { throw new Error(JSON.stringify(error.diagnostics ?? error.message), { cause: error }) })
  const digest = snapshot.contentIdentities.get("eidolon.product.Binding")!.contentDigest
  const taskSpace = { profileRef: profile, policyRef: policy, requiredRoleRefs: [...(organization?.requiredRoleRefs ?? ["role-worker"])], requiredCapabilityRefs: [capability] }
  const output = { schemaRef: productRefs.output, materialPortRefs: [productRefs.port] }
  const definition = { kind: "holon-task-runtime-definition", schemaVersion: HOLON_TASK_RUNTIME_DEFINITION_SCHEMA_VERSION, definitionRef: productRefs.runtime, version: "1.0.0", rootHolonRef, executionBinding: { ref: productRefs.binding, digest }, taskSpace, input: { schemaRef: productRefs.input }, output, defaultForHolon: true }
  const target = (kind: string, ref: string) => xnl({ kind: "holon-task-target", schemaVersion: "ai-workflow.holon-task-target/v1", invocation: { workflowKind: kind, workflowRef: ref, nodeId: "delegate", invocationId: "order-artifact" }, holon: { rootHolonRef, effectiveAt: instant }, executionBinding: { ref: productRefs.binding, digest }, taskSpace, output })
  const resultFiles: Record<string, string> = {
    "taskRuntimes/Product.xnl": `<HolonTaskRuntimeDefinition #eidolon.product.Runtime ${envelope} {definitionBytesBase64="${Buffer.from(canonicalHolonTaskRuntimeDefinitionBytes(definition)).toString("base64")}"}>`,
    "ctrl/Product.xnl": `<AICtrlWorkflow #eidolon.product.Ctrl ${envelope} (<FlowContract #eidolon.product.Ctrl>) [<Run #delegate {src="vfs://@/product-code/holon.ts#open" config={holonTaskTarget=${target("AICtrlWorkflow", productRefs.ctrl)}}}><ExternalJob #await {signalKind="holon.task.settled" signalKey="orders"}><Run #consume {src="vfs://@/product-code/holon.ts#consume"}><Return #done>]>`,
    "productData/Product.xnl": `<AIDataWorkflow #eidolon.product.Data ${envelope} (<FlowContract #eidolon.product.Data {inputPorts=["value"] outputPorts=["value"]}>) [<EntryNode #entry><TransformNode #delegate {inputs={value="flow-port://#entry/value"} outputs=["taskSpaceId"] src="vfs://@/product-code/holon.ts#open" config={holonTaskTarget=${target("AIDataWorkflow", productRefs.data)}}}><TransformNode #await {inputs={taskSpaceId="flow-port://#delegate/taskSpaceId"} outputs=["settled"] src="vfs://@/product-code/holon.ts#pass" config={node_type="manual"}}><TransformNode #consume {inputs={settled="flow-port://#await/settled"} outputs=["value"] src="vfs://@/product-code/holon.ts#consume"}><ReturnNode #return {inputs={value="flow-port://#consume/value"}}>]>`,
    "product-code/holon.ts": `export async function open(runtime) { await runtime.holonTasks.openTask({frozenTarget:runtime.holonTasks.proofForNode("delegate"),commandId:"create-orders",taskSpaceId:"orders",taskId:"order",taskName:"Compute order artifact",createdAt:"2026-01-01T00:00:02.000Z"},{maxTasks:16,maxRelations:32,maxLeaseDurationMs:60000});return {taskSpaceId:"orders"} }\nexport async function consume(runtime) {const result=await runtime.holonTasks.consumeTask({frozenTarget:runtime.holonTasks.proofForNode("delegate"),taskSpaceId:"orders",taskId:"order",settlementCommandId:"settle-order"},{});return result.output}\nexport function pass(runtime,input){return input}`,
  }
  // The same Worker is standalone-capable. Workflow proof is frozen by its
  // actual task identity; it needs no input Material binding for typed payload.
  if (!workflowMaterial) await rm(path.join(resources, "bindings/Old.xnl"))
  await writeProductFiles(resources, resultFiles)
  await new EidolonAppResourceRegistryAdapter({ layers: [{ id: "workspace", rootDir: resources }] }).snapshot().catch(error => { throw new Error(JSON.stringify(error.diagnostics ?? error.message), { cause: error }) })
  return { issuer, packageRoot: resources, refs: productRefs }
}
