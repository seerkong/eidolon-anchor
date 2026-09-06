import path from "node:path"
import { writeFile } from "node:fs/promises"
import { LocalFileConversationPersistenceRepositoryFactory, LocalFileRuntimeDerivedIndexesStore, LocalFileRuntimeSnapshotRepositoryFactory } from "@cell/ai-support"
import { configureRuntimePersistenceSupport, recoverAiAgentRuntime, saveAiAgentRuntimeSnapshot } from "../../../src/persistence/RuntimeSnapshots"
import { createAiAgentOrchestratorDriver } from "../../../src/OrchestratorDriver"
import { readAIDataAgentPreparationReceipts } from "../../../src/workflow/runtime/AIDataAgentResourcePreparation"
import { createSubgraphPreparationFixture } from "./subgraph-worker-preparation-runtime"

configureRuntimePersistenceSupport({snapshotRepositoryFactory:LocalFileRuntimeSnapshotRepositoryFactory,
  derivedIndexesStore:LocalFileRuntimeDerivedIndexesStore,conversationPersistenceRepositoryFactory:LocalFileConversationPersistenceRepositoryFactory})
const [mode,root,window]=process.argv.slice(2)
const fixture=await createSubgraphPreparationFixture({root,existing:mode==="recover"})
const snapshotInput={sessionDir:path.join(root!,"session"),sessionId:"child-preparation"}
if(mode==="recover"){
  const restored=await recoverAiAgentRuntime({...snapshotInput,llmClient:fixture.actor.llmClient,actorCallbacks:fixture.actor.callbacks,
    registries:fixture.vm.registries,callbacks:fixture.vm.callbacks,effects:fixture.vm.effects,outerCtx:fixture.vm.outerCtx,mcpManager:fixture.vm.mcpManager})
  if(!restored)throw new Error("CHILD_PREPARATION_RUNTIME_RESTORE_MISSING")
  fixture.restoreRuntime(restored.vm,restored.controlActor)
  await fixture.service.start({instanceId:"parent-instance",runId:"parent-run",confirmed:true})
  const completed=await fixture.service.runAutonomousControl("parent-run",fixture.verifier)
  const child=(completed.checkpoint.profile.runGraph as any).nodes["repair-child"]
  const checkpoint=await fixture.service.depa.checkpointStore.load({instanceId:child.childInvocation.childInstanceId,runId:child.childInvocation.childRunId})
  process.stdout.write(JSON.stringify({phase:completed.state.phase,output:completed.checkpoint.output,child,
    receipts:readAIDataAgentPreparationReceipts(checkpoint?.stepExtensions),calls:fixture.calls,
    instance:await fixture.service.getInstance(child.childInvocation.childInstanceId),
    receipt:await (fixture.service as any).facts.loadRunReceipt(child.childInvocation.childRunId)}))
}else{
  await fixture.service.createInstance({workflowRef:"resource://eidolon.child.Parent",instanceId:"parent-instance",initialInput:{value:"question"}})
  await fixture.service.start({instanceId:"parent-instance",runId:"parent-run",confirmed:true})
  const original=fixture.service.start.bind(fixture.service)
  const stop=async()=>{
    const driver=createAiAgentOrchestratorDriver({fibers:Object.values(fixture.vm.actors).map(actor=>({fiberId:`${actor.key}:${actor.id}`,vm:fixture.vm,actor,messages:actor.messages,basePriority:1})),
      runStep:async()=>({kind:"yield" as const}),options:{agingStep:0,defaultSuspendPolicy:"continue_others"}})
    const saved=await saveAiAgentRuntimeSnapshot({...snapshotInput,vm:fixture.vm,driver})
    if(saved.status!=="saved")throw new Error("CHILD_PREPARATION_SNAPSHOT_FAILED")
    const parent=await fixture.service.autonomousControlCheckpoint("parent-run")
    const child=(parent!.profile.runGraph as any).nodes["repair-child"]
    const store=(fixture.service as any).agentPreparationStore
    await writeFile(path.join(root!,"before-crash.json"),JSON.stringify({child,
      receipts:await store.list(child.childInvocation.childInstanceId)}))
    process.exit(73)
  }
  fixture.service.start=async input=>{
    if(input.runId!=="parent-run"&&window==="before-child-start")await stop()
    const result=await original(input)
    if(input.runId!=="parent-run"&&window==="after-child-result")await stop()
    return result
  }
  const facts = (fixture.service as any).facts
  const saveDescriptor = facts.saveDescriptor.bind(facts)
  facts.saveDescriptor = async descriptor => {
    await saveDescriptor(descriptor)
    if (descriptor.runId !== "parent-run" && window === "after-child-descriptor-save") await stop()
  }
  const checkpointStore = fixture.service.depa.checkpointStore
  const commit = checkpointStore.commit.bind(checkpointStore)
  checkpointStore.commit = async input => {
    if (input.checkpoint.runId !== "parent-run" && input.expectedVersion === null
      && window === "before-child-checkpoint-create") await stop()
    const result = await commit(input)
    const interruptedInitialization = (input.expectedVersion === null && window === "after-child-checkpoint-create")
      || (input.expectedVersion === 0 && window === "after-child-receipts")
    if (input.checkpoint.runId !== "parent-run" && interruptedInitialization) await stop()
    return result
  }
  await fixture.service.runAutonomousControl("parent-run",fixture.verifier)
  throw new Error("CHILD_PREPARATION_CRASH_WINDOW_NOT_REACHED")
}
