import {expect,test} from 'bun:test';
import {authorizeDaemonPort} from '../../backend/packages/elysia/src/daemonAuthorization';

test('parent HTTP policy retains original task-tree references while withholding resume affordances',async()=>{
 const link={nodeId:'node',generation:0,invocationKey:'node#0',taskSpaceId:'space',rootId:'root',admitted:true,canResume:true};
 const request={principal:{principalId:'reader',grantsVersion:'1'},requestId:'read'};
 const original={taskTrees:[link],waits:[],dataResumes:[]};
 const port=authorizeDaemonPort({workflowRun:async()=>original} as any,{currentGrantsVersion:()=> '1',permits:(_principal,target)=>target.kind!=='workflows'||target.action!=='resume'});
 const view=await port.workflowRun!(request,{runId:'run'});
 expect(view.taskTrees).toEqual([{...link,canResume:false}]);expect(link.canResume).toBe(true);
});
