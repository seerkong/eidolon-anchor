import {emptyContext} from './fixtures/participant'
import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openHostSessionRegistry } from '../../cell/packages/ai-runtime-host-support/src'
import { parseHostParticipantSendCommand, parseHostExecutionOutputPage } from '../../cell/packages/ai-runtime-host-contract/src'

const recipient={kind:'member' as const,ref:'member',ownerScopeRef:'workspace',bindingRef:'resource://binding',bindingDigest:'digest',admissionRef:'admission'}
const command={contextCut:emptyContext(),bindingKey:'channel',recipient,commandId:'message',text:'hello',inputJson:'{"text":"hello","other":1}'}
const scope={principalId:'owner',bindingKey:'channel'}
const task={admissionId:'admission',taskSpaceId:'canonical-space',taskId:'canonical-task'}
test('durable IM intent and publication identity: restart, semantic retries, pagination, exact sources, no silent truncation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'bot-publication-'));let registry=openHostSessionRegistry(root)
  try {
    const accepted=registry.executionOutputs.accept(scope,command,1,task)
    expect(accepted.created).toBe(true)
    expect(registry.executionOutputs.accept(scope,{...command,inputJson:'{ "other":1, "text":"hello" }'},2,task).created).toBe(false)
    expect(()=>registry.executionOutputs.accept(scope,{...command,text:'different'},2,task)).toThrow('idempotency_conflict')
    const publication={commandId:command.commandId,kind:'result' as const,text:'complete',artifactRefs:['sha256:artifact'],source:accepted.intent.task}
    expect(()=>registry.executionOutputs.publish(scope,'settled',{...publication,source:{...accepted.intent.task,taskId:'foreign'}},3)).toThrow('participant_source_mismatch')
    const final=registry.executionOutputs.publish(scope,'settled',publication,3)
    expect(registry.executionOutputs.publish(scope,'settled',publication,4)).toEqual(final)
    expect(()=>registry.executionOutputs.publish(scope,'settled',{...publication,text:'changed'},4)).toThrow('participant_publication_conflict')
    const page=registry.executionOutputs.outputs(scope,0,1)
    expect(page.outputs.map(p=>p.kind)).toEqual(['result']);expect(page.nextAfter).toBeUndefined()
    expect(registry.executionOutputs.outputs(scope,0).outputs).toEqual([final])
    expect(registry.executionOutputs.outputs({...scope,principalId:'foreign'}).outputs).toEqual([])
    registry.executionOutputs.delivery(scope,command.commandId,'submitted')
    registry.executionOutputs.delivery(scope,command.commandId,'unknown','late_transport_failure')
    expect(registry.executionOutputs.intent(scope,command.commandId)!.state).toBe('submitted')
    registry.close();registry=openHostSessionRegistry(root)
    expect(registry.executionOutputs.accept(scope,command,5,task).created).toBe(false)
    expect(registry.executionOutputs.outputs(scope).outputs.map(p=>p.ordinal)).toEqual([1])
    expect(registry.executionOutputs.outputs(scope).outputs[0]).toEqual(final)
    const transcript={bindingKey:'channel',sessionId:'session',...registry.executionOutputs.outputs(scope),deliveries:[]}
    expect(parseHostExecutionOutputPage(transcript)).toEqual(transcript)
  } finally {registry.close();await rm(root,{recursive:true,force:true})}
})
test('Bot wire schema is closed and bounded; non-finite/deep structured input cannot enter a canonical task',()=>{
  expect(parseHostParticipantSendCommand(command)).toEqual(command)
  expect(()=>parseHostParticipantSendCommand({...command,actorId:'impersonated'})).toThrow()
  expect(()=>parseHostParticipantSendCommand({...command,inputJson:'{"bad":1e1000}'})).toThrow()
  expect(()=>parseHostParticipantSendCommand({...command,inputJson:'['.repeat(34)+'0'+']'.repeat(34)})).toThrow()
  expect(()=>parseHostParticipantSendCommand({...command,inputJson:'{broken'})).toThrow()
})
test('stage candidates survive the checkpoint/commit crash window with stable identity and exact registered execution',async()=>{
  const root=await mkdtemp(join(tmpdir(),'bot-stage-'));let registry=openHostSessionRegistry(root)
  try{
    const store=registry.executionOutputs;store.accept(scope,command,1,task)
    const source={...task,sessionId:'backing',actorId:'actor',claimId:'claim',attempt:1,executionSessionRef:'exact-member-session'}
    store.execution(scope,command.commandId,source)
    const candidate={key:'committed:actor:record',message:{commandId:command.commandId,kind:'stage' as const,text:'完整的阶段说明',artifactRefs:[],source:task,execution:source,sourceMessageId:'record'}}
    expect(()=>store.prepare(scope,{...candidate,message:{...candidate.message,execution:{...source,executionSessionRef:'foreign'}}})).toThrow('participant_source_mismatch')
    expect(()=>store.prepare(scope,{...candidate,message:{...candidate.message,text:'x'.repeat(512*1024+1)}})).toThrow()
    store.prepare(scope,candidate);store.prepare(scope,candidate)
    expect(store.candidates(scope)).toEqual([candidate]);expect(store.outputs(scope).outputs).toHaveLength(0)
    registry.close();registry=openHostSessionRegistry(root)
    expect(registry.executionOutputs.candidates(scope)).toEqual([candidate])
    const stage=registry.executionOutputs.confirm(scope,candidate.key,20)
    expect(stage?.ordinal).toBe(1);expect(stage?.sourceMessageId).toBe('record')
    expect(registry.executionOutputs.confirm(scope,candidate.key,21)).toBeUndefined()
    expect(registry.executionOutputs.candidates(scope)).toEqual([])
    registry.executionOutputs.prepare(scope,candidate)
    expect(registry.executionOutputs.confirm(scope,candidate.key,22)).toEqual(stage)
    expect(registry.executionOutputs.outputs(scope).outputs).toHaveLength(1)
  }finally{registry.close();await rm(root,{recursive:true,force:true})}
})
