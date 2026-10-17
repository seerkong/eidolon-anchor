import {expect,test} from 'bun:test'
import {fixture,server,client,workerCommand,security} from '../daemon/helpers'
import {serveDaemon} from '../../backend/packages/elysia/src/daemonServe'

test('public global worker query/create/replan survives daemon restart and parent policy remains authoritative',async()=>{
  const f=await fixture();let deny=false
  const open=()=>serveDaemon({globalRoot:f.globalRoot,workerCommand,runtimeConfig:{mcp:false},listen:{port:0},security:{...security,authorization:{...security.authorization,permits:(_p,target)=>!(deny&&(target.kind==='global-taskspaces'||target.kind==='global-taskspace'))}}})
  let s=await open()
  try{
    let request=client(s),key=s.daemon.capabilities().globalWorkspaceKey,opened=await s.daemon.open(key),generation=opened.serverInstanceId!
    const post=(value:unknown)=>request(`/workspaces/${key}/task-spaces/commands`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)},generation)
    const create={kind:'create',commandId:'public-create',expectedServerInstanceId:generation,name:'Daemon owned space'}
    const response=await post(create);expect(response.status).toBe(200);const space=await response.json()
    expect((await request(`/workspaces/${key}/task-spaces`,{},generation)).status).toBe(200)
    const createResult=await request(`/workspaces/${key}/task-spaces/commands/public-create`,{},generation);expect(createResult.status).toBe(200);expect(await createResult.json()).toMatchObject({...space,requestId:expect.any(String),replayed:true})
    const recipient={kind:'holon',ref:'fixture',bindingRef:'binding',bindingDigest:'frozen',admissionRef:'admission',ownerScopeRef:'global'}
    expect((await post({kind:'add_root',commandId:'public-add',expectedServerInstanceId:generation,taskSpaceId:space.taskSpaceId,expectedRevision:0,root:{rootId:'root',name:'Root',mode:'all',nodes:[{kind:'task',taskId:'leaf',parentTaskId:'root',name:'Leaf',recipient,text:'Durable planning intent'}]}})).status).toBe(200)
    const planPath=`/workspaces/${key}/task-spaces/${space.taskSpaceId}/roots/root/plan`
    const rootPlan=await request(planPath,{},generation)
    expect(rootPlan.status).toBe(200);expect(await rootPlan.json()).toMatchObject({revision:1,controlRevision:0,paused:true,root:{rootId:'root',nodes:[{taskId:'leaf',text:'Durable planning intent'}]}})
    expect((await request(`${planPath}?path=/tmp/private`,{},generation)).status).toBe(400)
    expect((await request(`/workspaces/${key}/task-spaces/${space.taskSpaceId}/roots/leaf/plan`,{},generation)).status).toBe(404)
    const detail=await request(`/workspaces/${key}/task-spaces/${space.taskSpaceId}/tasks/leaf`,{},generation)
    expect(detail.status).toBe(200);expect((await detail.json()).plan.text).toBe('Durable planning intent')
    expect((await request(`/workspaces/${key}/task-spaces/${space.taskSpaceId}/tasks/leaf?path=/tmp/secret`,{},generation)).status).toBe(400)
    expect((await request(`/workspaces/${key}/task-spaces/${space.taskSpaceId}/tasks/leaf/artifacts/sha256%3Amissing`,{},generation)).status).toBe(404)
    expect((await request(`/workspaces/${key}/task-spaces/${space.taskSpaceId}?limit=101`,{},generation)).status).toBe(400)
    expect((await post({...create,commandId:'bad',executionState:'Succeeded'})).status).toBe(400)
    deny=true;expect((await request(planPath,{},generation)).status).toBe(403);expect((await request(`/workspaces/${key}/task-spaces`,{},generation)).status).toBe(403)
    expect((await post({...create,commandId:'denied'})).status).toBe(403);deny=false
    const workspace=await s.daemon.register(f.a),other=await s.daemon.open(workspace.workspaceKey)
    expect((await request(`/workspaces/${workspace.workspaceKey}/task-spaces`,{},other.serverInstanceId)).status).toBe(403)
    await s.close();s=await open();request=client(s);key=s.daemon.capabilities().globalWorkspaceKey;opened=await s.daemon.open(key);generation=opened.serverInstanceId!
    const recovered=await (await request(`/workspaces/${key}/task-spaces/${space.taskSpaceId}`,{},generation)).json()
    expect(recovered.taskCount).toBe(2);expect(recovered.rootCount).toBe(1);expect(recovered.nodes[0].executionState).toBe('unbound')
    const receipt=await (await request(`/workspaces/${key}/task-spaces/${space.taskSpaceId}/commands/public-add`,{},generation)).json()
    expect(receipt.replayed).toBe(true);expect(receipt.revision).toBe(1)
    expect((await post({...create,expectedServerInstanceId:generation})).status).toBe(200)
  }finally{await s.close();await f.cleanup()}
},30000)
