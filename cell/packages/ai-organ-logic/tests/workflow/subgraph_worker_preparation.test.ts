import { describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { testSourceTsconfig } from "./fixtures/test-source-binding"
import { AI_AGENT_DEFINITION_SELECTION_SCHEMA_VERSION } from "ai-workflow-contract"
import {
  AI_DATA_CHILD_AGENT_PREPARATION_EXTENSION_KIND,
  AI_DATA_CHILD_AGENT_PREPARATION_SCHEMA_REF,
  createAIDataChildAgentPreparationExtensionCodecRegistry,
  readAIDataChildAgentPreparationDeclaration,
} from "../../src/workflow/runtime/AIDataChildAgentPreparation"
import { createSubgraphPreparationFixture, childWorkerSource } from "./fixtures/subgraph-worker-preparation-runtime"
import { readAIDataAgentPreparationReceipts } from "../../src/workflow/runtime/AIDataAgentResourcePreparation"
import { normalizeAIDataAutonomousControlState } from "../../src/workflow/runtime/AIDataAutonomousControlLoop"

describe("resource-declared child Worker preparation", () => {
  it("normalizes the frozen declaration and rejects unrecognized or ambiguous preparation slots", () => {
    const declaration = {
      schemaVersion: "eidolon.ai-data-child-agent-preparation/v1",
      sourceNodeInput: "failedWorker",
      nodeId: "worker-v2",
      instanceName: "worker-v2",
      requirement: {
        schemaVersion: AI_AGENT_DEFINITION_SELECTION_SCHEMA_VERSION,
        requirementId: "repair-output", objective: "Repair the verified output",
        requiredToolRefs: [], requiredMaterialPortRefs: [], requiredMessageSourceRefs: [],
      },
      capability: {
        capabilityId: "worker-v2", tag: "TransformNode",
        inputSchemaRefs: { value: "schema://value" }, outputSchemaRefs: { value: "schema://value" }, fixedConfig: {},
      },
    }
    const codec = createAIDataChildAgentPreparationExtensionCodecRegistry()
      .resolve(AI_DATA_CHILD_AGENT_PREPARATION_EXTENSION_KIND)!
    const normalized = codec.codec.normalize(JSON.stringify(declaration))
    const fact = { schemaRef: AI_DATA_CHILD_AGENT_PREPARATION_SCHEMA_REF, revision: 0, value: normalized }
    const extensions = { schemaVersion: "depa.flow-run-step-extensions/v1" as const,
      byStepId: { worker: { [AI_DATA_CHILD_AGENT_PREPARATION_EXTENSION_KIND]: fact } } }
    expect(readAIDataChildAgentPreparationDeclaration(extensions)).toEqual(declaration)
    expect(() => codec.codec.normalize(JSON.stringify({ ...declaration, injected: "unexpected" }))).toThrow()
    expect(() => readAIDataChildAgentPreparationDeclaration({ ...extensions,
      byStepId: { ...extensions.byStepId, other: extensions.byStepId.worker } })).toThrow("DUPLICATE")
    expect(readAIDataChildAgentPreparationDeclaration(undefined)).toBeUndefined()
  })
})

it("runs failed V1 through actual parent selection, native revision, prepared child Worker and original verifier", async () => {
  const fixture = await createSubgraphPreparationFixture()
  try {
    await fixture.service.createInstance({workflowRef:"resource://eidolon.child.Parent",instanceId:"parent-instance",initialInput:{value:"question"}})
    await fixture.service.start({instanceId:"parent-instance",runId:"parent-run",confirmed:true})
    expect(fixture.calls).toEqual(["worker-v1"])
    const oldActor=Object.values(fixture.vm.actors).find(actor=>actor.agentName==="resource://eidolon.child.Worker")!
    const oldPrefix=JSON.stringify(oldActor.systemPrompts)
    expect(await readFile(path.join(fixture.resources,"agents/Worker.xnl"),"utf8")).toBe(childWorkerSource(1))
    const result = await fixture.service.runAutonomousControl("parent-run",fixture.verifier)
    expect(result.state.phase,JSON.stringify({state:result.state,calls:fixture.calls})).toBe("completed")
    expect(fixture.calls).toEqual(["worker-v1","control","select-worker","worker-v2","control"])
    expect(result.checkpoint.output).toEqual({value:"verified answer"})
    expect(JSON.stringify(oldActor.systemPrompts)).toBe(oldPrefix)
    expect(Object.values(fixture.vm.actors).filter(actor=>actor.agentName==="resource://eidolon.child.Worker")).toHaveLength(2)
    expect(await readFile(path.join(fixture.resources,"agents/Worker.xnl"),"utf8")).toBe(childWorkerSource(2))
    const node = result.checkpoint.profile.runGraph.nodes["repair-child"]
    expect(node.childInvocation).toMatchObject({parentInstanceId:"parent-instance",parentRunId:"parent-run"})
    expect(node.childTerminalReceipt).toMatchObject({status:"Succeeded",output:{value:"verified answer"}})
    const checkpoint=await fixture.service.depa.checkpointStore.load({instanceId:node.childInvocation.childInstanceId,runId:node.childInvocation.childRunId})
    const receipts=readAIDataAgentPreparationReceipts(checkpoint?.stepExtensions)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({task:{nodeId:"worker-v2",workflowRef:"resource://eidolon.child.Repair"},instanceName:"worker-v2",authoring:{planDigest:expect.stringMatching(/^sha256:/)}})
    expect(receipts[0].semanticFingerprint).not.toBe(fixture.selectionPayload().feedback.previousExecutionFingerprint)
    expect(await readFile(path.join(fixture.root,"worker-v1.txt"),"utf8")).toBe("incomplete answer")
    expect(await readFile(path.join(fixture.root,"worker-v2.txt"),"utf8")).toBe("verified answer")
    expect(fixture.selectionPayload().authoring.candidates.find((candidate:any)=>candidate.agentDefinitionRef===receipts[0].agentDefinitionRef).authorityText).toBe(childWorkerSource(1))
    const childInstance=await fixture.service.getInstance(node.childInvocation.childInstanceId)
    await expect((fixture.service as any).prepareChildWorkflowWorker(node.childInvocation,node.childFreezeReceipt,childInstance,
      {value:"question",failedWorker:"foreign-attempt"})).rejects.toThrow("RECEIPT_MISMATCH")
    const store=(fixture.service as any).agentPreparationStore
    const list=store.list.bind(store)
    store.list=async()=>[{...receipts[0],capability:{...receipts[0].capability,fixedConfig:{...receipts[0].capability.fixedConfig,injected:"foreign"}}}]
    await expect((fixture.service as any).prepareChildWorkflowWorker(node.childInvocation,node.childFreezeReceipt,childInstance,
      {value:"question",failedWorker:"old"})).rejects.toThrow("RECEIPT_MISMATCH")
    const childDescriptor = await (fixture.service as any).facts.loadDescriptor(node.childInvocation.childRunId)
    const childDefinition = await (fixture.service as any).loadFrozenDefinition(childDescriptor, "AIDataWorkflow")
    await expect((fixture.service as any).createDataDriver(childDescriptor, childDefinition))
      .rejects.toThrow("CHECKPOINT_AUTHORITY_MISMATCH")
    store.list=list
  } catch(error) {
    throw new Error(JSON.stringify((error as any).diagnostics ?? (error as Error).message), {cause:error})
  } finally { await rm(fixture.root,{recursive:true,force:true}) }
},30000)

it("rejects agent-invented feedback references and preserves the cause through later control checkpoints", async () => {
  const fixture=await createSubgraphPreparationFixture({forgeFeedback:true})
  try {
    await fixture.service.createInstance({workflowRef:"resource://eidolon.child.Parent",instanceId:"parent-instance",initialInput:{value:"question"}})
    await fixture.service.start({instanceId:"parent-instance",runId:"parent-run",confirmed:true})
    const result=await fixture.service.runAutonomousControl("parent-run",fixture.verifier)
    expect(result.state.phase).toBe("failed")
    expect((result.state as any).executionFailures).toEqual([{nodeId:"repair-child",generation:1,message:"AI_DATA_CHILD_PREPARATION_FEEDBACK_REF_MISMATCH"}])
    expect(fixture.calls.filter(call=>call.startsWith("worker"))).toEqual(["worker-v1"])
    expect(await readFile(path.join(fixture.resources,"agents/Worker.xnl"),"utf8")).toBe(childWorkerSource(1))
  } finally {await rm(fixture.root,{recursive:true,force:true})}
},30000)

it("shows the actual thrown Worker error to the real frozen controller through validated historical feedback", async () => {
  const fixture=await createSubgraphPreparationFixture({workerThrows:true})
  try {
    await fixture.service.createInstance({workflowRef:"resource://eidolon.child.Parent",instanceId:"parent-instance",initialInput:{value:"question"}})
    await fixture.service.start({instanceId:"parent-instance",runId:"parent-run",confirmed:true})
    const result=await fixture.service.runAutonomousControl("parent-run",fixture.verifier)
    expect(result.state.phase).toBe("failed")
    expect(fixture.controllerPayloads).toHaveLength(1)
    expect(fixture.controllerPayloads[0].executionFailures).toEqual([{nodeId:"old",generation:0,message:"Error: WORKER_EXECUTION_ACTUAL_FAILURE"}])
    expect(result.state.executionFailures).toEqual(fixture.controllerPayloads[0].executionFailures)
    expect(()=>normalizeAIDataAutonomousControlState({...result.state,executionFailures:[{nodeId:"old",generation:-1,message:"forged"}]})).toThrow("non-negative")
  } finally {await rm(fixture.root,{recursive:true,force:true})}
},30000)

for (const window of ["before-child-start", "after-child-descriptor-save", "before-child-checkpoint-create", "after-child-checkpoint-create", "after-child-receipts", "after-child-result"]) {
  it(`recovers parent and child in a fresh OS process at ${window} without repeated model or Worker effects`, async () => {
    const root=await mkdtemp(path.join(os.tmpdir(),"eidolon-child-process-"))
    const run=async(mode:string)=>{
      const process=Bun.spawn([globalThis.process.execPath,"--tsconfig-override",testSourceTsconfig(),
        path.join(import.meta.dir,"fixtures/subgraph-worker-preparation-process.ts"),mode,root,window],{stdout:"pipe",stderr:"pipe"})
      const [stdout,stderr,exitCode]=await Promise.all([new Response(process.stdout).text(),new Response(process.stderr).text(),process.exited])
      return {stdout,stderr,exitCode}
    }
    try{
      const first=await run("run")
      expect(first.exitCode,first.stderr).toBe(73)
      const saved=JSON.parse(await readFile(path.join(root,"before-crash.json"),"utf8"))
      expect(saved.receipts).toHaveLength(1)
      await writeFile(path.join(root,"resources/agents/Worker.xnl"),childWorkerSource(1))
      const second=await run("recover")
      expect(second.exitCode,second.stderr).toBe(0)
      const restored=JSON.parse(second.stdout)
      expect(restored.phase).toBe("completed")
      expect(restored.output).toEqual({value:"verified answer"})
      expect(restored.receipts).toEqual(saved.receipts)
      expect(restored.child.childInvocation).toEqual(saved.child.childInvocation)
      expect(restored.child.childFreezeReceipt).toEqual(saved.child.childFreezeReceipt)
      expect(restored.instance).toMatchObject({status:"Completed",runIds:[saved.child.childInvocation.childRunId]})
      expect(restored.receipt).toMatchObject({runId:saved.child.childInvocation.childRunId,input:{value:"question",failedWorker:"old"}})
      const ledger=(await readFile(path.join(root,"calls.jsonl"),"utf8")).trim().split("\n").map(line=>JSON.parse(line))
      expect(ledger).toEqual(["worker-v1","control","select-worker","worker-v2","control"])
    }finally{await rm(root,{recursive:true,force:true})}
  },60000)
}
