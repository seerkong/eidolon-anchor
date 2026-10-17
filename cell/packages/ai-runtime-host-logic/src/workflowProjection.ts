import { parseWorkflowValue, type WorkflowValue, type WorkflowRunSummary, type WorkflowNode, type WorkflowDefinition, type WorkflowSource } from '@cell/ai-runtime-host-contract';
/** Normalize optional native properties; business payload keys retain their original meaning. */
export function workflowPublicValue(value: unknown): WorkflowValue {
    const clean = (item: unknown): unknown => {
        if (Array.isArray(item))
            return item.map(clean);
        if (item && typeof item === 'object')
            return Object.fromEntries(Object.entries(item).filter(([, nested]) => nested !== undefined).map(([key, nested]) => [key, clean(nested)]));
        return item === undefined ? null : item;
    };
    return parseWorkflowValue(clean(value));
}
export function workflowDefinition(preview: {
    frozen: {
        workflowRef: string;
        revision: string;
        fqn: string;
        form: 'AICtrlWorkflow' | 'AIDataWorkflow';
    };
    definition: unknown;
}): WorkflowDefinition {
    const { dir: _dir, baseUri: _baseUri, bundlePath: _bundlePath, manifestPath: _manifestPath, ...definition } = preview.definition as Record<string, unknown>;
    return { workflowRef: preview.frozen.workflowRef, revision: preview.frozen.revision, fqn: preview.frozen.fqn, form: preview.frozen.form, definition: workflowPublicValue(definition) };
}
export function workflowRunSummary(status: Record<string, any>, createdAt: number, source: WorkflowSource): WorkflowRunSummary {
    if (typeof status.run_id !== 'string' || typeof status.instance_id !== 'string' || typeof status.generation !== 'number' || !['AICtrlWorkflow', 'AIDataWorkflow'].includes(status.form))
        throw new Error('workflow_native_projection_invalid');
    return { runId: status.run_id, instanceId: status.instance_id, workflowRef: status.workflow_ref, definitionRevision: status.definition_revision, form: status.form, generation: status.generation, status: status.status, terminal: status.terminal === true, createdAt, source };
}
export function workflowNodes(status: Record<string, any>): WorkflowNode[] {
    if (!Array.isArray(status.nodes) || status.nodes.length > 1024)
        throw new Error('workflow_node_capacity');
    return status.nodes.map((node: any) => {
        const nodeId = status.form === 'AIDataWorkflow' ? node.id : node.nodeId, output = status.form === 'AIDataWorkflow' ? node.result?.output : node.output;
        if (typeof nodeId !== 'string' || typeof node.status !== 'string')
            throw new Error('workflow_native_node_invalid');
        return { nodeId, generation: node.generation ?? status.generation, status: node.nodeType === 'manual' && node.result?.status === 'Waiting' ? 'Waiting' : node.status, ...(output !== undefined ? { output: workflowPublicValue(output) } : {}), ...(typeof node.error === 'string' ? { error: node.error.slice(0, 2048) } : {}) };
    });
}

/** Current declared dependencies come from the original canonical graph, never presentation order. */
export function workflowRunStructure(profile:unknown,definition:WorkflowDefinition):WorkflowValue {
    const current=profile as {kind?:string;runGraph?:{declarationOrder:readonly string[];nodes:Record<string,{id:string;tag:string;inputs:unknown;outputs:readonly string[];dependsOn:readonly string[]}>}};
    if(current.kind!=='AIDataWorkflow')return definition.definition;
    const graph=current.runGraph;
    if(!graph||!Array.isArray(graph.declarationOrder)||graph.declarationOrder.length>1024)throw new Error('workflow_native_graph_invalid');
    const nodes=graph.declarationOrder.map(id=>graph.nodes[id]);
    if(nodes.some(node=>!node))throw new Error('workflow_native_graph_invalid');
    return workflowPublicValue({form:'EagerDataFlow',nodes:nodes.map(node=>({id:node!.id,tag:node!.tag,inputs:node!.inputs,outputs:node!.outputs})),dependencyEdges:nodes.flatMap(node=>node!.dependsOn.map(fromNodeId=>({kind:'dependency',fromNodeId,toNodeId:node!.id})))});
}

/** Public result is original business output and node facts, never private checkpoint sidecars. */
export function workflowRunResult(status:Record<string,any>):WorkflowValue{
    return workflowPublicValue({kind:'workflow.runResult',runId:status.run_id,instanceId:status.instance_id,definitionRevision:status.definition_revision,generation:status.generation,status:status.status,terminal:status.terminal===true,nodes:workflowNodes(status),...(status.output===undefined?{}:{output:status.output})});
}

/** Unchanged data nodes retain their generation when another graph node is patched. */
export function workflowExecutionGenerationCurrent(status:Record<string,any>,source:{nodeId:string;generation:number}):boolean{
    if(status.form==='AICtrlWorkflow')return source.generation===status.generation;
    const node=status.nodes.find((node:any)=>node.id===source.nodeId);
    return Boolean(node&&source.generation===(node.generation??status.generation));
}
