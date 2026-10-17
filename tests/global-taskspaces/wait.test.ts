import {expect,test} from 'bun:test'
import {globalFixture,globalRequest as request} from './fixture'

test('domain answers target the exact original actor and claim, retain owner receipts, and never approve another source',async()=>{
  const fixture=await globalFixture(undefined,true)
  try{
    const host=fixture.host,base={expectedServerInstanceId:host.capabilities(request).serverInstanceId}
    const created=await host.commandGlobalTaskSpace!(request,{...base,kind:'create',commandId:'create',name:'Question ownership'})
    await host.commandGlobalTaskSpace!(request,{...base,kind:'add_root',commandId:'add',taskSpaceId:created.taskSpaceId,expectedRevision:0,root:{rootId:'root',name:'Question root',mode:'all',nodes:[{kind:'task',taskId:'task',parentTaskId:'root',name:'Ask',recipient:fixture.recipient,text:'Ask for the required input'}]}})
    await host.commandGlobalTaskSpace!(request,{...base,kind:'execute',commandId:'execute',taskSpaceId:created.taskSpaceId,rootId:'root',expectedRevision:1,expectedControlRevision:0})
    const view=await fixture.until(created.taskSpaceId,v=>v.nodes.find(n=>n.taskId==='task')?.waits?.some(wait=>wait.kind==='domain_question'&&wait.canAnswer)??false),root=view.nodes.find(n=>n.taskId==='root')!,task=view.nodes.find(n=>n.taskId==='task')!,wait=task.waits![0]!
    expect(task.status).toBe('Running');expect(wait.kind).toBe('domain_question');expect(wait.canAnswer).toBe(true);expect(wait.questions?.[0]?.prompt).toBe('Which outcome?');expect(fixture.calls).toBe(1)
    const answer={...base,kind:'answer' as const,commandId:'answer',taskSpaceId:created.taskSpaceId,rootId:'root',taskId:'task',waitRef:wait.sourceRef,responseText:'Q1: approved task outcome',expectedRevision:view.revision,expectedControlRevision:root.controlRevision!}
    await expect(host.commandGlobalTaskSpace!(request,{...answer,commandId:'backend-approval',waitRef:'backend-approval:unrelated'})).rejects.toMatchObject({status:409})
    await expect(host.commandGlobalTaskSpace!(request,{...answer,commandId:'foreign-task',taskId:'missing'})).rejects.toThrow()
    const receipt=await host.commandGlobalTaskSpace!(request,answer)
    expect(receipt.receiptId).toBeDefined()
    await fixture.until(created.taskSpaceId,v=>v.nodes.find(n=>n.taskId==='root')?.status==='Succeeded')
    expect(fixture.calls).toBe(2)
    expect((await host.commandGlobalTaskSpace!(request,answer)).replayed).toBe(true);expect(fixture.calls).toBe(2)
    expect((await host.globalTaskSpace!(request,{taskSpaceId:created.taskSpaceId})).nodes.find(n=>n.taskId==='task')?.waits).toBeUndefined()
    const completed=await host.globalTaskSpace!(request,{taskSpaceId:created.taskSpaceId})
    await host.commandGlobalTaskSpace!(request,{...base,kind:'add_root',commandId:'add-after-question',taskSpaceId:created.taskSpaceId,expectedRevision:completed.revision,root:{rootId:'next-root',name:'After question',mode:'all',nodes:[{kind:'task',taskId:'next-task',parentTaskId:'next-root',name:'Next execution',recipient:fixture.recipient,text:'Execute after the completed question'}]}})
    const next=await host.globalTaskSpace!(request,{taskSpaceId:created.taskSpaceId})
    await host.commandGlobalTaskSpace!(request,{...base,kind:'execute',commandId:'execute-after-question',taskSpaceId:created.taskSpaceId,rootId:'next-root',expectedRevision:next.revision,expectedControlRevision:0})
    await fixture.until(created.taskSpaceId,v=>v.nodes.find(n=>n.taskId==='next-root')?.status==='Succeeded')
    expect(fixture.calls).toBe(3)
    await fixture.restart();expect((await fixture.host.globalTaskSpaceResult!(request,{taskSpaceId:created.taskSpaceId,commandId:'answer'})).receiptId).toBe(receipt.receiptId);expect(fixture.calls).toBe(3)
  }finally{await fixture.cleanup()}
},30000)

test('actual backend permission approval stays with its original capability and rejects ordinary domain answers',async()=>{
  const fixture=await globalFixture(undefined,'permission')
  try{
    const host=fixture.host,base={expectedServerInstanceId:host.capabilities(request).serverInstanceId}
    const created=await host.commandGlobalTaskSpace!(request,{...base,kind:'create',commandId:'create',name:'Backend approval'})
    await host.commandGlobalTaskSpace!(request,{...base,kind:'add_root',commandId:'add',taskSpaceId:created.taskSpaceId,expectedRevision:0,root:{rootId:'root',name:'Permission root',mode:'all',nodes:[{kind:'task',taskId:'task',parentTaskId:'root',name:'Read guarded file',recipient:fixture.recipient,text:'Read the guarded file'}]}})
    await host.commandGlobalTaskSpace!(request,{...base,kind:'execute',commandId:'execute',taskSpaceId:created.taskSpaceId,rootId:'root',expectedRevision:1,expectedControlRevision:0})
    const view=await fixture.until(created.taskSpaceId,v=>v.nodes.find(n=>n.taskId==='task')?.waits?.some(wait=>wait.kind==='backend_approval')??false),root=view.nodes.find(n=>n.taskId==='root')!,wait=view.nodes.find(n=>n.taskId==='task')!.waits![0]!
    expect(wait.canAnswer).toBe(false);expect(wait.questions).toBeUndefined();expect(fixture.calls).toBe(1)
    await expect(host.commandGlobalTaskSpace!(request,{...base,kind:'answer',commandId:'ordinary-yes',taskSpaceId:created.taskSpaceId,rootId:'root',taskId:'task',waitRef:wait.sourceRef,responseText:'yes',expectedRevision:view.revision,expectedControlRevision:root.controlRevision!})).rejects.toMatchObject({status:409})
    await Bun.sleep(50);expect(fixture.calls).toBe(1)
    await fixture.restart()
    const recovered=await fixture.host.globalTaskSpace!(request,{taskSpaceId:created.taskSpaceId}),waits=recovered.nodes.find(node=>node.taskId==='task')!.waits!
    expect(waits.find(row=>row.kind==='backend_approval')).toMatchObject({sourceRef:wait.sourceRef,canAnswer:false})
    expect(waits.some(row=>row.kind==='execution_unknown')).toBe(true);expect(fixture.calls).toBe(1)
    await fixture.host.commandGlobalTaskSpace!(request,{expectedServerInstanceId:fixture.host.capabilities(request).serverInstanceId,kind:'cancel',commandId:'cancel',taskSpaceId:created.taskSpaceId,rootId:'root',expectedRevision:recovered.revision,expectedControlRevision:root.controlRevision!})
    expect((await fixture.host.globalTaskSpace!(request,{taskSpaceId:created.taskSpaceId})).nodes.every(node=>node.status==='Cancelled')).toBe(true)
  }finally{await fixture.cleanup()}
},30000)
