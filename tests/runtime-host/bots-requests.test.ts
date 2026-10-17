import {emptyContext} from './fixtures/participant'
import {expect,test} from 'bun:test'
import {Database} from 'bun:sqlite'
import {createActor,createVM} from '@cell/ai-core-logic'
import {createAiAgentOrchestratorDriver} from '@cell/ai-organ-logic/OrchestratorDriver'
import {runAddressedExecutionDriver} from '@cell/ai-organ-logic/agent/AddressedExecutionActivation'
import {questionnaireCoreLogic} from '@cell/ai-organ-logic/composer/AIAgent/tools/Questionnaire/Logic'
import {createExecutionOutputStore} from '../../cell/packages/ai-runtime-host-support/src/executionOutput'
import {createParticipantRuntime} from '../../cell/packages/ai-runtime-host-capsule/src/participantRuntime'
import {parseHostParticipantWorkPage} from '@cell/ai-runtime-host-contract'

// Core questionnaire + original driver + durable outbox. Task observation is an explicit
// controlled port; the full Host/real-model acceptance must cover the canonical task service.
function fixture(channel:string){
  const database=new Database(':memory:'),store=createExecutionOutputStore(database),actor=createActor({key:channel}),vm=createVM({actors:{[channel]:actor},controlActorKey:channel,options:{storage:{files:false,logs:false}}})
  const scope={principalId:'owner',bindingKey:channel},recipient={kind:'member' as const,ref:'member',ownerScopeRef:'workspace',bindingRef:'binding',bindingDigest:'digest',admissionRef:'admission'}
  const task={admissionId:'admission',taskSpaceId:`space-${channel}`,taskId:`task-${channel}`},command={contextCut:emptyContext(),bindingKey:channel,recipient,commandId:'message',text:'question'}
  store.accept(scope,command,0,task)
  let status='Running',revision=1,closed=false,snapshots=0
  const runtime=createParticipantRuntime({binding:{...scope,recipient,sessionId:channel},ready:{vm,actor,activateSessionMaterialization(){},async persistSnapshot(){snapshots++}} as any,
    holon:{capability:{service:{async observe(){return {status,revision,attempt:1}}}},support:{async listSubscriptions(){return []}},async cancelTask(_task:any,input:any){expect(input.expectedRevision).toBe(revision);status='Cancelled';revision++}} as any,
    authorization:{permits:()=>true,currentGrantsVersion:()=> '1'},now:Date.now,isClosed:()=>closed,outputs:store})
  runtime.admitted({taskAttempt:{...task,claimId:'claim',attempt:1},sessionRef:`execution-${channel}`} as any,{actorId:actor.id})
  vm.effects.questionnaires=runtime.questionnaires
  let requested=false
  const fiberId=`${actor.key}:${actor.id}`,driver=createAiAgentOrchestratorDriver({fibers:[{fiberId,vm,actor,messages:[],basePriority:1}],options:{agingStep:0},async runStep(){
    if(actor.mailboxes.toolResult.splice(0).length){actor.mailboxes.control=[];status='Succeeded';revision++;return {kind:'complete'}}
    if(!requested){requested=true;await questionnaireCoreLogic({vm,actor,toolCallId:'tool'} as any,{questionnaireId:`question-${channel}`,title:'完整审批问题',questions:[{id:'choice',prompt:'是否继续？',type:'single_select',choices:['yes','no'],required:true}]},{})}
    return {kind:'suspend',reason:'human_approval',suspendPolicy:'continue_others'}
  }})
  const running=runAddressedExecutionDriver(vm,actor,driver,fiberId,true)
  return {runtime,vm,actor,task,scope,store,running,database,request:{principal:{principalId:'owner',grantsVersion:'1'},requestId:'request'},snapshots:()=>snapshots,close(){closed=true;runtime.stop()}}
}
async function waitQuestion(f:ReturnType<typeof fixture>){for(let i=0;i<200;i++){if(f.vm.sessionState.questionnaires[`question-${f.scope.bindingKey}`]){await f.runtime.flush();return}await Bun.sleep(1)}throw new Error('question_timeout')}

test('two channel questions stay with the original core owner; explicit answer wakes only that driver and publication waits for checkpoint',async()=>{
  const a=fixture('a'),b=fixture('b')
  try{
    await Promise.all([waitQuestion(a),waitQuestion(b)])
    expect(a.snapshots()).toBeGreaterThan(0)
    expect(a.store.outputs(a.scope).outputs.map(p=>p.kind)).toEqual(['question'])
    const before=parseHostParticipantWorkPage(await a.runtime.work(a.request))
    expect(before.work[0]!.questions[0]).toMatchObject({questionnaireId:'question-a',canAnswer:true,state:'pending'})
    expect(before.work[0]!.questions[0]!.questions[0]!.choices).toEqual([{value:'yes',label:'yes'},{value:'no',label:'no'}])
    await expect(a.runtime.control(a.request,{kind:'answer',bindingKey:'a',commandId:'message',questionnaireId:'question-b',responseText:'no'})).rejects.toMatchObject({status:409})
    await expect(a.runtime.control({...a.request,principal:{principalId:'foreign',grantsVersion:'1'}},{kind:'answer',bindingKey:'a',commandId:'message',questionnaireId:'question-a',responseText:'yes'})).rejects.toMatchObject({status:403})
    const result=await a.runtime.control(a.request,{kind:'answer',bindingKey:'a',commandId:'message',questionnaireId:'question-a',responseText:'yes'})
    await a.running
    expect(result.work[0]!.questions[0]!.state).toBe('answered')
    expect(b.vm.sessionState.questionnaires['question-b']!.status).toBe('pending')
    expect((await b.runtime.work(b.request)).work[0]!.questions[0]!.canAnswer).toBe(true)
    // Observing and reading the question never answers it.
    await b.runtime.work(b.request);await b.runtime.outputs(b.request)
    expect(b.vm.sessionState.questionnaires['question-b']!.status).toBe('pending')
    const stopped=b.running.catch(error=>error.message)
    await b.runtime.control(b.request,{kind:'cancel',bindingKey:'b',commandId:'message',controlId:'cancel-b',expectedRevision:1,occurredAt:new Date().toISOString(),reason:'test'})
    expect(await stopped).toBe('participant_work_cancelled')
    expect((await b.runtime.work(b.request)).work[0]).toMatchObject({status:'Cancelled',canCancel:false})
    expect(b.store.outputs(b.scope).outputs.some(p=>p.kind==='result')).toBe(false)
  }finally{a.close();b.close();await Promise.allSettled([a.running,b.running]);a.database.close();b.database.close()}
})

test('restored pending questionnaire remains visible but cannot wake missing execution; shutdown is bounded',async()=>{
  const f=fixture('restart')
  try{
    await waitQuestion(f)
    const stopped=f.running.catch(error=>error.message);f.runtime.stop();await stopped
    const page=await f.runtime.work(f.request)
    expect(page.work[0]!.questions[0]).toMatchObject({state:'pending',canAnswer:false,unavailableReason:'execution_not_active'})
    await expect(f.runtime.control(f.request,{kind:'answer',bindingKey:'restart',commandId:'message',questionnaireId:'question-restart',responseText:'yes'})).rejects.toMatchObject({status:409})
    expect(f.vm.sessionState.questionnaires['question-restart']!.status).toBe('pending')
  }finally{f.close();await Promise.allSettled([f.running]);f.database.close()}
})
