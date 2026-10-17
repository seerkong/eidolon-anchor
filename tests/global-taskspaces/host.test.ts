import {afterEach,expect,test} from 'bun:test'
import {mkdtemp,mkdir,rm,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {existsSync} from 'node:fs'
import {createHost} from '../../cell/packages/ai-runtime-host-capsule/src/host'
import type {GlobalTaskRootPlan,RuntimeHostPort,HostRequest,HostAuthorizationEffects} from '../../cell/packages/ai-runtime-host-contract/src'
import {openGlobalTaskSpaceOwner} from '@cell/ai-runtime-host-support'
import {controlTaskRoot,prepareTask} from 'task-manager-logic'

const request:HostRequest={principal:{principalId:'owner',grantsVersion:'1'},requestId:'global-test'}
const cleanup:Array<()=>Promise<void>>=[]
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close()})
async function fixture(policy:HostAuthorizationEffects={permits:()=>true,currentGrantsVersion:()=> '1'},global=true){
  const root=await realpath(await mkdtemp(join(tmpdir(),'anchor-global-taskspaces-'))),globalRoot=join(root,'global'),workDir=global?join(globalRoot,'daemon'):join(root,'workspace')
  await mkdir(workDir,{recursive:true})
  let host=await createHost({workDir,globalRoot,authorization:policy,...(global?{globalAuthority:{daemonId:'isolated',globalWorkspaceKey:'global'}}:{})})
  cleanup.push(async()=>{await host.close();await rm(root,{recursive:true,force:true})})
  return {get host(){return host},workDir,async restart(){await host.close();host=await createHost({workDir,globalRoot,authorization:policy,globalAuthority:{daemonId:'isolated',globalWorkspaceKey:'global'}})},get serverId(){return host.capabilities(request).serverInstanceId}}
}
const recipient={kind:'holon' as const,ref:'holon://test',bindingRef:'resource://binding',bindingDigest:'sha256:selection',admissionRef:'test-admission',ownerScopeRef:'global'}
function plan(rootId='root'):GlobalTaskRootPlan{return {rootId,name:rootId,mode:'sequential',nodes:[
  {kind:'task',taskId:`${rootId}-one`,parentTaskId:rootId,name:'First',recipient,text:'First planned task'},
  {kind:'task',taskId:`${rootId}-two`,parentTaskId:rootId,name:'Second',recipient,text:'Second planned task'},
]}}
async function create(f:Awaited<ReturnType<typeof fixture>>,id='create') {return f.host.commandGlobalTaskSpace!(request,{kind:'create',commandId:id,expectedServerInstanceId:f.serverId,name:'Long lived space'})}
test('canonical empty space grows into multiple roots and retains receipts across an idle Host restart',async()=>{
  const f=await fixture();const created=await create(f)
  expect((await f.host.globalTaskSpace!(request,{taskSpaceId:created.taskSpaceId})).nodes).toEqual([])
  const add={kind:'add_root' as const,commandId:'add',expectedServerInstanceId:f.serverId,taskSpaceId:created.taskSpaceId,expectedRevision:0,root:plan()}
  expect(await f.host.globalTaskCreateResult!(request,{commandId:'create'})).toEqual({...created,replayed:true})
  await expect(f.host.globalTaskCreateResult!({...request,principal:{principalId:'other',grantsVersion:'1'}},{commandId:'create'})).rejects.toMatchObject({status:404})
  await expect(f.host.globalTaskCreateResult!(request,{commandId:'missing'})).rejects.toMatchObject({status:404})
  const first=await f.host.commandGlobalTaskSpace!(request,add)
  const second=await f.host.commandGlobalTaskSpace!(request,{...add,commandId:'other',expectedRevision:1,root:plan('other')})
  const replay=await f.host.commandGlobalTaskSpace!(request,add)
  expect(replay).toEqual({...first,replayed:true})
  await expect(f.host.commandGlobalTaskSpace!(request,{...add,root:{...plan(),name:'Different intent'}})).rejects.toMatchObject({status:409,error:{code:'global_command_identity_conflict'}})
  const read=await f.host.globalTaskSpace!(request,{taskSpaceId:created.taskSpaceId})
  expect(read.rootCount).toBe(2);expect(read.taskCount).toBe(6);expect(read.revision).toBe(second.revision)
  expect(read.nodes.filter(n=>n.parentTaskId===null).map(n=>n.executionState)).toEqual(['unbound','unbound'])
  expect(JSON.stringify(read)).not.toContain('First planned task');expect(JSON.stringify(read)).not.toContain('admission')
  expect(existsSync(join(f.workDir,'.eidolon','sessions'))).toBe(false)
  await f.restart()
  expect((await f.host.globalTaskSpace!(request,{taskSpaceId:created.taskSpaceId})).nodes).toEqual(read.nodes)
  expect(await f.host.globalTaskSpaceResult!(request,{taskSpaceId:created.taskSpaceId,commandId:'add'})).toEqual(replay)
  expect((await create(f)).replayed).toBe(true)
})
test('closed public proposals, scope, authorization, server version and stale revisions reject before mutation',async()=>{
  let permitted=true,grants='1'
  const f=await fixture({permits:()=>permitted,currentGrantsVersion:()=>grants});const created=await create(f)
  const base={kind:'add_root' as const,commandId:'add',expectedServerInstanceId:f.serverId,taskSpaceId:created.taskSpaceId,expectedRevision:0,root:plan()}
  await expect(f.host.commandGlobalTaskSpace!(request,{...base,root:{...plan(),nodes:[{...plan().nodes[0],status:'Succeeded'}]}} as any)).rejects.toMatchObject({status:400,error:{code:'invalid_schema'}})
  await expect(f.host.commandGlobalTaskSpace!(request,{...base,expectedServerInstanceId:'stale'})).rejects.toMatchObject({status:409,error:{code:'server_instance_mismatch'}})
  await expect(f.host.globalTaskSpace!(request,{taskSpaceId:'global-00000000000000000000000000000000-00000000000000000000000000000000'})).rejects.toMatchObject({status:404})
  await expect(f.host.globalTaskSpace!(request,{taskSpaceId:created.taskSpaceId,limit:101})).rejects.toMatchObject({status:400})
  permitted=false;await expect(f.host.commandGlobalTaskSpace!(request,base)).rejects.toMatchObject({status:403})
  permitted=true;grants='2';await expect(f.host.globalTaskSpaces!(request,{})).rejects.toMatchObject({status:403})
  grants='1';await f.host.commandGlobalTaskSpace!(request,base)
  await expect(f.host.commandGlobalTaskSpace!(request,{...base,commandId:'stale-revision',root:plan('new')})).rejects.toMatchObject({status:409,error:{code:'global_revision_conflict'}})
  expect((await f.host.globalTaskSpace!(request,{taskSpaceId:created.taskSpaceId})).taskCount).toBe(3)
})
test('directory and tree cursors bind principal, grants, server and canonical revision',async()=>{
  const f=await fixture();const a=await create(f,'a');await create(f,'b')
  const page=await f.host.globalTaskSpaces!(request,{limit:1});expect(page.nextCursor).toBeDefined()
  expect((await f.host.globalTaskSpaces!(request,{limit:1,after:page.nextCursor})).spaces).toHaveLength(1)
  const other={...request,principal:{principalId:'other',grantsVersion:'1'}}
  await expect(f.host.globalTaskSpaces!(other,{limit:1,after:page.nextCursor})).rejects.toMatchObject({status:409,error:{code:'global_taskspace_cursor_changed'}})
  await f.host.commandGlobalTaskSpace!(request,{kind:'add_root',commandId:'add',expectedServerInstanceId:f.serverId,taskSpaceId:a.taskSpaceId,expectedRevision:0,root:plan()})
  await expect(f.host.globalTaskSpaces!(request,{after:page.nextCursor,limit:1})).rejects.toMatchObject({status:409})
  const tree=await f.host.globalTaskSpace!(request,{taskSpaceId:a.taskSpaceId,limit:1});expect(tree.nextCursor).toBeDefined()
  await f.host.commandGlobalTaskSpace!(request,{kind:'pause',commandId:'pause',expectedServerInstanceId:f.serverId,taskSpaceId:a.taskSpaceId,rootId:'root',expectedRevision:1,expectedControlRevision:0})
  await expect(f.host.globalTaskSpace!(request,{taskSpaceId:a.taskSpaceId,after:tree.nextCursor})).rejects.toMatchObject({status:409})
  await f.restart();await expect(f.host.globalTaskSpaces!(request,{after:page.nextCursor})).rejects.toMatchObject({status:409})
})
test('root editing preserves a different canonical root and rejects cross-root task capture',async()=>{
  const f=await fixture();const space=await create(f)
  const add={kind:'add_root' as const,commandId:'add',expectedServerInstanceId:f.serverId,taskSpaceId:space.taskSpaceId,expectedRevision:0,root:plan()}
  await f.host.commandGlobalTaskSpace!(request,add);await f.host.commandGlobalTaskSpace!(request,{...add,commandId:'other',expectedRevision:1,root:plan('other')})
  const prior=await f.host.globalTaskSpace!(request,{taskSpaceId:space.taskSpaceId})
  await f.host.commandGlobalTaskSpace!(request,{...add,kind:'edit_root',commandId:'edit',expectedRevision:2,root:{...plan(),name:'Revised',nodes:plan().nodes.map(n=>({...n,name:'Revised node'}))}})
  const revised=await f.host.globalTaskSpace!(request,{taskSpaceId:space.taskSpaceId})
  expect(revised.nodes.filter(n=>n.taskId.startsWith('other'))).toEqual(prior.nodes.filter(n=>n.taskId.startsWith('other')))
  await expect(f.host.commandGlobalTaskSpace!(request,{...add,kind:'edit_root',commandId:'capture',expectedRevision:3,root:{...plan(),nodes:[{...plan().nodes[0],taskId:'other-one'}]}})).rejects.toMatchObject({status:409,error:{code:'global_task_identity_conflict'}})
})
test('ordinary workspace Host cannot open the global owner',async()=>{
  const f=await fixture(undefined,false)
  await expect(f.host.globalTaskSpaces!(request,{})).rejects.toMatchObject({status:403,error:{code:'global_worker_required'}})
  expect(existsSync(join(f.workDir,'.eidolon','global-taskspaces'))).toBe(false)
})
test('atomic root plan preserves nested sibling intent and rejects foreign or non-root selectors',async()=>{
  let permitted=true
  const f=await fixture({permits:()=>permitted,currentGrantsVersion:()=> '1'}),space=await create(f)
  const root:GlobalTaskRootPlan={rootId:'root',name:'Nested',mode:'all',nodes:[
    {kind:'task-group',taskId:'group',parentTaskId:'root',name:'Group',mode:'sequential'},
    {...plan().nodes[0]!,parentTaskId:'group'},
    {...plan().nodes[1]!,parentTaskId:'group'},
  ]}
  await f.host.commandGlobalTaskSpace!(request,{kind:'add_root',commandId:'add',expectedServerInstanceId:f.serverId,taskSpaceId:space.taskSpaceId,expectedRevision:0,root})
  const selector={taskSpaceId:space.taskSpaceId,rootId:'root'}
  expect(await f.host.globalTaskRootPlan!(request,selector)).toEqual({taskSpaceId:space.taskSpaceId,revision:1,controlRevision:0,paused:true,root})
  const page=await f.host.globalTaskSpace!(request,{taskSpaceId:space.taskSpaceId})
  expect(page.nodes.every(node=>node.planMutable===true)).toBe(true)
  await expect(f.host.globalTaskRootPlan!(request,{...selector,rootId:'group'})).rejects.toMatchObject({status:404})
  await expect(f.host.globalTaskRootPlan!({...request,principal:{principalId:'other',grantsVersion:'1'}},selector)).rejects.toMatchObject({status:404})
  await expect(f.host.globalTaskRootPlan!(request,{...selector,path:'/tmp/private'} as any)).rejects.toMatchObject({status:400})
  permitted=false;await expect(f.host.globalTaskRootPlan!(request,selector)).rejects.toMatchObject({status:403})
})
test('prepared Ready leaf is locked while future work remains mutable and original planning intent survives',async()=>{
  const f=await fixture(),space=await create(f),root=plan()
  await f.host.commandGlobalTaskSpace!(request,{kind:'add_root',commandId:'add',expectedServerInstanceId:f.serverId,taskSpaceId:space.taskSpaceId,expectedRevision:0,root})
  const owner=openGlobalTaskSpaceOwner(f.workDir),at=new Date().toISOString()
  const binding={bindingId:'original-binding',authorityRef:'owner://fixture',executionRef:'execution://fixture',digest:`sha256:${'a'.repeat(64)}` as const}
  const base={kind:'task.root-control' as const,taskSpaceId:space.taskSpaceId,taskId:'root',occurredAt:at}
  await controlTaskRoot({owner},{...base,commandId:'bind',expectedRevision:1,expectedControlRevision:0,action:{kind:'bind',binding}}, {})
  await controlTaskRoot({owner},{...base,commandId:'resume',expectedRevision:2,expectedControlRevision:1,action:{kind:'resume',bindingId:binding.bindingId}}, {})
  await prepareTask({owner},{kind:'task.prepare',commandId:'prepare',taskSpaceId:space.taskSpaceId,taskId:'root-one',rootBindingId:binding.bindingId,expectedRevision:3,preparedAt:at,profile:{kind:'task-profile',profileKind:'fixture.original-runtime',schemaVersion:1,facts:{private:'not public intent'}}}, {})
  await controlTaskRoot({owner},{...base,commandId:'pause',expectedRevision:4,expectedControlRevision:2,action:{kind:'pause'}}, {})
  const view=await f.host.globalTaskSpace!(request,{taskSpaceId:space.taskSpaceId})
  expect(view.nodes.find(n=>n.taskId==='root-one')).toMatchObject({status:'Ready',planMutable:false})
  expect(view.nodes.find(n=>n.taskId==='root-two')).toMatchObject({status:'Pending',planMutable:true})
  expect(await f.host.globalTaskRootPlan!(request,{taskSpaceId:space.taskSpaceId,rootId:'root'})).toEqual({taskSpaceId:space.taskSpaceId,revision:5,controlRevision:3,paused:true,root})
  await expect(f.host.commandGlobalTaskSpace!(request,{kind:'edit_root',commandId:'rewrite-prepared',expectedServerInstanceId:f.serverId,taskSpaceId:space.taskSpaceId,expectedRevision:5,root:{...root,nodes:root.nodes.map(n=>({...n,name:'Rewrite'}))}})).rejects.toMatchObject({status:409})
})
