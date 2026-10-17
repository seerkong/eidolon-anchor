import {expect,test} from 'bun:test';
import {parseWorkflowTaskTreeSpec,parseWorkflowTaskTreeProposal,compileWorkflowTaskTreeProposal,workflowTaskTreeRecipientKey,workflowTaskTreeRootId} from '../../cell/packages/ai-runtime-host-logic/src/workflowTaskTrees';
const spec=()=>parseWorkflowTaskTreeSpec({schemaVersion:'eidolon.workflow-tasktree/v1',taskSpaceId:'global-'+ 'a'.repeat(32)+'-'+ 'b'.repeat(32),name:'Explicit tree',mode:'sequential',limits:{maxTasks:8,maxDepth:3,maxPlannerCalls:1},aggregation:'last',resultSchema:{type:'object'}});
const recipient={kind:'holon' as const,ref:'resource://team',ownerScopeRef:'global',bindingRef:'binding://team',bindingDigest:'sha256:team',admissionRef:'admission-team'};
const origin={daemonId:'daemon',workspaceKey:'workspace',workflowRef:'resource://flow',instanceId:'instance',runId:'run',nodeId:'node',invocationKey:'node#0',generation:0};
const proposal=()=>({schemaVersion:'eidolon.workflow-tasktree-proposal/v1',nodes:[{kind:'task-group',id:'group',parentId:null,name:'Group',mode:'all'},{kind:'task',id:'leaf',parentId:'group',name:'Leaf',recipientKey:workflowTaskTreeRecipientKey(recipient),text:'Original task intent'}]});
test('bounded pure proposal compiles an existing canonical RootPlan with original recipient and stable complete identity',()=>{
 const p=parseWorkflowTaskTreeProposal(proposal(),spec()),directory={ownerScopeRef:'global',registryRevision:'original',contacts:[{recipient,name:'Team',parentRefs:[],available:true}]};
 const plan=compileWorkflowTaskTreeProposal(spec(),p,origin,directory);expect(plan.rootId).toBe(workflowTaskTreeRootId(origin));expect(plan.nodes[1]).toMatchObject({kind:'task',recipient,text:'Original task intent'});expect(plan.nodes[1]!.parentTaskId).toBe(plan.nodes[0]!.taskId);expect(workflowTaskTreeRootId({...origin,generation:1})).not.toBe(plan.rootId);expect(workflowTaskTreeRootId({...origin,invocationKey:'node#1'})).not.toBe(plan.rootId);
 expect(()=>compileWorkflowTaskTreeProposal(spec(),p,origin,{...directory,contacts:[]})).toThrow('recipient_unavailable');
});
test('untrusted nested accessors and caller mutation cannot alter an admitted intent',()=>{
 let reads=0;const node={...proposal().nodes[1],parentId:null};
 Object.defineProperty(node,'text',{enumerable:true,get(){reads++;return 'executed getter'}});
 expect(()=>parseWorkflowTaskTreeProposal({...proposal(),nodes:[node]},spec())).toThrow();expect(reads).toBe(0);
 const input={...proposal(),nodes:[{...proposal().nodes[1],parentId:null}]};
 const admitted=parseWorkflowTaskTreeProposal(input,spec());input.nodes[0]!.text='caller mutation';expect(admitted.nodes[0]).toMatchObject({text:'Original task intent'});
 const mutableRecipient={...recipient},directory={ownerScopeRef:'global',registryRevision:'original',contacts:[{recipient:mutableRecipient,name:'Team',parentRefs:[],available:true}]};
 const plan=compileWorkflowTaskTreeProposal(spec(),admitted,origin,directory);mutableRecipient.ref='foreign';
 expect(plan.nodes[0]).toMatchObject({recipient:{ref:recipient.ref}});expect(Object.isFrozen((plan.nodes[0] as any).recipient)).toBe(true);
 const sparse=new Array(1);expect(()=>parseWorkflowTaskTreeProposal({...proposal(),nodes:sparse},spec())).toThrow();
 const cyclic:any={type:'object'};cyclic.self=cyclic;expect(()=>parseWorkflowTaskTreeSpec({...spec(),resultSchema:cyclic})).toThrow();
});
test('proposal cannot supply task state, cyclic/foreign parents, unsupported modes or unbounded work',()=>{
 const cases=[{...proposal(),nodes:[{...proposal().nodes[1],status:'Succeeded'}]}, {...proposal(),nodes:[{...proposal().nodes[1],parentId:'missing'}]}, {...proposal(),nodes:[{...proposal().nodes[0],parentId:'group'}]}, {...proposal(),nodes:[{...proposal().nodes[0],mode:'any'}]}, {...proposal(),nodes:Array(9).fill(proposal().nodes[1])}];
 for(const value of cases)expect(()=>parseWorkflowTaskTreeProposal(value,spec())).toThrow();
 expect(()=>parseWorkflowTaskTreeSpec({...spec(),cwd:'/arbitrary'})).toThrow();expect(()=>parseWorkflowTaskTreeSpec({...spec(),limits:{...spec().limits,maxPlannerCalls:5}})).toThrow();expect(()=>parseWorkflowTaskTreeSpec({...spec(),taskSpaceId:'private-session-space'})).toThrow();
 let reads=0;const getter=Object.defineProperty({schemaVersion:'eidolon.workflow-tasktree-proposal/v1'},'nodes',{enumerable:true,get(){reads++;return []}});expect(()=>parseWorkflowTaskTreeProposal(getter,spec())).toThrow();expect(reads).toBe(0);
});
