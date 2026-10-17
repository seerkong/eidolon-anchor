import {expect,test} from 'bun:test';
import {createWorkflowTaskTreeResourceAdmission} from '../../cell/packages/ai-runtime-host-capsule/src/workflowTaskTreeResources';
const origin={daemonId:'daemon',workspaceKey:'project',workflowRef:'resource://flow',instanceId:'instance',runId:'run',nodeId:'node',invocationKey:'node#0',generation:0};
test('global executor resource admission locks the registered project and releases a lease if permission changes while waiting',async()=>{
 let allowed=true,calls=0,releases=0,revoke=false;const paths:string[]=[];
 const workspace={workspaceKey:'project',workspaceId:'/registered/project',workDir:'/registered/project',revision:1,placement:'workspace' as const};
 const runtime:any={config:{principalId:'owner',grantsVersion:'1'},globalWorkspaceKey:'global',states:new Map([['project','ready']]),workers:new Map([['project',{port:{async workflowRun(){return {workspaceId:workspace.workspaceId,run:{workflowRef:origin.workflowRef,instanceId:origin.instanceId},taskTrees:[{nodeId:'node',generation:0,invocationKey:'node#0',admitted:true,taskSpaceId:'global-'+'a'.repeat(32)+'-'+'b'.repeat(32)}]}}}}]]),effects:{newId:()=>crypto.randomUUID(),canonicalDirectory:async(path:string)=>path,registry:{daemonId:'daemon',list:()=>[workspace]}}};
 const acquire=createWorkflowTaskTreeResourceAdmission({runtime,authorization:{permits:()=>allowed,currentGrantsVersion:()=> '1'},resources:{async acquire(input){calls++;paths.push(input.workDir);if(revoke)allowed=false;return {release(){releases++}}}}});
 const lease=await acquire(origin,{kind:'workspace_mutation',targets:['/registered/project/file']});expect(paths).toEqual(['/registered/project']);lease.release();expect(releases).toBe(1);
 await expect(acquire({...origin,invocationKey:'foreign'}, {kind:'workspace_mutation'})).rejects.toMatchObject({status:403});expect(calls).toBe(1);
 revoke=true;await expect(acquire(origin,{kind:'workspace_mutation'})).rejects.toMatchObject({status:403});expect(calls).toBe(2);expect(releases).toBe(2);
});
