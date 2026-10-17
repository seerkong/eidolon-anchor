import {expect,test} from 'bun:test';
import {InMemoryTaskSpaceOwner,createTaskSpace,claimTask,startTask,heartbeatTaskClaim,cancelTask} from 'task-manager-logic';
import {maintainClaimHeartbeat} from '../../src/organization/HolonTaskRuntimeProcessor';

const config={maxTasks:8,maxRelations:8,maxLeaseDurationMs:90};
const at=(ms:number)=>new Date(Date.UTC(2026,9,11)+ms).toISOString();
async function setup(){
 const owner=new InMemoryTaskSpaceOwner(),runtime={owner};
 await createTaskSpace(runtime,{kind:'task-space.create',commandId:'create',taskSpaceId:'space',createdAt:at(0),definition:{kind:'task-space-definition',taskSpaceId:'space',name:'test',schemaVersion:1,tasks:[{kind:'task',taskId:'task',name:'test',order:0,profile:{kind:'task-profile',profileKind:'fixture',schemaVersion:1},inputArtifacts:[]}],relations:[{kind:'parent-child',relationId:'root',parentTaskId:null,childTaskId:'task',order:0}]}},config);
 const claim=(await claimTask(runtime,{kind:'task.claim',commandId:'claim',taskSpaceId:'space',expectedRevision:0,taskId:'task',assigneeRef:'member',claimedAt:at(1),leaseDurationMs:90},config)).receipt.claim;
 await startTask(runtime,{kind:'task.start',commandId:'start',taskSpaceId:'space',expectedRevision:1,claim,occurredAt:at(2)},config);
 return {owner,runtime,claim};
}
const input={taskSpaceId:'space',taskId:'task',leaseDurationMs:90};

test('same-attempt external renewal replaces the local token, not ownership',async()=>{
 const {owner,runtime,claim}=await setup();let ticks=0,now=0;
 await maintainClaimHeartbeat({taskManager:runtime,clock:{nowEpochMs:()=>now},timer:{async wait(){
   if(ticks++)return false;
   await heartbeatTaskClaim(runtime,{kind:'task.claim-heartbeat',commandId:'pump',taskSpaceId:'space',expectedRevision:2,claim,heartbeatAt:at(61),extendByMs:90},config);
   now=100;return true; // Local token expired at 91, live owner token expires at 151.
 }}},input,claim,config,new AbortController().signal);
 const task=(await owner.readSnapshot('space'))!.tasks[0]!;
 expect(task.activeClaim!.heartbeatAt).toBe(at(101));expect(task.activeClaim!.attempt).toBe(1);expect(task.status).toBe('Running');
});

test('a racing owner CAS reobserves and renews the current token',async()=>{
 const {owner,runtime,claim}=await setup();let now=0,ticks=0,race=true;
 const racedOwner=new Proxy(owner,{get(target,prop){if(prop==='readSnapshot')return async(id:string)=>{
   const observed=await owner.readSnapshot(id);
   if(race){race=false;await heartbeatTaskClaim(runtime,{kind:'task.claim-heartbeat',commandId:'racer',taskSpaceId:'space',expectedRevision:observed!.revision,claim,heartbeatAt:at(20),extendByMs:90},config);}
   return observed;
 };const value=Reflect.get(target,prop);return typeof value==='function'?value.bind(target):value;}});
 await maintainClaimHeartbeat({taskManager:{owner:racedOwner},clock:{nowEpochMs:()=>now},timer:{async wait(){now=30;return ticks++===0;}}},input,claim,config,new AbortController().signal);
 expect((await owner.readSnapshot('space'))!.tasks[0]!.activeClaim!.heartbeatAt).toBe(at(31));
});

test('cancelled authority is a lost capability and never gets another heartbeat',async()=>{
 const {owner,runtime,claim}=await setup();let now=0;
 await expect(maintainClaimHeartbeat({taskManager:runtime,clock:{nowEpochMs:()=>now},timer:{async wait(){
   await cancelTask(runtime,{kind:'task.cancel',commandId:'cancel',taskSpaceId:'space',taskId:'task',expectedRevision:2,cancelledAt:at(10),reason:'owner cancellation'},config);now=30;return true;
 }}},input,claim,config,new AbortController().signal)).rejects.toThrow('EIDOLON_HOLON_TASK_ATTEMPT_STALE');
 expect((await owner.readSnapshot('space'))!.tasks[0]!.status).toBe('Cancelled');
});
