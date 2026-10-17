import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {seedWorkflowResources} from '../../workflow-workbench/fixtures/runtime';
export async function seedTaskTreeFlowResources(workDir:string,options:{tasks?:number;resultType?:'string'|'integer'}={}){
    await seedWorkflowResources(workDir);const resources=join(workDir,'.eidolon','resources');
    const code=`export async function tree(runtime:any,input:any){return runtime.taskTrees.run({schemaVersion:'eidolon.workflow-tasktree/v1',taskSpaceId:input.taskSpaceId,name:'Explicit node root',mode:'all',limits:{maxTasks:4,maxDepth:3,maxPlannerCalls:1},aggregation:'last',resultSchema:{type:${JSON.stringify(options.resultType??'string')}}},async(contacts:any)=>({schemaVersion:'eidolon.workflow-tasktree-proposal/v1',nodes:Array.from({length:${options.tasks??1}},(_,index)=>({kind:'task',id:'leaf-'+index,parentId:null,name:'Original workspace tool',recipientKey:contacts[0].recipientKey,text:'original.tasktree-cwd'}))}))}
export async function dataTree(runtime:any,inputs:any){return {value:await tree(runtime,inputs.value)}}`;
    for(const kind of ['Workflows','Data'])await writeFile(join(resources,kind,'flow-code','tree.ts'),code);
    await writeFile(join(resources,'Workflows','TaskTree.xnl'),`<AICtrlWorkflow #eidolon.fixture.TaskTreeCtrl envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 (<FlowContract #eidolon.fixture.TaskTreeCtrl>) [<ExternalJob #tree {src="vfs://./flow-code/tree.ts#tree" config={taskTree=true}}><Return #done {src="vfs://./flow-code/index.ts#identity"}>]>`);
    await writeFile(join(resources,'Data','TaskTree.xnl'),`<AIDataWorkflow #eidolon.fixture.TaskTreeData envelopeVersion="halfcode.resource-envelope/v1" specVersion=1 (<FlowContract #eidolon.fixture.TaskTreeData {inputPorts=["value"] outputPorts=["value"]}>) [<EntryNode #entry><TransformNode #tree {inputs={value="flow-port://#entry/value"} outputs=["value"] src="vfs://./flow-code/tree.ts#dataTree" config={node_type="manual" taskTree=true}}><ReturnNode #return {inputs={value="flow-port://#tree/value"}}>]>`);
}
