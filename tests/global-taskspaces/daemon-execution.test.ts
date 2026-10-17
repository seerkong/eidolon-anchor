import {expect,test} from 'bun:test'
import {mkdir,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {fixture,client,cli,security} from '../daemon/helpers'
import {serveDaemon} from '../../backend/packages/elysia/src/daemonServe'
import {seedBotResources} from '../runtime-host/fixtures/bots'
import {openGlobalTaskSpaceOwner} from '@cell/ai-runtime-host-support'

test('real daemon worker executes a canonical multi-step root over HTTP and exposes exact durable history and artifact bytes',async()=>{
  const f=await fixture(),workDir=join(f.globalRoot,'daemon')
  await mkdir(workDir,{recursive:true});await seedBotResources(f.root,workDir)
  const workerCommand=[process.execPath,'--preload',new URL('./fixtures/provider.ts',import.meta.url).pathname,cli,'__daemon-worker']
  const open=()=>serveDaemon({globalRoot:f.globalRoot,workerCommand,security,listen:{port:0},runtimeConfig:{mcp:false}})
  let server=await open()
  try{
    let request=client(server),key=server.daemon.capabilities().globalWorkspaceKey,generation=(await server.daemon.open(key)).serverInstanceId!
    const route=(tail:string)=>`/workspaces/${key}${tail}`
    const get=async(tail:string)=>{const response=await request(route(tail),{},generation);expect(response.status).toBe(200);return response.json()}
    const post=async(value:unknown)=>{const response=await request(route('/task-spaces/commands'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)},generation);expect(response.status).toBe(200);return response.json()}
    const directoryResponse=await request(route('/a2a'),{method:'POST',headers:{'Content-Type':'application/json','A2A-Version':'1.0','A2A-Extensions':'urn:eidolon:holon-participant:1'},body:JSON.stringify({jsonrpc:'2.0',id:'directory',method:'holon.directory',params:{}})},generation)
    expect(directoryResponse.status).toBe(200)
    const recipient=(await directoryResponse.json()).result.contacts.find((contact:any)=>contact.available&&contact.recipient.kind==='holon').recipient
    const created=await post({kind:'create',commandId:'create',expectedServerInstanceId:generation,name:'Actual child worker execution'})
    await post({kind:'add_root',commandId:'add',expectedServerInstanceId:generation,taskSpaceId:created.taskSpaceId,expectedRevision:0,root:{rootId:'root',name:'Sequential root',mode:'sequential',nodes:['one','two'].map(taskId=>({kind:'task',taskId,parentTaskId:'root',name:taskId,recipient,text:`Actual ${taskId}`}))}})
    const execute={kind:'execute',commandId:'execute',expectedServerInstanceId:generation,taskSpaceId:created.taskSpaceId,rootId:'root',expectedRevision:1,expectedControlRevision:0}
    const accepted=await post(execute),deadline=Date.now()+20000
    let view=await get(`/task-spaces/${created.taskSpaceId}`)
    while(view.nodes.some((node:any)=>node.status!=='Succeeded')){if(Date.now()>deadline)throw new Error('actual_daemon_execution_timeout '+JSON.stringify(view));await Bun.sleep(50);view=await get(`/task-spaces/${created.taskSpaceId}`)}
    const owner=openGlobalTaskSpaceOwner(workDir),snapshot=(await owner.readSnapshot(created.taskSpaceId))!
    expect(snapshot.tasks.filter(task=>task.definition.kind==='task').every(task=>task.attempt===1&&Boolean(task.preparationReceiptId)&&task.activeClaim===null)).toBe(true)
    const detail=await get(`/task-spaces/${created.taskSpaceId}/tasks/two`)
    expect(detail.history.some((event:any)=>event.kind==='task.settled')).toBe(true);expect(detail.outputArtifacts).toHaveLength(1)
    const digest=detail.outputArtifacts[0].digest,chunk=await get(`/task-spaces/${created.taskSpaceId}/tasks/two/artifacts/${encodeURIComponent(digest)}`)
    expect(Buffer.from(chunk.bytesBase64,'base64').toString('utf8')).toContain('canonical-daemon-result-2')
    expect((await get('/sessions')).sessions).toHaveLength(0)
    expect((await post(execute)).replayed).toBe(true)
    const count=async()=>(await readFile(join(workDir,'global-provider-calls.jsonl'),'utf8')).trim().split('\n').length
    expect(await count()).toBe(2)
    await server.close();server=await open();request=client(server);key=server.daemon.capabilities().globalWorkspaceKey;generation=(await server.daemon.open(key)).serverInstanceId!
    expect((await get(`/task-spaces/${created.taskSpaceId}`)).nodes.every((node:any)=>node.status==='Succeeded')).toBe(true)
    expect((await get(`/task-spaces/${created.taskSpaceId}/commands/execute`)).receiptId).toBe(accepted.receiptId)
    await Bun.sleep(100);expect(await count()).toBe(2)
  }finally{await server.close();await f.cleanup()}
},60000)
