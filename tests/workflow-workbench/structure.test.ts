import {test,expect} from 'bun:test';
import {createAIDataWorkflowRunGraph,applyAIDataWorkflowGraphPatch} from '../../cell/packages/ai-organ-logic/node_modules/ai-data-workflow-logic/src/index';
import {workflowRunStructure,workflowRunResult,workflowExecutionGenerationCurrent} from '@cell/ai-runtime-host-logic';
import {fixture,request,startCommand,waitForRun} from './fixtures/runtime';
test('current Native graph projection includes actual patched nodes and original dependencies without changing frozen definition',async()=>{
  const f=await fixture();
  try{
    const definition=(await f.host.workflowDefinitions!(request)).definitions.find(d=>d.fqn==='eidolon.fixture.DataWorkflow')!;
    const graph=createAIDataWorkflowRunGraph({runId:'original',binding:{kind:'AIDataWorkflow',definition:definition.definition as any}});
    const patched=applyAIDataWorkflowGraphPatch(graph,{patchId:'native-patch',operations:[{op:'add-node',node:{id:'new-native-node',tag:'TransformNode',nodeType:'pure',inputs:{value:{ref:'flow-port://#transform/value',nodeId:'transform',port:'value'}},outputs:['value'],dependsOn:['transform']}}]});
    const structure=workflowRunStructure({kind:'AIDataWorkflow',runGraph:patched},definition) as any;
    const status={form:'AIDataWorkflow',generation:patched.currentGeneration,nodes:Object.values(patched.nodes)};
    expect(patched.currentGeneration).toBe(1);expect(workflowExecutionGenerationCurrent(status,{nodeId:'transform',generation:0})).toBe(true);
    const revised=applyAIDataWorkflowGraphPatch(patched,{patchId:'change-native-node',operations:[{op:'update-node',nodeId:'transform',changes:{inputs:{value:'changed'}}}]});
    expect(workflowExecutionGenerationCurrent({...status,generation:revised.currentGeneration,nodes:Object.values(revised.nodes)},{nodeId:'transform',generation:0})).toBe(false);
    expect(structure.nodes.map((n:any)=>n.id)).toEqual(patched.declarationOrder);
    expect(structure.dependencyEdges).toContainEqual({kind:'dependency',fromNodeId:'transform',toNodeId:'new-native-node'});
    expect((definition.definition as any).nodes.some((n:any)=>n.id==='new-native-node')).toBe(false);
    const receipt=await f.host.commandWorkflow!(request,startCommand(f,definition));
    const view=await waitForRun(f,receipt.runId!);expect((view.structure as any).nodes.map((n:any)=>n.id)).toEqual(view.nodes.map(n=>n.nodeId));expect(view.definition).toEqual(definition);
    await f.restart();expect((await f.host.workflowRun!(request,{runId:receipt.runId!})).structure).toEqual(view.structure);expect(f.calls).toBe(0);
  }finally{await f.close();}
},30000);

test('public run result preserves original business values without exporting private checkpoints',()=>{
 const result=workflowRunResult({form:'AIDataWorkflow',run_id:'run',instance_id:'instance',definition_revision:'frozen',generation:2,status:'Succeeded',terminal:true,nodes:[],output:{config:{value:'original'}},step_extensions:{privatePath:'/private/container'},vars:{runtimeConfig:{apiKey:'private'}}}) as any;
 expect(result.output).toEqual({config:{value:'original'}});expect(result.generation).toBe(2);expect(result).not.toHaveProperty('step_extensions');expect(result).not.toHaveProperty('vars');expect(JSON.stringify(result)).not.toContain('/private/container');
});
