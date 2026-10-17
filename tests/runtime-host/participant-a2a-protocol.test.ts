import {test,expect} from 'bun:test'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {AgentCard,SendMessageRequest,ListTasksRequest,GetTaskRequest,CancelTaskRequest,TaskState} from '@a2a-js/sdk'
import {ClientFactory,JsonRpcTransportFactory,ServiceParameters,withA2AExtensions} from '@a2a-js/sdk/client'
import type {RuntimeHostPort,HostParticipantSendCommand} from '@cell/ai-runtime-host-contract'
import {createParticipantA2A,HOLON_PROFILE} from '../../backend/packages/elysia/src/participantA2A'

// Controlled native authority exercises the standard protocol, separate from real-host interop.
test('official A2A streaming, follow-up, cancellation, scoped pagination and admission rejection remain native projections',async()=>{
  const root=await mkdtemp(join(tmpdir(),'participant-protocol-')),service=createParticipantA2A(root)
  const request={principal:{principalId:'owner',grantsVersion:'1'},requestId:'protocol'},base='http://127.0.0.1:9999/v1/workspaces/global'
  const recipient={kind:'member' as const,ref:'member',ownerScopeRef:'global',bindingRef:'binding',bindingDigest:'digest',admissionRef:'admission'}
  const work=new Map<string,any>(),outputs=new Map<string,any[]>();let sends=0,controls=0
  const source=(id:string)=>({admissionId:'admission',taskSpaceId:'space',taskId:id})
  const native={
    async submitExecution(_r:unknown,input:HostParticipantSendCommand){
      if(input.commandId==='reject')throw {status:409,error:{code:'participant_recipient_unavailable'}}
      if(work.has(input.commandId))return;sends++
      work.set(input.commandId,{commandId:input.commandId,task:source(input.commandId),revision:1,status:input.commandId==='question'?'Running':'Succeeded',attempt:1,canCancel:input.commandId==='question',executions:[],questions:input.commandId==='question'?[{state:'pending'}]:[]})
      outputs.set(input.commandId,input.commandId==='question'?[]:[{outputId:'output-'+input.commandId,commandId:input.commandId,source:source(input.commandId),ordinal:1,revision:1,recordedAt:1,kind:'result',text:'complete output '+input.commandId,artifactRefs:[]}])
    },
    executionOutputPage:async()=>({bindingKey:'binding',sessionId:'session',outputs:[...outputs.values()].flat(),deliveries:[]}),
    participantWork:async()=>({bindingKey:'binding',sessionId:'session',work:[...work.values()]}),
    async controlParticipant(_r:unknown,input:any){controls++;const w=work.get(input.commandId);w.questions=[];w.status=input.kind==='cancel'?'Cancelled':'Succeeded';w.canCancel=false;w.revision++},
  } as unknown as RuntimeHostPort
  const fetchImpl=(async(input:any,init:any)=>service.handle(new Request(input,init),request,native,base)) as typeof fetch
  const cardResolver={resolve:async()=>AgentCard.fromJSON(await(await fetchImpl(base+'/.well-known/agent-card.json')).json())}
  const client=await new ClientFactory({transports:[new JsonRpcTransportFactory({fetchImpl})],cardResolver}).createFromUrl(base)
  const options={serviceParameters:ServiceParameters.create(withA2AExtensions(HOLON_PROFILE))}
  const params=(id:string)=>SendMessageRequest.fromJSON({message:{messageId:id,role:'ROLE_USER',parts:[{text:id}],metadata:{[HOLON_PROFILE]:{submission:{commandId:id,bindingKey:'binding',recipient,text:id,contextCut:{schemaVersion:'bridge.im-context/v1',cutId:'cut-'+id,messages:[]}}}},extensions:[HOLON_PROFILE]},configuration:{returnImmediately:true}})
  try{
    const stream=[];for await(const event of client.sendMessageStream(params('stream'),options))stream.push(event)
    expect(stream[0]?.payload?.$case).toBe('task');expect(stream[0]?.payload?.value.status.state).toBe(TaskState.TASK_STATE_COMPLETED)
    const question=await client.sendMessage(params('question'),options);if(!('id' in question))throw Error('task_expected')
    expect(question.status!.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED)
    const answered=await client.sendMessage(SendMessageRequest.fromJSON({message:{messageId:'answer-message',taskId:question.id,contextId:question.contextId,role:'ROLE_USER',parts:[{text:'human answer'}],metadata:{[HOLON_PROFILE]:{control:{kind:'answer',bindingKey:'binding',commandId:'question',questionnaireId:'q',responseText:'human answer'}}},extensions:[HOLON_PROFILE]}}),options)
    expect('id' in answered&&answered.id).toBe(question.id);expect(sends).toBe(2);expect(controls).toBe(1)
    await expect(client.cancelTask(CancelTaskRequest.fromJSON({id:question.id}),options)).rejects.toThrow()
    const rejected=await client.sendMessage(params('reject'),options);expect('id' in rejected&&rejected.status!.state).toBe(TaskState.TASK_STATE_REJECTED);expect(sends).toBe(2)
    const first=await client.listTasks(ListTasksRequest.fromJSON({pageSize:1,includeArtifacts:true}),options)
    expect(first.totalSize).toBe(3);expect(first.tasks).toHaveLength(1);expect(first.nextPageToken).not.toBe('')
    const second=await client.listTasks(ListTasksRequest.fromJSON({pageSize:1,pageToken:first.nextPageToken,includeArtifacts:true}),options)
    expect(second.tasks[0]!.id).not.toBe(first.tasks[0]!.id)
    await expect(client.listTasks(ListTasksRequest.fromJSON({pageSize:1,pageToken:first.nextPageToken,contextId:'foreign-context'}),options)).rejects.toThrow()
    await expect(client.getTask(GetTaskRequest.fromJSON({id:question.id,tenant:'other'}),options)).rejects.toThrow()
    const malformed=await fetchImpl(base+'/a2a',{method:'POST',headers:{'A2A-Version':'1.0','A2A-Extensions':HOLON_PROFILE},body:JSON.stringify({jsonrpc:'2.0',id:'bad',method:'holon.work',params:{bindingKey:'binding',fromProject:true}})})
    expect((await malformed.json() as any).error).toBeDefined()
  }finally{service.close();await rm(root,{recursive:true,force:true})}
})
