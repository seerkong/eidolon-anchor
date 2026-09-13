import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { depaAIResourceKindContract } from "ai-workflow-contract"
import { HOLON_EXECUTION_BINDING_KIND_DEFINITION_SOURCE, HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_SOURCE, HOLON_TASK_RUNTIME_DEFINITION_SCHEMA_VERSION, canonicalHolonExecutionBindingBytes } from "@cell/ai-organ-contract"
import { HOLON_EFFECTIVE_SNAPSHOT_KIND_DEFINITION_SOURCE } from "holarchy-core-contract"
import { issueFileXnlOrganizationFixture } from "./fileXnlHolonIssuerFixture"
import { productOrganizationFixture, productOrganizationResource } from "./fixtures/holonRepairResourceProductPackage"
import { EidolonAppResourceRegistryAdapter } from "../../src/resources"
import { canonicalHolonTaskRuntimeDefinitionBytes } from "../../src/organization/HolonTaskRuntimeContract"

// Only seed organization resources. No mock actor, provider, runtime service or workflow result.
export async function prepareSkillDrivenOrganizationWorkspace(root: string) {
const resources = path.join(root, ".eidolon/resources")
const instant = "2026-01-01T00:00:00.000Z"
const env = 'envelopeVersion="halfcode.resource-envelope/v1" specVersion=1'
const ref = (s: string) => `resource://eidolon.product.${s}`
const put = async (name: string, value: string) => {
  const target = path.join(resources, name)
  await mkdir(path.dirname(target), {recursive:true})
  await writeFile(target,value)
}
const issuer = await issueFileXnlOrganizationFixture({authorityRoot:path.join(root,"authority"),authorityId:"product-file-xnl-authority",expectedRevision:0,fixture:productOrganizationFixture(),executionId:"seed-public-startup",executionInstant:instant,rootHolonRef:"holon-product",effectiveAt:instant,issuedAt:instant,projectionBounds:{maxDepth:8,maxRecords:100}})
const kinds = {organizations:"HolonEffectiveSnapshot",bindings:"HolonExecutionBinding",runtimes:"HolonTaskRuntimeDefinition",agents:"AIAgentDefinition",prompts:"Prompt",tools:"Tool",schemas:"MessageSchema",policies:"EffectPolicy",context:"ContextMaterial",ports:"MaterialPort"}
await put("manifest.xnl", `<ResourcePackage #eidolon.product ${env} {lifecycle="Active"} (<Catalogs [<Catalog #kinds {kind="KindDefinition" shape="directory" root="vfs://./KindDefinitions/" entry="manifest.xnl"}>${Object.entries(kinds).map(([id,kind])=>`<Catalog #${id} {kind="${kind}" shape="single-file" root="vfs://./${id}/"}>`).join("\n")} ]>)>`)
for (const [dir,kind] of Object.entries(kinds)) {
  await mkdir(path.join(resources,dir),{recursive:true})
  const source = kind === "HolonEffectiveSnapshot" ? HOLON_EFFECTIVE_SNAPSHOT_KIND_DEFINITION_SOURCE : kind === "HolonExecutionBinding" ? HOLON_EXECUTION_BINDING_KIND_DEFINITION_SOURCE : kind === "HolonTaskRuntimeDefinition" ? HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_SOURCE : depaAIResourceKindContract(kind as any).kindDefinitionSource
  await put(`KindDefinitions/${kind}/manifest.xnl`,source)
}
await put("organizations/Product.xnl",productOrganizationResource(issuer))
await put("agents/Worker.xnl", `<AIAgentDefinition #eidolon.product.Worker ${env} {lifecycle="Active"} (
<MessagePrefix [<Message #system {role="system" promptKind="Prompt" promptRef="${ref("WorkerPrompt")}"}>]>
<InputSchemaRef {kind="MessageSchema" ref="${ref("Input")}"}>
<OutputSchemaRef {kind="MessageSchema" ref="${ref("Output")}"}>
<ToolRefs [<ToolRef #skill {kind="Tool" ref="resource://Skill"}><ToolRef #workflow {kind="Tool" ref="resource://WorkflowFulfill"}>]>
<EffectPolicyRef {kind="EffectPolicy" ref="${ref("WorkerEffects")}"}><MaterialPortRefs []>)>`)
await put("prompts/Worker.xnl", `<Prompt #eidolon.product.WorkerPrompt ${env} {lifecycle="Active" template=${JSON.stringify("你是组织的执行成员。输入的 content 是用户完整任务。先用你自己的 Skill 工具读取 sys-eidolon-anchor-run/SKILL.md、sys-eidolon-anchor-authoring 的 SKILL.md 与 operations/ai-workflow.md、sys-eidolon-anchor-devops/SKILL.md 和 sys-halfcode-resource-dsl/SKILL.md（按 skill 分次调用）。只有任务要求创建、编辑或执行工作流时，才按照阶段协议用 WorkflowFulfill 将原始请求交给专用 actor；普通审核或计算任务在本成员内完成。用户已授权当前测试工作区内创建、修改、发布并执行。涉及工具的事实仅以工具真实回执为依据。最终回复是供程序直接 JSON.parse 的 API 返回值。整条最终 assistant 消息只能包含一个 JSON 对象，禁止 Markdown 围栏、解释段落、标题或对象前后的任何文字；计算和 Skill 证据都放进 value 字符串。完成后返回严格 JSON 对象 {\"value\":\"实际结果、资源引用及运行证据摘要\"}。失败也如实报告，不要伪造通过。")}}>`)
for (const tool of ["Skill","WorkflowFulfill"]) await put(`tools/${tool}.xnl`,`<Tool #${tool} ${env} {lifecycle="Active"}>`)
await put("schemas/Input.xnl",`<MessageSchema #eidolon.product.Input ${env} {lifecycle="Stable" schema={type="object" required=["content"] properties={content={type="string"}}}}>`)
await put("schemas/Output.xnl",`<MessageSchema #eidolon.product.Output ${env} {lifecycle="Stable" schema={type="object" required=["value"] additionalProperties=false properties={value={type="string"}}}}>`)
await put("policies/Worker.xnl",`<EffectPolicy #eidolon.product.WorkerEffects ${env} {lifecycle="Active" toolMode="declared-only"}>`)
for (const name of ["Profile","RuntimePolicy","Capability"]) await put(`context/${name}.xnl`,`<ContextMaterial #eidolon.product.${name} ${env} {lifecycle="Active" value={name="${name}"}}>`)
await put("ports/Result.xnl",`<MaterialPort #eidolon.product.Result ${env} {lifecycle="Active" materialKind="ContextMaterial" required=true cardinality="one"} (<SchemaRef {kind="MessageSchema" ref="${ref("Output")}"}>)>`)
const binding = {apiVersion:"eidolon.ai/v1",kind:"HolonExecutionBinding",bindingRef:ref("Binding"),snapshotRef:ref("Organization"),target:{kind:"member",memberRef:"member-worker"},adapter:{kind:"ai-agent",agentDefinitionRef:ref("Worker"),runtimeProfileRef:ref("RuntimePolicy")},policy:{version:"1",runtime:{mode:"isolated-task-runtime"},taskProfileRef:ref("Profile"),capabilityRefs:[ref("Capability")],toolRefs:["resource://Skill","resource://WorkflowFulfill"],materialRefs:[ref("Result")]}}
await put("bindings/Worker.xnl",`<HolonExecutionBinding #eidolon.product.Binding ${env} {bindingBytesBase64="${Buffer.from(canonicalHolonExecutionBindingBytes(binding)).toString("base64")}"}>`)
const registry = new EidolonAppResourceRegistryAdapter({layers:[{id:"workspace",rootDir:resources}]})
const first = await registry.snapshot().catch(e=>{console.error(JSON.stringify(e.diagnostics));throw e})
const digest = first.contentIdentities.get("eidolon.product.Binding")!.contentDigest
const definition = {kind:"holon-task-runtime-definition",schemaVersion:HOLON_TASK_RUNTIME_DEFINITION_SCHEMA_VERSION,definitionRef:ref("Runtime"),version:"1.0.0",rootHolonRef:"holon-product",executionBinding:{ref:ref("Binding"),digest},taskSpace:{profileRef:ref("Profile"),policyRef:ref("RuntimePolicy"),requiredRoleRefs:["role-worker"],requiredCapabilityRefs:[ref("Capability")]},input:{schemaRef:ref("Input")},output:{schemaRef:ref("Output"),materialPortRefs:[ref("Result")]},defaultForHolon:true}
await put("runtimes/Product.xnl",`<HolonTaskRuntimeDefinition #eidolon.product.Runtime ${env} {definitionBytesBase64="${Buffer.from(canonicalHolonTaskRuntimeDefinitionBytes(definition)).toString("base64")}"}>`)
await registry.snapshot().catch(e=>{console.error(JSON.stringify(e.diagnostics));throw e})
return {root,resources,bindingDigest:digest,holon:"holon-product",member:"member-worker",tools:["Skill","WorkflowFulfill"]}
}

if (import.meta.main) console.log(JSON.stringify(await prepareSkillDrivenOrganizationWorkspace(process.argv[2]!)))
