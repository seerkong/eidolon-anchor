import {expect,test} from 'bun:test';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {fixture,client,cli,security} from '../daemon/helpers';
import {serveDaemon} from '../../backend/packages/elysia/src/daemonServe';
import {prepareSkillDrivenOrganizationWorkspace} from '../../cell/packages/ai-organ-logic/tests/workflow/prepareSkillDrivenOrganizationWorkspace';
import {seedTaskTreeFlowResources} from './fixtures/resources';
import {openGlobalTaskSpaceOwner} from '@cell/ai-runtime-host-support';

test('actual project child→parent policy→global child runs both original TaskTrees with real Bash and project resource scope',async()=>{
 const f=await fixture(),globalDir=join(f.globalRoot,'daemon');await mkdir(globalDir,{recursive:true});
 await prepareSkillDrivenOrganizationWorkspace(globalDir,{tools:['bash']});await seedTaskTreeFlowResources(f.a);
 await writeFile(join(f.globalRoot,'permissions.json'),JSON.stringify({permission:{'*':'allow'}}));
 const workerCommand=[process.execPath,'--preload',new URL('./fixtures/provider.ts',import.meta.url).pathname,cli,'__daemon-worker'];
 const open=()=>serveDaemon({globalRoot:f.globalRoot,workerCommand,security,listen:{port:0},runtimeConfig:{mcp:false}});
 let server=await open();
 try{
  let request=client(server);const globalKey=server.daemon.capabilities().globalWorkspaceKey,globalGeneration=(await server.daemon.open(globalKey)).serverInstanceId!;
  const registered=await server.daemon.register(f.a),key=registered.workspaceKey;let generation=(await server.daemon.open(key)).serverInstanceId!;
  const call=async(key:string,gen:string,tail:string,body?:unknown)=>{const response=await request(`/workspaces/${key}${tail}`,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)},gen);if(response.status!==200)throw new Error(`${response.status} ${await response.text()}`);return response.json()};
  const created=await call(globalKey,globalGeneration,'/task-spaces/commands',{kind:'create',commandId:'space',expectedServerInstanceId:globalGeneration,name:'Actual daemon original space'});
  const definitions=(await call(key,generation,'/workflows/definitions')).definitions,receipts:any[]=[];
  for(const fqn of ['eidolon.fixture.TaskTreeCtrl','eidolon.fixture.TaskTreeData']){
   const definition=definitions.find((d:any)=>d.fqn===fqn),input=definition.form==='AIDataWorkflow'?{value:{taskSpaceId:created.taskSpaceId}}:{taskSpaceId:created.taskSpaceId};
   const receipt=await call(key,generation,'/workflows/commands',{kind:'start',commandId:fqn,expectedServerInstanceId:generation,workflowRef:definition.workflowRef,definitionRevision:definition.revision,input,source:{kind:'independent',channelId:'workflow-center',label:'Workflow center'},confirmed:true});receipts.push(receipt);
   const deadline=Date.now()+20000;let view=await call(key,generation,`/workflows/runs/${receipt.runId}`);
   while(!view.run.terminal){if(Date.now()>deadline)throw new Error(JSON.stringify(view));await Bun.sleep(30);view=await call(key,generation,`/workflows/runs/${receipt.runId}`)}
   if(!['Completed','Succeeded'].includes(view.run.status))throw new Error(JSON.stringify({view,snapshot:await openGlobalTaskSpaceOwner(globalDir).readSnapshot(created.taskSpaceId),history:await openGlobalTaskSpaceOwner(globalDir).readHistory(created.taskSpaceId),providerProject:existsSync(join(f.a,'tasktree-provider-calls.jsonl'))?await readFile(join(f.a,'tasktree-provider-calls.jsonl'),'utf8'):null,providerGlobal:existsSync(join(globalDir,'tasktree-provider-calls.jsonl'))?await readFile(join(globalDir,'tasktree-provider-calls.jsonl'),'utf8'):null}));
   expect(view.taskTrees).toHaveLength(1);expect(view.taskTrees[0].admitted).toBe(true);
  }
  expect((await call(globalKey,globalGeneration,`/task-spaces/${created.taskSpaceId}`)).rootCount).toBe(2);
  expect((await readFile(join(f.a,'tasktree-cwd.txt'),'utf8')).trim()).toBe(f.a);expect(existsSync(join(globalDir,'tasktree-cwd.txt'))).toBe(false);
  const count=async()=>(await readFile(join(f.a,'tasktree-provider-calls.jsonl'),'utf8')).trim().split('\n').length;expect(await count()).toBe(4);
  await server.close();server=await open();request=client(server);generation=(await server.daemon.open(key)).serverInstanceId!;
  for(const receipt of receipts){const view=await call(key,generation,`/workflows/runs/${receipt.runId}`);expect(view.run.terminal).toBe(true);expect(view.taskTrees[0].admitted).toBe(true)}
  await Bun.sleep(100);expect(await count()).toBe(4);expect((await call(key,generation,'/sessions')).sessions).toEqual([]);
 }finally{await server.close();await f.cleanup()}
},60000);
