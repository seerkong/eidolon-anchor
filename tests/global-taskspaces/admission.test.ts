import {expect,test} from 'bun:test'
import {InMemoryTaskSpaceOwner} from 'task-manager-logic'
import {commandGlobalTaskSpace,readGlobalTaskSpaceResult,HostProtocolFailure,type GlobalTaskSpaceRuntime} from '@cell/ai-runtime-host-logic'
import {authorizeDaemonPort} from '../../backend/packages/elysia/src/daemonAuthorization'
import {globalRequest as request} from './fixture'

test('grant revocation after the canonical commit preserves unknown outcome and exact queryable receipt',async()=>{
  const owner=Object.assign(new InMemoryTaskSpaceOwner(),{listTaskSpaceIds:async()=>[] as string[]}),compare=owner.compareAndSwap.bind(owner)
  let permitted=true
  owner.compareAndSwap=async commit=>{const result=await compare(commit);permitted=false;return result}
  const runtime:GlobalTaskSpaceRuntime={owner,daemonScope:'isolated',serverInstanceId:'server',now:()=>Date.now(),newId:()=>crypto.randomUUID(),cursors:new Map(),check(){if(!permitted)throw new HostProtocolFailure(403,{code:'forbidden',requestId:request.requestId,retryable:false})}}
  const input={kind:'create' as const,commandId:'create',expectedServerInstanceId:'server',name:'Committed before revoke'}
  await expect(commandGlobalTaskSpace(runtime,request,input)).rejects.toMatchObject({status:403,error:{state:'unknown'}})
  permitted=true
  const replay=await commandGlobalTaskSpace(runtime,request,input)
  expect(replay.replayed).toBe(true);expect(replay.revision).toBe(0)
  expect((await readGlobalTaskSpaceResult(runtime,request,{taskSpaceId:replay.taskSpaceId,commandId:'create'})).receiptId).toBe(replay.receiptId)
})
test('parent daemon policy revocation after IPC acceptance never reports a safe rejection',async()=>{
  let permitted=true,calls=0
  const port=authorizeDaemonPort({async commandGlobalTaskSpace(){calls++;permitted=false;return {commandId:'create',taskSpaceId:'space',revision:0,receiptId:'receipt',replayed:false}}} as any,{permits:()=>permitted,currentGrantsVersion:()=>request.principal.grantsVersion})
  await expect(port.commandGlobalTaskSpace!(request,{kind:'create',commandId:'create',expectedServerInstanceId:'server',name:'space'})).rejects.toMatchObject({status:403,error:{state:'unknown'}})
  expect(calls).toBe(1)
})
