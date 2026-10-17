import {expect,test} from 'bun:test'
import {globalFixture,globalRequest as request} from './fixture'
import type {GlobalTaskRootPlan} from '@cell/ai-runtime-host-contract'
import {openGlobalTaskSpaceOwner} from '@cell/ai-runtime-host-support'
import {expireTaskClaim} from 'task-manager-logic'

test('pause retains in-flight ownership, edits only future work, and resume preserves the original binding',async()=>{
  let release!:()=>void
  const gate=new Promise<void>(resolve=>{release=resolve}),fixture=await globalFixture(call=>call===1?gate:Promise.resolve())
  try{
    const host=fixture.host,server=host.capabilities(request).serverInstanceId
    const base={expectedServerInstanceId:server},created=await host.commandGlobalTaskSpace!(request,{...base,kind:'create',commandId:'create',name:'Controls'})
    const plan:GlobalTaskRootPlan={rootId:'root',name:'Sequential',mode:'sequential',nodes:[{kind:'task',taskId:'a',parentTaskId:'root',name:'First',recipient:fixture.recipient,text:'First'},{kind:'task',taskId:'b',parentTaskId:'root',name:'Future',recipient:fixture.recipient,text:'Original future'}]}
    await host.commandGlobalTaskSpace!(request,{...base,kind:'add_root',commandId:'add',taskSpaceId:created.taskSpaceId,expectedRevision:0,root:plan})
    await host.commandGlobalTaskSpace!(request,{...base,kind:'execute',commandId:'execute',taskSpaceId:created.taskSpaceId,rootId:'root',expectedRevision:1,expectedControlRevision:0})
    let view=await fixture.until(created.taskSpaceId,v=>fixture.calls===1&&v.nodes.find(n=>n.taskId==='a')?.status==='Running'),root=view.nodes.find(n=>n.taskId==='root')!
    const liveDetail=await host.globalTaskDetail!(request,{taskSpaceId:created.taskSpaceId,taskId:'a'})
    const nativeTask=(await openGlobalTaskSpaceOwner(fixture.workDir).readSnapshot(created.taskSpaceId))!.tasks.find(t=>t.taskId==='a')!
    expect(liveDetail.execution).toMatchObject({bindingId:root.bindingId,claimId:nativeTask.activeClaim!.claimId})
    expect(liveDetail.execution?.actorId).toBeDefined();expect(liveDetail.execution?.runtimeSessionKey).toBeDefined();expect(liveDetail.execution?.actorUnavailableReason).toBeUndefined()
    const binding=root.bindingId
    await host.commandGlobalTaskSpace!(request,{...base,kind:'pause',commandId:'pause',taskSpaceId:created.taskSpaceId,rootId:'root',expectedRevision:view.revision,expectedControlRevision:root.controlRevision!})
    view=await host.globalTaskSpace!(request,{taskSpaceId:created.taskSpaceId})
    expect(view.nodes.find(n=>n.taskId==='a')?.status).toBe('Running');expect(fixture.calls).toBe(1)
    release();view=await fixture.until(created.taskSpaceId,v=>v.nodes.find(n=>n.taskId==='a')?.status==='Succeeded')
    await Bun.sleep(50);expect(fixture.calls).toBe(1);expect(view.nodes.find(n=>n.taskId==='b')?.status).toBe('Ready')
    const changed:GlobalTaskRootPlan={...plan,nodes:plan.nodes.map(n=>n.taskId==='b'&&n.kind==='task'?{...n,text:'Edited future',name:'Changed future'}:n)}
    await host.commandGlobalTaskSpace!(request,{...base,kind:'edit_root',commandId:'edit',taskSpaceId:created.taskSpaceId,expectedRevision:view.revision,root:changed})
    view=await host.globalTaskSpace!(request,{taskSpaceId:created.taskSpaceId});root=view.nodes.find(n=>n.taskId==='root')!
    await expect(host.commandGlobalTaskSpace!(request,{...base,kind:'edit_root',commandId:'rewrite',taskSpaceId:created.taskSpaceId,expectedRevision:view.revision,root:{...changed,nodes:changed.nodes.map(n=>n.taskId==='a'?{...n,name:'Rewrite completed'}:n)}})).rejects.toMatchObject({status:409})
    await host.commandGlobalTaskSpace!(request,{...base,kind:'resume',commandId:'resume',taskSpaceId:created.taskSpaceId,rootId:'root',expectedRevision:view.revision,expectedControlRevision:root.controlRevision!})
    view=await fixture.until(created.taskSpaceId,v=>v.nodes.find(n=>n.taskId==='root')?.status==='Succeeded')
    expect(view.nodes.find(n=>n.taskId==='root')?.bindingId).toBe(binding);expect(fixture.calls).toBe(2);expect(view.nodes.find(n=>n.taskId==='b')?.name).toBe('Changed future')
  }finally{release();await fixture.cleanup()}
},30000)

test('cancel stops only its bound live root and lets a different root finish through its original claim',async()=>{
  const releases:Array<()=>void>=[],gates=[1,2].map(()=>new Promise<void>(resolve=>releases.push(resolve))),fixture=await globalFixture(call=>gates[call-1]??Promise.resolve())
  try{
    const host=fixture.host,base={expectedServerInstanceId:host.capabilities(request).serverInstanceId}
    const created=await host.commandGlobalTaskSpace!(request,{...base,kind:'create',commandId:'create',name:'Live root isolation'})
    for(const [index,rootId] of ['a','b'].entries())await host.commandGlobalTaskSpace!(request,{...base,kind:'add_root',commandId:`add-${rootId}`,taskSpaceId:created.taskSpaceId,expectedRevision:index,root:{rootId,name:rootId,mode:'all',nodes:[{kind:'task',taskId:`leaf-${rootId}`,parentTaskId:rootId,name:rootId,recipient:fixture.recipient,text:rootId}]}})
    await host.commandGlobalTaskSpace!(request,{...base,kind:'execute',commandId:'execute-a',taskSpaceId:created.taskSpaceId,rootId:'a',expectedRevision:2,expectedControlRevision:0})
    let view=await fixture.until(created.taskSpaceId,v=>fixture.calls===1&&v.nodes.find(n=>n.taskId==='leaf-a')?.status==='Running')
    await host.commandGlobalTaskSpace!(request,{...base,kind:'execute',commandId:'execute-b',taskSpaceId:created.taskSpaceId,rootId:'b',expectedRevision:view.revision,expectedControlRevision:0})
    view=await fixture.until(created.taskSpaceId,v=>fixture.calls===2&&v.nodes.find(n=>n.taskId==='leaf-b')?.status==='Running')
    await host.commandGlobalTaskSpace!(request,{...base,kind:'cancel',commandId:'cancel-a',taskSpaceId:created.taskSpaceId,rootId:'a',expectedRevision:view.revision,expectedControlRevision:view.nodes.find(n=>n.taskId==='a')!.controlRevision!})
    view=await host.globalTaskSpace!(request,{taskSpaceId:created.taskSpaceId})
    expect(view.nodes.filter(n=>['a','leaf-a'].includes(n.taskId)).every(n=>n.status==='Cancelled')).toBe(true);expect(view.nodes.find(n=>n.taskId==='leaf-b')?.status).toBe('Running')
    releases.forEach(release=>release());view=await fixture.until(created.taskSpaceId,v=>v.nodes.find(n=>n.taskId==='b')?.status==='Succeeded')
    expect(view.nodes.find(n=>n.taskId==='a')?.status).toBe('Cancelled');expect(fixture.calls).toBe(2)
  }finally{releases.forEach(release=>release());await fixture.cleanup()}
},30000)

test('loss of a canonical managed lease blocks automatic replacement and exposes a typed expired source',async()=>{
  let release!:()=>void
  const gate=new Promise<void>(resolve=>{release=resolve}),fixture=await globalFixture(()=>gate)
  try{
    const host=fixture.host,base={expectedServerInstanceId:host.capabilities(request).serverInstanceId}
    const created=await host.commandGlobalTaskSpace!(request,{...base,kind:'create',commandId:'create',name:'Lease loss'})
    await host.commandGlobalTaskSpace!(request,{...base,kind:'add_root',commandId:'add',taskSpaceId:created.taskSpaceId,expectedRevision:0,root:{rootId:'root',name:'Original attempt',mode:'all',nodes:[{kind:'task',taskId:'task',parentTaskId:'root',name:'Task',recipient:fixture.recipient,text:'Original work'}]}})
    await host.commandGlobalTaskSpace!(request,{...base,kind:'execute',commandId:'execute',taskSpaceId:created.taskSpaceId,rootId:'root',expectedRevision:1,expectedControlRevision:0})
    await fixture.until(created.taskSpaceId,v=>fixture.calls===1&&v.nodes.find(n=>n.taskId==='task')?.status==='Running')
    const owner=openGlobalTaskSpaceOwner(fixture.workDir),snapshot=(await owner.readSnapshot(created.taskSpaceId))!,claim=snapshot.tasks.find(t=>t.taskId==='task')!.activeClaim!
    const expired=await expireTaskClaim({owner},{kind:'task.claim-expire',commandId:'lease-expired',taskSpaceId:created.taskSpaceId,expectedRevision:snapshot.revision,claim,observedAt:claim.expiresAt},{})
    release();await Bun.sleep(200)
    const view=await host.globalTaskSpace!(request,{taskSpaceId:created.taskSpaceId})
    expect(view.nodes.find(n=>n.taskId==='root')?.executionState).toBe('unknown');expect(view.nodes.find(n=>n.taskId==='task')?.waits?.[0]).toMatchObject({kind:'lease_expired',canAnswer:false});expect(fixture.calls).toBe(1)
    expect((await owner.readSnapshot(created.taskSpaceId))?.tasks.find(t=>t.taskId==='task')?.attempt).toBe(expired.snapshot.tasks.find(t=>t.taskId==='task')?.attempt)
  }finally{release();await fixture.cleanup()}
},30000)

test('nested root cancellation settles canonical descendants while another root stays untouched',async()=>{
  const fixture=await globalFixture()
  try{
    const host=fixture.host,base={expectedServerInstanceId:host.capabilities(request).serverInstanceId}
    const created=await host.commandGlobalTaskSpace!(request,{...base,kind:'create',commandId:'create',name:'Independent roots'})
    const root:GlobalTaskRootPlan={rootId:'root',name:'Nested',mode:'all',nodes:[{kind:'task-group',taskId:'inner',parentTaskId:'root',name:'Inner',mode:'sequential'},{kind:'task',taskId:'a',parentTaskId:'inner',name:'A',recipient:fixture.recipient,text:'A'},{kind:'task',taskId:'b',parentTaskId:'inner',name:'B',recipient:fixture.recipient,text:'B'}]}
    await host.commandGlobalTaskSpace!(request,{...base,kind:'add_root',commandId:'add',taskSpaceId:created.taskSpaceId,expectedRevision:0,root})
    await host.commandGlobalTaskSpace!(request,{...base,kind:'add_root',commandId:'other',taskSpaceId:created.taskSpaceId,expectedRevision:1,root:{rootId:'other',name:'Other',mode:'all',nodes:[{kind:'task',taskId:'c',parentTaskId:'other',name:'C',recipient:fixture.recipient,text:'C'}]}})
    const cancel={...base,kind:'cancel' as const,commandId:'cancel',taskSpaceId:created.taskSpaceId,rootId:'root',expectedRevision:2,expectedControlRevision:0}
    await host.commandGlobalTaskSpace!(request,cancel)
    const view=await host.globalTaskSpace!(request,{taskSpaceId:created.taskSpaceId})
    expect(view.nodes.filter(n=>['root','inner','a','b'].includes(n.taskId)).every(n=>n.status==='Cancelled')).toBe(true)
    expect(view.nodes.filter(n=>['other','c'].includes(n.taskId)).every(n=>n.status==='Ready')).toBe(true)
    expect(fixture.calls).toBe(0);expect((await host.commandGlobalTaskSpace!(request,cancel)).replayed).toBe(true)
    await fixture.restart();expect((await fixture.host.globalTaskSpace!(request,{taskSpaceId:created.taskSpaceId})).nodes).toEqual(view.nodes);expect(fixture.calls).toBe(0)
  }finally{await fixture.cleanup()}
},30000)
