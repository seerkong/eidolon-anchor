import {expect,test} from 'bun:test';
import {mkdir,realpath} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {spawnWorkspaceWorker} from '@cell/ai-runtime-host-support';
import {createWorkflowTaskTreeRelay,workflowTaskTreeRecipientKey} from '@cell/ai-runtime-host-logic';
import {hostOperations,type WorkerConfig,type HostParticipantDirectory} from '@cell/ai-runtime-host-contract';
import {fixture,workerCommand} from '../daemon/helpers';
import {seedBotResources} from '../runtime-host/fixtures/bots';

test('trusted parent relay reaches the real global worker original owner and durable receipt survives worker restart',async()=>{
 const f=await fixture(),globalDir=join(f.globalRoot,'daemon');await mkdir(globalDir,{recursive:true});await seedBotResources(f.root,globalDir);
 const request={requestId:'original-global-ipc',principal:{principalId:'local-owner',grantsVersion:'1'}};
 const config:WorkerConfig={workspace:{workspaceKey:'global',workspaceId:globalDir,workDir:globalDir,revision:1,placement:'independent'},globalRoot:f.globalRoot,principalId:'local-owner',grantsVersion:'1',globalAuthority:{daemonId:'native-ipc',globalWorkspaceKey:'global'},runtimeConfig:{mcp:false}};
 const resources={async acquire(){return {release(){}}}};
 let global=await spawnWorkspaceWorker(config,workerCommand,resources),allowed=true;
 const source={workspaceKey:'project',workspaceId:f.a,workDir:f.a,revision:1,placement:'workspace' as const};
 const relay=createWorkflowTaskTreeRelay({daemonId:'native-ipc',principalId:'local-owner',grantsVersion:'1',globalWorkspaceKey:'global',sourceWorkspace:source,currentWorkspace:()=>source,isSourceReady:()=>true,canonicalDirectory:realpath,verifyWorkflowOrigin:async()=>true,
 authorization:{permits:()=>allowed,currentGrantsVersion:()=> '1'},forward:(request,context,intent)=>global.taskTreeCall!(request,context,intent)});
 try{
  const created=await global.port.commandGlobalTaskSpace!(request,{kind:'create',commandId:'space',expectedServerInstanceId:global.capabilities.serverInstanceId,name:'Original global space'});
  const origin={daemonId:'native-ipc',workspaceKey:'project',workflowRef:'resource://flow',instanceId:'instance',runId:'run',nodeId:'node',invocationKey:'node#0',generation:0};
  const directory=await relay(request,{kind:'directory',origin,taskSpaceId:created.taskSpaceId}) as HostParticipantDirectory;
  const recipient=directory.contacts.find(contact=>contact.available&&contact.recipient.kind==='holon'&&contact.recipient.admissionRef)!.recipient;
  const intent={kind:'admit' as const,origin,expectedRevision:0,spec:{schemaVersion:'eidolon.workflow-tasktree/v1' as const,taskSpaceId:created.taskSpaceId,name:'Explicit tree',mode:'all' as const,limits:{maxTasks:4,maxDepth:3,maxPlannerCalls:1},aggregation:'last' as const,resultSchema:{type:'object'}},proposal:{schemaVersion:'eidolon.workflow-tasktree-proposal/v1' as const,nodes:[{kind:'task' as const,id:'a',parentId:null,name:'Work',recipientKey:workflowTaskTreeRecipientKey(recipient),text:'Original task intent'}]}};
  const admitted=await relay(request,intent) as {rootId:string;revision:number;receiptId:string;replayed:boolean};expect(admitted.replayed).toBe(false);expect(admitted.revision).toBe(1);
  expect((await global.port.globalTaskSpace!(request,{taskSpaceId:created.taskSpaceId})).nodes).toHaveLength(2);
  expect(hostOperations as readonly string[]).not.toContain('taskTreeCall');expect(existsSync(join(globalDir,'.eidolon','sessions'))).toBe(false);
  allowed=false;await expect(relay(request,intent)).rejects.toMatchObject({status:403});allowed=true;
  await global.close();global=await spawnWorkspaceWorker(config,workerCommand,resources);
  expect(await relay(request,intent)).toEqual({...admitted,replayed:true});expect((await global.port.globalTaskSpace!(request,{taskSpaceId:created.taskSpaceId})).revision).toBe(1);
  await expect(global.port.commandGlobalTaskSpace!(request,{kind:'execute',commandId:'double-execute',expectedServerInstanceId:global.capabilities.serverInstanceId,taskSpaceId:created.taskSpaceId,rootId:admitted.rootId,expectedRevision:1,expectedControlRevision:0})).rejects.toMatchObject({error:{code:'global_workflow_root_owned'}});
 }finally{await global.close();await f.cleanup()}
},30000);
