import {expect,test} from 'bun:test';
import {createWorkflowTaskTreeRelay} from '../../cell/packages/ai-runtime-host-logic/src/workflowTaskTreeRelay';
const workspace={workspaceKey:'project',workspaceId:'/registered/project',workDir:'/registered/project',revision:1,placement:'workspace' as const};
const origin={daemonId:'daemon',workspaceKey:'project',workflowRef:'resource://flow',instanceId:'instance',runId:'run',nodeId:'node',invocationKey:'node#0',generation:0};
const space='global-'+'a'.repeat(32)+'-'+'b'.repeat(32);
const request={requestId:'relay-test',principal:{principalId:'owner',grantsVersion:'1'}};
const read={kind:'directory',origin,taskSpaceId:space};
const admit={kind:'admit',origin,expectedRevision:0,spec:{schemaVersion:'eidolon.workflow-tasktree/v1',taskSpaceId:space,name:'Explicit tree',mode:'all',limits:{maxTasks:4,maxDepth:3,maxPlannerCalls:1},aggregation:'last',resultSchema:{type:'object'}},proposal:{schemaVersion:'eidolon.workflow-tasktree-proposal/v1',nodes:[{kind:'task',id:'a',parentId:null,name:'Work',recipientKey:'recipient-a',text:'Original intent'}]}};
function fixture(){
 let allowed=true,grants='1',ready=true,validOrigin=true,current:typeof workspace|undefined={...workspace},canonical=workspace.workspaceId,calls=0,after:()=>void=()=>{};
 const targets:unknown[]=[],contexts:unknown[]=[];
 const relay=createWorkflowTaskTreeRelay({daemonId:'daemon',principalId:'owner',grantsVersion:'1',globalWorkspaceKey:'global',sourceWorkspace:workspace,
 authorization:{permits(_p,target){targets.push(target);return allowed},currentGrantsVersion:()=>grants},currentWorkspace:()=>current,isSourceReady:()=>ready,canonicalDirectory:async()=>canonical,verifyWorkflowOrigin:async()=>validOrigin,
 async forward(_request,context,intent){calls++;contexts.push(context);after();return {kind:intent.kind,accepted:true}}});
 return {relay,targets,contexts,get calls(){return calls},deny(){allowed=false},revoke(){grants='2'},stop(){ready=false},staleOrigin(){validOrigin=false},move(){current={...workspace,workDir:'/foreign'}},remove(){current=undefined},retarget(){canonical='/retargeted'},after(fn:()=>void){after=fn}};
}
test('parent freezes registered workspace and checks workflow plus global owner permission before and after forwarding',async()=>{
 const f=fixture();expect(await f.relay(request,read)).toEqual({kind:'directory',accepted:true});expect(f.calls).toBe(1);
 expect(f.contexts).toEqual([{origin,executionWorkspace:{workspaceKey:'project',workspaceId:workspace.workspaceId,workDir:workspace.workDir}}]);
 expect(f.targets).toContainEqual({kind:'workflows',action:'read',runId:'run'});expect(f.targets).toContainEqual({kind:'global-taskspace',action:'read',taskSpaceId:space});
});
test('foreign identity, changed directory, stopped worker, revoked grants and caller paths reject without forwarding',async()=>{
 const mutations:Array<(f:ReturnType<typeof fixture>)=>void>=[f=>f.deny(),f=>f.revoke(),f=>f.stop(),f=>f.move(),f=>f.remove(),f=>f.retarget(),f=>f.staleOrigin()];
 for(const mutate of mutations){const f=fixture();mutate(f);await expect(f.relay(request,read)).rejects.toBeDefined();expect(f.calls).toBe(0)}
 for(const input of [{...read,cwd:'/foreign'},{...read,origin:{...origin,workspaceKey:'foreign'}},{...read,origin:{...origin,daemonId:'foreign'}},{...read,kind:'execute'}]){const f=fixture();await expect(f.relay(request,input)).rejects.toBeDefined();expect(f.calls).toBe(0)}
 const f=fixture();await expect(f.relay({...request,principal:{principalId:'foreign',grantsVersion:'1'}},read)).rejects.toMatchObject({status:403});expect(f.calls).toBe(0);
});
test('revocation after canonical admission retains unknown outcome and never retries the mutation',async()=>{
 const f=fixture();f.after(()=>f.revoke());await expect(f.relay(request,admit)).rejects.toMatchObject({status:403,error:{state:'unknown'}});expect(f.calls).toBe(1);
});
