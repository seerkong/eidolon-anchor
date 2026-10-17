import {expect,test} from 'bun:test'
import {createActor,createVM} from '@cell/ai-core-logic'
import {createAiAgentOrchestratorDriver} from '@cell/ai-organ-logic/OrchestratorDriver'
import {addressedExecutionControl,runAddressedExecutionDriver} from '../../cell/packages/ai-organ-logic/src/agent/AddressedExecutionActivation'

test('addressed execution retains the original driver while waiting; only an explicit exact-owner signal continues it',async()=>{
  const actor=createActor({key:'member'}),vm=createVM({actors:{member:actor},controlActorKey:'member',options:{storage:{files:false,logs:false}}})
  const fiberId=`${actor.key}:${actor.id}`;let steps=0,finished=false
  const driver=createAiAgentOrchestratorDriver({fibers:[{fiberId,vm,actor,messages:[],basePriority:1}],options:{agingStep:0},runStep:async()=>{
    steps++
    if(actor.mailboxes.toolResult.splice(0).length)return {kind:'complete'}
    return {kind:'suspend',reason:'human_answer',suspendPolicy:'continue_others'}
  }})
  const running=runAddressedExecutionDriver(vm,actor,driver,fiberId,true).then(()=>{finished=true})
  try{
    for(let i=0;i<100&&driver.getState().fibers[fiberId]?.status!=='suspended';i++)await Bun.sleep(1)
    expect(driver.getState().fibers[fiberId]?.waitingReason).toBe('human_answer')
    expect(finished).toBe(false);const waitingSteps=steps;await Bun.sleep(10);expect(steps).toBe(waitingSteps)
    expect(addressedExecutionControl(vm,'foreign')).toBeUndefined()
    await expect(runAddressedExecutionDriver(vm,actor,driver,fiberId,true)).rejects.toThrow('ADDRESSED_AGENT_EXECUTION_BUSY')
    addressedExecutionControl(vm,actor.id)!.signal({signalKind:'mailbox_enqueue',mailbox:{kind:'toolResult',payload:{toolCallId:'question',content:'answer'}},idempotencyKey:'answer-question',createdAt:Date.now()})
    await running;expect(finished).toBe(true);expect(driver.getState().fibers[fiberId]?.status).toBe('completed')
    expect(addressedExecutionControl(vm,actor.id)).toBeUndefined()
  }finally{actor.llmAbortController?.abort()}
})

test('claim revocation wakes a suspended native driver and clears only its volatile activation',async()=>{
  const actor=createActor({key:'member'}),vm=createVM({actors:{member:actor},controlActorKey:'member',options:{storage:{files:false,logs:false}}})
  const fiberId=`${actor.key}:${actor.id}`,claim=new AbortController(),llm=new AbortController();actor.llmAbortController=llm
  const driver=createAiAgentOrchestratorDriver({fibers:[{fiberId,vm,actor,messages:[],basePriority:1}],runStep:async()=>({kind:'suspend',reason:'human_answer',suspendPolicy:'continue_others'})})
  const running=runAddressedExecutionDriver(vm,actor,driver,fiberId,true,claim.signal)
  const stopped=running.catch(error=>error.message)
  for(let i=0;i<100&&driver.getState().fibers[fiberId]?.status!=='suspended';i++)await Bun.sleep(1)
  expect(addressedExecutionControl(vm,actor.id)).toBeDefined()
  claim.abort(new Error('owner capability revoked'))
  expect(await stopped).toContain('ADDRESSED_AGENT_CLAIM_LOST')
  expect(llm.signal.aborted).toBe(true)
  expect(addressedExecutionControl(vm,actor.id)).toBeUndefined()
  expect(driver.getState().fibers[fiberId]?.status).not.toBe('completed')
  await expect(runAddressedExecutionDriver(vm,actor,driver,fiberId,true,claim.signal)).rejects.toThrow('owner capability revoked')
})
