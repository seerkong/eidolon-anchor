// Explicit paid representative; two leaf tasks, four-request hard ceiling, no benchmark replay.
import assert from 'node:assert/strict'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import {join,resolve} from 'node:path'
import {fixture,cli,client,security} from '../daemon/helpers'
import {serveDaemon} from '../../backend/packages/elysia/src/daemonServe'
import {prepareSkillDrivenOrganizationWorkspace} from '../../cell/packages/ai-organ-logic/tests/workflow/prepareSkillDrivenOrganizationWorkspace'
import {openGlobalTaskSpaceOwner} from '@cell/ai-runtime-host-support'

assert(process.env.ANCHOR_GLOBAL_LIVE_APPROVED==='deepseek-iqingwa/deepseek-v4.1-flash:thinking-high','approved representative profile required')
const output=process.argv[2];assert(output&&output.startsWith('/'),'absolute report path required')
const f=await fixture(),workDir=join(f.globalRoot,'daemon'),audit=join(f.root,'audit.jsonl')
let server:Awaited<ReturnType<typeof serveDaemon>>|undefined
const report:any={passed:false,model:'deepseek-iqingwa/deepseek-v4.1-flash',thinking:'enabled',effort:'high',requestLimit:4,startedAt:new Date().toISOString()}
try{
  const source=JSON.parse(await readFile(join(homedir(),'.eidolon/llm-provider.json'),'utf8')),provider=source.providers.find((p:any)=>p.id==='deepseek-iqingwa'),model=provider?.models.find((m:any)=>m.id==='deepseek-v4.1-flash')
  assert(model,'configured approved model missing')
  await mkdir(workDir,{recursive:true})
  await prepareSkillDrivenOrganizationWorkspace(workDir,{tools:[],prompt:'Execute only the CURRENT canonical task from its content field. Do not call tools. Return one strict JSON object {"value":"requested exact marker"}, without markdown.'})
  await writeFile(join(f.globalRoot,'llm-provider.json'),JSON.stringify({providers:[{...provider,models:[{...model,options:{...model.options,thinking:{type:'enabled'},reasoning_effort:'high',response_format:{type:'json_object'}}}]}]}),{mode:0o600})
  await writeFile(join(f.globalRoot,'agent-present.json'),JSON.stringify({defaultPreset:'live',presets:{live:{primary:{model:report.model}}},fallback:{enabled:false,timeoutMs:150000,chains:{primary:[]}}}),{mode:0o600})
  await writeFile(join(workDir,'.global-live-audit.json'),JSON.stringify({upstream:new URL(provider.options.baseURL??provider.options.base_url).origin,output:audit}),{mode:0o600})
  const open=()=>serveDaemon({globalRoot:f.globalRoot,workerCommand:[process.execPath,'--preload',new URL('./fixtures/live-audit.ts',import.meta.url).pathname,cli,'__daemon-worker'],security,listen:{port:0},runtimeConfig:{model:report.model,mcp:false}})
  server=await open();let request=client(server),key=server.daemon.capabilities().globalWorkspaceKey,generation=(await server.daemon.open(key)).serverInstanceId!
  const route=(tail:string)=>`/workspaces/${key}${tail}`
  const get=async(tail:string)=>{const response=await request(route(tail),{},generation);assert.equal(response.status,200);return response.json()}
  const post=async(value:unknown)=>{const response=await request(route('/task-spaces/commands'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)},generation);assert.equal(response.status,200);return response.json()}
  const directoryResponse=await request(route('/a2a'),{method:'POST',headers:{'Content-Type':'application/json','A2A-Version':'1.0','A2A-Extensions':'urn:eidolon:holon-participant:1'},body:JSON.stringify({jsonrpc:'2.0',id:'directory',method:'holon.directory',params:{}})},generation)
  assert.equal(directoryResponse.status,200)
  const recipient=(await directoryResponse.json()).result.contacts.find((contact:any)=>contact.available&&contact.recipient.kind==='holon').recipient
  const created=await post({kind:'create',commandId:'create',expectedServerInstanceId:generation,name:'Bounded real global execution'})
  await post({kind:'add_root',commandId:'add',expectedServerInstanceId:generation,taskSpaceId:created.taskSpaceId,expectedRevision:0,root:{rootId:'root',name:'Two real canonical tasks',mode:'sequential',nodes:['ONE','TWO'].map(marker=>({kind:'task',taskId:marker,parentTaskId:'root',name:marker,recipient,text:`Reply with exactly GLOBAL_TASK_${marker}_CONFIRMED. Return strict JSON {"value":"GLOBAL_TASK_${marker}_CONFIRMED"}. Do not call tools.`}))}})
  const command={kind:'execute',commandId:'execute',expectedServerInstanceId:generation,taskSpaceId:created.taskSpaceId,rootId:'root',expectedRevision:1,expectedControlRevision:0},accepted=await post(command)
  const deadline=Date.now()+180000;let view:any
  for(;;){view=await get(`/task-spaces/${created.taskSpaceId}`);if(view.nodes.every((n:any)=>n.status==='Succeeded'))break;assert(!view.nodes.some((n:any)=>n.status==='Failed'),'native representative task failed');assert(Date.now()<deadline,'representative deadline exceeded');await Bun.sleep(200)}
  const owner=openGlobalTaskSpaceOwner(workDir),snapshot=(await owner.readSnapshot(created.taskSpaceId))!
  report.taskSpaceId=created.taskSpaceId;report.bindingId=snapshot.tasks.find(task=>task.taskId==='root')!.rootControl!.binding!.bindingId
  report.tasks=[]
  for(const marker of ['ONE','TWO']){
    report.stage=`verify-${marker}`
    const detail=await get(`/task-spaces/${created.taskSpaceId}/tasks/${marker}`),task=snapshot.tasks.find(task=>task.taskId===marker)!
    assert.equal(task.attempt,1);assert(task.preparationReceiptId);assert.equal(task.activeClaim,null);assert(detail.history.some((event:any)=>event.kind==='task.settled'));assert.equal(detail.outputArtifacts.length,1)
    const chunk=await get(`/task-spaces/${created.taskSpaceId}/tasks/${marker}/artifacts/${encodeURIComponent(detail.outputArtifacts[0].digest)}`)
    report.tasks.push({taskId:marker,status:task.status,attempt:task.attempt,preparationReceiptId:task.preparationReceiptId,history:detail.history,outputArtifacts:detail.outputArtifacts})
    report.tasks.at(-1).expectedMarkerPresent=Buffer.from(chunk.bytesBase64,'base64').toString('utf8').includes(`GLOBAL_TASK_${marker}_CONFIRMED`)
    assert(report.tasks.at(-1).expectedMarkerPresent)
  }
  assert.equal((await get('/sessions')).sessions.length,0);assert.equal((await post(command)).replayed,true)
  const readAudit=async()=> (await readFile(audit,'utf8')).trim().split('\n').map(line=>JSON.parse(line))
  const before=await readAudit();assert.equal(before.filter((row:any)=>row.kind==='request').length,2);assert.equal(before.filter((row:any)=>row.kind==='response'&&row.status===200).length,2)
  report.stage='restart-without-replay'
  await server.close();server=await open();request=client(server);key=server.daemon.capabilities().globalWorkspaceKey;generation=(await server.daemon.open(key)).serverInstanceId!
  assert((await get(`/task-spaces/${created.taskSpaceId}`)).nodes.every((n:any)=>n.status==='Succeeded'));assert.equal((await get(`/task-spaces/${created.taskSpaceId}/commands/execute`)).receiptId,accepted.receiptId)
  await Bun.sleep(500);report.providerAudit=await readAudit();assert.equal(report.providerAudit.length,before.length);report.receipt=accepted;report.passed=true
}catch{report.error='representative_acceptance_failed';process.exitCode=1}
finally{try{report.providerAudit=(await readFile(audit,'utf8')).trim().split('\n').map(line=>JSON.parse(line))}catch{};await server?.close();await f.cleanup();report.finishedAt=new Date().toISOString();await mkdir(resolve(output,'..'),{recursive:true});await writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,stage:report.stage,output}))}
