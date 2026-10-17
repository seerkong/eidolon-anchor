import {expect,test} from 'bun:test'
import {parseActorManagementCommand,parseActorManagementResult,parseActorSummary} from '../../../../cell/packages/ai-runtime-host-contract/src'
test('closed actor lifecycle wire cannot authorize purge, revive, hide executing work or change identity',()=>{
  const command={commandId:'archive',kind:'archive_actor' as const,expectedServerInstanceId:'server',expectedEpoch:'epoch',expectedLifecycleRevision:0}
  expect(parseActorManagementCommand(command)).toEqual(command)
  for(const change of [{path:'/tmp'},{kind:'purge'},{expectedLifecycleRevision:3},{expectedEpoch:''}])expect(()=>parseActorManagementCommand({...command,...change})).toThrow()
  const result={sessionId:'session',actorId:'actor',commandId:'archive',kind:'archive_actor' as const,submittedEpoch:'epoch',lifecycle:{state:'archived' as const,revision:1,changedAt:10}}
  expect(parseActorManagementResult(result)).toEqual(result)
  for(const lifecycle of [{state:'active',revision:0},{state:'archived',revision:2,changedAt:10},{state:'tombstoned',revision:1,changedAt:10}])expect(()=>parseActorManagementResult({...result,lifecycle})).toThrow()
  const actor={actorId:'actor',displayName:'Actor',executionKind:'interactive' as const,runtimeState:'stopped' as const,lifecycle:result.lifecycle,
    allowedActions:['observe','read_history','delete_actor'] as const,capabilities:{textInput:false,cancelTurn:false,questionnaireAnswer:false}}
  expect(parseActorSummary(actor)).toEqual(actor)
  for(const change of [{executionKind:'primary'},{runtimeState:'running'},{allowedActions:['send_text']},{capabilities:{...actor.capabilities,textInput:true}},
    {lifecycle:{state:'active',revision:1}},{lifecycle:{state:'archived',revision:0,changedAt:10}}])expect(()=>parseActorSummary({...actor,...change})).toThrow()
})
