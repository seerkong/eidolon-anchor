import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { AI_AGENT_DEFINITION_SELECTION_SCHEMA_VERSION, depaAIResourceKindContract, type DepaAIResourceKind } from "ai-workflow-contract"
import { createAIDataControlRuntime, freezeAIDataControlCapabilityCatalog } from "ai-data-workflow-logic"
import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { composeToolRegistry } from "../../../src/composer/AIAgent/ToolFuncComposer"
import { appendLiveHistoryMessageToConversationDomainRuntime } from "../../../src/conversation/ConversationDomainRuntime"
import { createAIDataAutonomousControlState } from "../../../src/workflow/runtime/AIDataAutonomousControlLoop"
import { WorkflowRuntimeService } from "../../../src/workflow/runtime/WorkflowRuntimeService"

export const childWorkerRef = "resource://eidolon.child.Worker" as const
const controllerRef = "resource://eidolon.child.Controller" as const
const schema = "schema://eidolon.child/value"
const requirement = { schemaVersion: AI_AGENT_DEFINITION_SELECTION_SCHEMA_VERSION, requirementId: "worker-output-repair",
  objective: "Produce the verified answer from the failure evidence", requiredToolRefs: [], requiredMaterialPortRefs: [], requiredMessageSourceRefs: [] }

export function childWorkerSource(version: 1 | 2): string {
  return `<AIAgentDefinition #eidolon.child.Worker envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 { lifecycle="Active" description="Worker version ${version}" } (
<MessagePrefix [<Message #system {role="system" promptKind="Prompt" promptRef="resource://eidolon.child.PromptV${version}"}>]>
<InputSchemaRef {kind="MessageSchema" ref="resource://eidolon.child.Input"}>
<OutputSchemaRef {kind="MessageSchema" ref="resource://eidolon.child.WorkerOutput"}>
<ToolRefs []><EffectPolicyRef {kind="EffectPolicy" ref="resource://eidolon.child.Safe"}><MaterialPortRefs [<MaterialPortRef #request {kind="MaterialPort" ref="resource://eidolon.child.Request"}>]>
)>`
}

export async function createSubgraphPreparationFixture(options: { root?: string; existing?: boolean; forgeFeedback?: boolean; workerThrows?: boolean } = {}) {
  const root = options.root ?? await mkdtemp(path.join(os.tmpdir(), "eidolon-child-preparation-"))
  const resources = path.join(root, "resources")
  const kinds: Record<string, DepaAIResourceKind> = { workflows: "AIDataWorkflow", agents: "AIAgentDefinition", prompts: "Prompt",
    schemas: "MessageSchema", policies: "EffectPolicy", ports: "MaterialPort", bindings: "MaterialBinding", materials: "RequestMaterial" }
  const catalog = freezeAIDataControlCapabilityCatalog(createAIDataControlRuntime(), {
    schemaVersion: "depa.ai-data-control/v1", catalogId: "child-repair-catalog",
    foundationNodes: {
      entry: { protected: true, inputSchemaRefs: {}, outputSchemaRefs: {value:schema} },
      control: { protected: true, inputSchemaRefs: {value:schema}, outputSchemaRefs: {value:schema} },
      return: { protected: true, inputSchemaRefs: {value:schema}, outputSchemaRefs: {} },
      old: { protected: true, inputSchemaRefs: {value:schema}, outputSchemaRefs: {value:schema} },
    },
    capabilities: { repair: { capabilityId:"repair", tag:"SubFlowNode", nodeType:"subflow",
      inputSchemaRefs:{value:schema,failedWorker:schema},outputSchemaRefs:{value:schema},fixedConfig:{},
      implementation:{kind:"subflow",definitionRef:"resource://eidolon.child.Repair",flowRef:"eager-data-flow://eidolon.child.Repair",
        contractDigest:"sha256:child-repair-contract",callGraphDigest:"sha256:child-repair-calls",transitiveChildFlowRefs:[]} } },
  }, {})
  const goal = {schemaVersion:"depa.ai-data-control/v1" as const,goalId:"repair-answer",objective:"Produce the verified answer",
    verifierRef:"resource://eidolon.child.Verifier" as const,requiredOutputSchemaRef:schema}
  const state = createAIDataAutonomousControlState({controlNodeId:"control",goal,catalog,maxObservedNodes:16,
    controller:{agentDefinitionRef:controllerRef,taskProofRef:"resource://eidolon.child.ControlBinding",instanceName:"controller"},
    budget:{schemaVersion:"depa.ai-data-control/v1",limits:{maxIterations:4,maxOperationsPerDecision:1,maxNoProgressIterations:2},usage:{iteration:0,noProgressIterations:0}}})
  const declaration = {schemaVersion:"eidolon.ai-data-child-agent-preparation/v1",sourceNodeInput:"failedWorker",nodeId:"worker-v2",instanceName:"worker-v2",
    requirement,capability:{capabilityId:"repaired-worker",tag:"TransformNode",inputSchemaRefs:{value:schema},outputSchemaRefs:{value:schema},fixedConfig:{}}}
  const files: Record<string,string> = {
    "manifest.xnl": `<ResourcePackage #eidolon.child.Package envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 {lifecycle="Active" packageVersion="1.0.0"} (<Catalogs [
<Catalog #kinds {kind="KindDefinition" shape="directory" root="vfs://./KindDefinitions/" entry="manifest.xnl"}>
${Object.entries(kinds).map(([id,kind])=>`<Catalog #${id} {kind="${kind}" shape="single-file" root="vfs://./${id}/"}>`).join("\n")}
]>)>`,
    "prompts/V1.xnl": '<Prompt #eidolon.child.PromptV1 envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 {lifecycle="Active" template="WORKER_V1: incomplete recipe"}>',
    "prompts/V2.xnl": '<Prompt #eidolon.child.PromptV2 envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 {lifecycle="Active" template="WORKER_V2: return the verified answer"}>',
    "prompts/Controller.xnl": '<Prompt #eidolon.child.ControlPrompt envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 {lifecycle="Active" template="For controller input return a native graph control decision. For child worker selection return a native Agent selection decision using the supplied authentic observation and feedback."}>',
    "agents/Worker.xnl": childWorkerSource(1),
    "agents/Controller.xnl": `<AIAgentDefinition #eidolon.child.Controller envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 {lifecycle="Active"} (
<MessagePrefix [<Message #system {role="system" promptKind="Prompt" promptRef="resource://eidolon.child.ControlPrompt"}>]>
<InputSchemaRef {kind="MessageSchema" ref="resource://eidolon.child.Input"}><OutputSchemaRef {kind="MessageSchema" ref="resource://eidolon.child.ControllerOutput"}>
<ToolRefs []><EffectPolicyRef {kind="EffectPolicy" ref="resource://eidolon.child.Safe"}>
<MaterialPortRefs [<MaterialPortRef #request {kind="MaterialPort" ref="resource://eidolon.child.Request"}>]>)>`,
    "schemas/Input.xnl": '<MessageSchema #eidolon.child.Input envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 {lifecycle="Stable" schema={type="object"}}>',
    "schemas/WorkerOutput.xnl": '<MessageSchema #eidolon.child.WorkerOutput envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 {lifecycle="Stable" schema={type="object" required=["value"] additionalProperties=false properties={value={type="string"}}}}>',
    // The frozen controller schema explicitly admits both declared invocation contracts.
    "schemas/ControllerOutput.xnl": `<MessageSchema #eidolon.child.ControllerOutput envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 {lifecycle="Stable" schema={anyOf=[
{type="object" required=["schemaVersion" "kind" "decisionId" "goalId" "observationId" "observationDigest" "catalogDigest" "reason"] properties={schemaVersion={const="depa.ai-data-control/v1"} kind={enum=["revise" "complete" "fail"]} decisionId={type="string"} goalId={type="string"} observationId={type="string"} observationDigest={type="string"} catalogDigest={type="string"} reason={type="string"}}}
{type="object" required=["schemaVersion" "mode" "requirementDigest" "candidateSetDigest" "reason"] properties={schemaVersion={const="${AI_AGENT_DEFINITION_SELECTION_SCHEMA_VERSION}"} mode={enum=["select-existing" "author-new" "revise-existing"]} requirementDigest={type="string"} candidateSetDigest={type="string"} reason={type="string"}}}
]}}>`,
    "policies/Safe.xnl": '<EffectPolicy #eidolon.child.Safe envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 {lifecycle="Active" toolMode="none"}>',
    "ports/Request.xnl": '<MaterialPort #eidolon.child.Request envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 {lifecycle="Active" materialKind="RequestMaterial" required=false cardinality="one"} (<SchemaRef {kind="MessageSchema" ref="resource://eidolon.child.Input"}>)>',
    "materials/Request.xnl": '<RequestMaterial #eidolon.child.RequestValue envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 {lifecycle="Active" value={request="repair"}}>',
    "bindings/Control.xnl": '<MaterialBinding #eidolon.child.ControlBinding envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 {lifecycle="Active"} (<AgentTaskRef {workflowKind="AIDataWorkflow" workflowRef="resource://eidolon.child.Parent" nodeId="control" agentDefinitionRef="resource://eidolon.child.Controller"}><PortRef {kind="MaterialPort" ref="resource://eidolon.child.Request"}><MaterialRef {kind="RequestMaterial" ref="resource://eidolon.child.RequestValue"}>)>',
    "bindings/Old.xnl": '<MaterialBinding #eidolon.child.OldBinding envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 {lifecycle="Active"} (<AgentTaskRef {workflowKind="AIDataWorkflow" workflowRef="resource://eidolon.child.Parent" nodeId="old" agentDefinitionRef="resource://eidolon.child.Worker"}><PortRef {kind="MaterialPort" ref="resource://eidolon.child.Request"}><MaterialRef {kind="RequestMaterial" ref="resource://eidolon.child.RequestValue"}>)>',
    "workflows/Parent.xnl": '<AIDataWorkflow #eidolon.child.Parent envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 (<FlowContract #eidolon.child.Parent {inputPorts=["value"] outputPorts=["value"]}><StepSpaceRef {src="parent/steps.xnl"}>)>',
    "workflows/parent/steps.xnl": '<StepSpace #eidolon.child.ParentSteps apiVersion="depa.flows/v1" version="1" [<StepRef #entry {src="parent/entry.xnl"}><StepRef #old {src="parent/old.xnl"}><StepRef #control {src="parent/control.xnl"}><StepRef #return {src="parent/return.xnl"}>]>',
    "workflows/parent/entry.xnl": '<Step #entry (<Core [<EntryNode #entry>]>)>',
    "workflows/parent/old.xnl": '<Step #old (<Core [<TransformNode #old {inputs={value="flow-port://#entry/value"} outputs=["value"] src="vfs://@/flow-code/identity.ts#identity" config={node_type="agent" instanceName="old-worker" agent={agentDefinitionRef="resource://eidolon.child.Worker" taskProofRef="resource://eidolon.child.OldBinding"}}}>]>)>',
    "workflows/parent/control.xnl": '<Step #control (<Core [<TransformNode #control {inputs={value="flow-port://#old/value"} outputs=["value"] src="vfs://@/flow-code/identity.ts#identity" config={node_type="manual"}}>]><Extensions [<ExtensionRef {kind="eidolon.ai-data-autonomous-control" src="parent/control-extension.xnl" schema="schema://eidolon.ai-data-autonomous-control/v1"}>]>)>',
    "workflows/parent/control-extension.xnl": `<StepExtension #control {kind="eidolon.ai-data-autonomous-control" schema="schema://eidolon.ai-data-autonomous-control/v1" value=${JSON.stringify(JSON.stringify(state))}}>`,
    "workflows/parent/return.xnl": '<Step #return (<Core [<ReturnNode #return {inputs={value="flow-port://#control/value"}}>]>)>',
    "workflows/Child.xnl": '<AIDataWorkflow #eidolon.child.Repair envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 (<FlowContract #eidolon.child.Repair {inputPorts=["value" "failedWorker"] outputPorts=["value"]}><StepSpaceRef {src="child/steps.xnl"}>)>',
    "workflows/child/steps.xnl": '<StepSpace #eidolon.child.ChildSteps apiVersion="depa.flows/v1" version="1" [<StepRef #entry {src="child/entry.xnl"}><StepRef #worker-v2 {src="child/worker.xnl"}><StepRef #return {src="child/return.xnl"}>]>',
    "workflows/child/entry.xnl": '<Step #entry (<Core [<EntryNode #entry>]>)>',
    "workflows/child/worker.xnl": '<Step #worker-v2 (<Core [<TransformNode #worker-v2 {inputs={value="flow-port://#entry/value"} outputs=["value"] src="vfs://@/flow-code/identity.ts#identity" config={preparedAgent="repaired-worker"}}>]><Extensions [<ExtensionRef {kind="eidolon.ai-data-child-agent-preparation" src="child/preparation.xnl" schema="schema://eidolon.ai-data-child-agent-preparation/v1"}><ExtensionRef {kind="eidolon.ai-data-agent-preparation" src="child/receipts.xnl" schema="schema://eidolon.ai-data-agent-preparation/v1"}>]>)>',
    "workflows/child/preparation.xnl": `<StepExtension #preparation {kind="eidolon.ai-data-child-agent-preparation" schema="schema://eidolon.ai-data-child-agent-preparation/v1" value=${JSON.stringify(JSON.stringify(declaration))}}>`,
    "workflows/child/receipts.xnl": `<StepExtension #receipts {kind="eidolon.ai-data-agent-preparation" schema="schema://eidolon.ai-data-agent-preparation/v1" value=${JSON.stringify(JSON.stringify({schemaVersion:"eidolon.ai-data-agent-preparations/v1",receipts:[]}))}}>`,
    "workflows/child/return.xnl": '<Step #return (<Core [<ReturnNode #return {inputs={value="flow-port://#worker-v2/value"}}>]>)>',
    "flow-code/identity.ts": 'export function identity(runtime, input) { return input }',
  }
  for (const kind of Object.values(kinds)) files[`KindDefinitions/${kind}/manifest.xnl`] = depaAIResourceKindContract(kind).kindDefinitionSource
  if (!options.existing) for (const [name, bytes] of Object.entries(files)) {const target=path.join(resources,name);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,bytes)}
  const calls: string[]=[]
  const recordCall = async (value: string) => { calls.push(value); await appendFile(path.join(root,"calls.jsonl"),`${JSON.stringify(value)}\n`) }
  let service: WorkflowRuntimeService
  let selectionPayload: any
  const controllerPayloads: any[] = []
  const actor=createActor({key:"main",id:"child-preparation-main",llmClient:{type:"openai",async createStream(){async function* stream(){yield {ok:true}};return {stream:stream()}}},modelConfig:{model:"mock"},callbacks:{
    buildToolset:()=>[],processStream:async(vm,child)=>{
      const user=[...child.messages].reverse().find(message=>message.role==="user")
      const payload=JSON.parse(String(user?.content??"{}")).payload
      let output: unknown
      if(child.agentName===controllerRef){
        if(payload.schemaVersion==="eidolon.ai-data-child-worker-selection/v1"){
          await recordCall("select-worker");selectionPayload=payload
          const candidate=payload.observation.candidateSet.candidates.find((candidate:any)=>candidate.agentDefinitionRef===childWorkerRef)
          const authority=payload.authoring.candidates.find((candidate:any)=>candidate.agentDefinitionRef===childWorkerRef)
          output={schemaVersion:AI_AGENT_DEFINITION_SELECTION_SCHEMA_VERSION,mode:"revise-existing",requirementDigest:payload.observation.requirement.requirementDigest,
            candidateSetDigest:payload.observation.candidateSet.candidateSetDigest,candidateRef:childWorkerRef,candidateDigest:candidate.candidateDigest,
            feedback:{observationRef:payload.feedback.observationRef,attemptRef:options.forgeFeedback?"foreign-attempt":payload.feedback.attemptRef,verificationRef:payload.feedback.verificationRef,
              requirementDigest:payload.observation.requirement.requirementDigest,candidateSetDigest:payload.observation.candidateSet.candidateSetDigest,
              candidateDigest:candidate.candidateDigest,previousExecutionFingerprint:payload.feedback.previousExecutionFingerprint},
            proposal:{schemaVersion:"halfcode.resource-authoring/v1",operation:"update",catalogId:"agents",resourceId:"eidolon.child.Worker",kind:"AIAgentDefinition",envelopeVersion:"halfcode.resource-envelope/v1",writerSpecVersion:1,sourceShape:"single-file",documentUri:"vfs://@/agents/Worker.xnl",authorityText:childWorkerSource(2),
              expected:{state:"present",authorityDigest:authority.authorityDigest,registryRevision:payload.observation.candidateSet.registryRevision}},reason:"The actual V1 output failed the original verifier; revise its recipe."}
        }else{
          controllerPayloads.push(payload)
          const observed=payload.observation;await recordCall("control")
          const base={schemaVersion:"depa.ai-data-control/v1",decisionId:`decision-${observed.graph.generation}`,goalId:observed.goalId,observationId:observed.observationId,observationDigest:observed.observationDigest,catalogDigest:observed.catalogDigest,reason:"Use the verified feedback"}
          output=options.workerThrows?{...base,kind:"fail",failureCode:"GOAL_UNREACHABLE"}
            :observed.verifier.status==="passed"?{...base,kind:"complete",verifierFactId:observed.verifier.factId,outputNodeId:"repair-child",outputPort:"value",outputSchemaRef:schema}
            :{...base,kind:"revise",operations:[{op:"add-subflow",nodeId:"repair-child",subflowCapabilityId:"repair",inputs:{value:{kind:"literal",schemaRef:schema,value:"question"},failedWorker:{kind:"literal",schemaRef:schema,value:"old"}}}]}
        }
      }else{
        const version=JSON.stringify(child.systemPrompts).includes("WORKER_V2")?2:1;await recordCall(`worker-v${version}`)
        if(options.workerThrows)throw new Error("WORKER_EXECUTION_ACTUAL_FAILURE")
        const value=version===2?"verified answer":"incomplete answer"
        await writeFile(path.join(root,`worker-v${version}.txt`),value)
        output={value}
      }
      const message={role:"assistant" as const,content:JSON.stringify(output)}
      appendLiveHistoryMessageToConversationDomainRuntime({vm,actorKey:child.key,actorId:child.id,message});return message
    },
  }})
  const vm=createVM({controlActorKey:actor.key,actors:{[actor.key]:actor},registries:{toolRegistry:composeToolRegistry(),agentRegistry:new AgentRegistry({})},outerCtx:{workDir:root,metadata:{sessionDir:path.join(root,"session"),aiWorkflow:{roots:{workspaceRoot:path.join(root,"authoring")}},resourcePackages:{layers:[{id:"workspace",rootDir:resources}]}}}})
  service=new WorkflowRuntimeService({vm,actor} as any)
  const verifier={verify:async({graph}:any)=>{const node=graph.nodes["repair-child"];let material="";try{material=await readFile(path.join(root,"worker-v2.txt"),"utf8")}catch{}
    return {...goal,factId:`verify-${graph.currentGeneration}`,graphGeneration:graph.currentGeneration,status:node?.result?.output?.value==="verified answer"&&material==="verified answer"?"passed":"failed",diagnostics:[{code:"ANSWER_INCOMPLETE",message:"V1 recipe did not produce the verified answer"}]}}}
  return {root,resources,get service(){return service},vm,actor,calls,verifier,controllerPayloads,selectionPayload:()=>selectionPayload,
    restoreRuntime:(restoredVm:typeof vm,restoredActor:typeof actor)=>{service=new WorkflowRuntimeService({vm:restoredVm,actor:restoredActor} as any)} }
}
