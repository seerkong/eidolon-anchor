import {expect,test} from 'bun:test'
import {globalFixture,globalRequest as request} from './fixture'

test('restart of a paused root retains completed results and future work until explicit recovery of the same binding',async()=>{
  let release!:()=>void
  const gate=new Promise<void>(resolve=>{release=resolve}),fixture=await globalFixture(call=>call===1?gate:Promise.resolve())
  try{
    let host=fixture.host,base={expectedServerInstanceId:host.capabilities(request).serverInstanceId}
    const created=await host.commandGlobalTaskSpace!(request,{...base,kind:'create',commandId:'create',name:'Durable recovery'})
    await host.commandGlobalTaskSpace!(request,{...base,kind:'add_root',commandId:'add',taskSpaceId:created.taskSpaceId,expectedRevision:0,root:{rootId:'root',name:'Recovered root',mode:'sequential',nodes:[{kind:'task',taskId:'a',parentTaskId:'root',name:'First',recipient:fixture.recipient,text:'First'},{kind:'task',taskId:'b',parentTaskId:'root',name:'Future',recipient:fixture.recipient,text:'Future'}]}})
    await host.commandGlobalTaskSpace!(request,{...base,kind:'execute',commandId:'execute',taskSpaceId:created.taskSpaceId,rootId:'root',expectedRevision:1,expectedControlRevision:0})
    let view=await fixture.until(created.taskSpaceId,v=>fixture.calls===1&&v.nodes.find(n=>n.taskId==='a')?.status==='Running'),root=view.nodes.find(n=>n.taskId==='root')!
    await host.commandGlobalTaskSpace!(request,{...base,kind:'pause',commandId:'pause',taskSpaceId:created.taskSpaceId,rootId:'root',expectedRevision:view.revision,expectedControlRevision:root.controlRevision!})
    release();view=await fixture.until(created.taskSpaceId,v=>v.nodes.find(n=>n.taskId==='a')?.status==='Succeeded')
    const binding=root.bindingId,revision=view.revision
    await fixture.restart();host=fixture.host;base={expectedServerInstanceId:host.capabilities(request).serverInstanceId}
    view=await host.globalTaskSpace!(request,{taskSpaceId:created.taskSpaceId});root=view.nodes.find(n=>n.taskId==='root')!
    await Bun.sleep(100);expect(fixture.calls).toBe(1);expect(view.revision).toBe(revision);expect(root.bindingId).toBe(binding);expect(root.executionState).toBe('paused')
    await host.commandGlobalTaskSpace!(request,{...base,kind:'resume',commandId:'resume',taskSpaceId:created.taskSpaceId,rootId:'root',expectedRevision:view.revision,expectedControlRevision:root.controlRevision!})
    view=await fixture.until(created.taskSpaceId,v=>v.nodes.find(n=>n.taskId==='root')?.status==='Succeeded')
    expect(fixture.calls).toBe(2);expect(view.nodes.find(n=>n.taskId==='root')?.bindingId).toBe(binding)
  }finally{release();await fixture.cleanup()}
},30000)

test('closing a root waiting for domain input never answers it or restarts its dispatched model',async()=>{
  const fixture=await globalFixture(undefined,true)
  try{
    const host=fixture.host,base={expectedServerInstanceId:host.capabilities(request).serverInstanceId}
    const created=await host.commandGlobalTaskSpace!(request,{...base,kind:'create',commandId:'create',name:'Interrupted question'})
    await host.commandGlobalTaskSpace!(request,{...base,kind:'add_root',commandId:'add',taskSpaceId:created.taskSpaceId,expectedRevision:0,root:{rootId:'root',name:'Waiting root',mode:'all',nodes:[{kind:'task',taskId:'task',parentTaskId:'root',name:'Ask',recipient:fixture.recipient,text:'Ask for required input'}]}})
    await host.commandGlobalTaskSpace!(request,{...base,kind:'execute',commandId:'execute',taskSpaceId:created.taskSpaceId,rootId:'root',expectedRevision:1,expectedControlRevision:0})
    const before=await fixture.until(created.taskSpaceId,v=>Boolean(v.nodes.find(n=>n.taskId==='task')?.waits?.[0]?.canAnswer))
    await fixture.restart();await Bun.sleep(100)
    const after=await fixture.host.globalTaskSpace!(request,{taskSpaceId:created.taskSpaceId})
    expect(fixture.calls).toBe(1);expect(after.nodes.find(n=>n.taskId==='root')?.bindingId).toBe(before.nodes.find(n=>n.taskId==='root')?.bindingId)
    expect(after.nodes.find(n=>n.taskId==='root')?.executionState).toBe('unknown')
    const waits=after.nodes.find(n=>n.taskId==='task')?.waits??[]
    expect(waits.find(wait=>wait.kind==='execution_unknown')).toMatchObject({canAnswer:false})
    expect(waits.find(wait=>wait.kind==='domain_question')).toMatchObject({canAnswer:false,sourceRef:before.nodes.find(n=>n.taskId==='task')!.waits!.find(wait=>wait.kind==='domain_question')!.sourceRef,questions:[{prompt:'Which outcome?'}]})
    const root=after.nodes.find(n=>n.taskId==='root')!,resume={kind:'resume' as const,commandId:'resume-unknown',expectedServerInstanceId:fixture.host.capabilities(request).serverInstanceId,taskSpaceId:created.taskSpaceId,rootId:'root',expectedRevision:after.revision,expectedControlRevision:root.controlRevision!}
    await expect(fixture.host.commandGlobalTaskSpace!(request,resume)).rejects.toMatchObject({status:409,error:{state:'unknown'}})
    await Bun.sleep(50);expect(fixture.calls).toBe(1)
    expect((await fixture.host.globalTaskSpace!(request,{taskSpaceId:created.taskSpaceId})).revision).toBe(after.revision)
    await fixture.host.commandGlobalTaskSpace!(request,{...resume,kind:'cancel',commandId:'cancel-unknown'})
    expect((await fixture.host.globalTaskSpace!(request,{taskSpaceId:created.taskSpaceId})).nodes.every(n=>n.status==='Cancelled')).toBe(true);expect(fixture.calls).toBe(1)
  }finally{await fixture.cleanup()}
},30000)
