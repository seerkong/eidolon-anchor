import {WaitNodeHandler,type TickController} from 'work-ctrl-flow-logic';
import {flowStateOf} from 'instant-ctrl-flow-logic';
import {normalizeFlowClosedValue} from 'ai-workflow-logic';
import type {WaitHandle} from 'work-ctrl-flow-contract';

export type WorkflowTaskTreeCtrlWait=Readonly<{
    kind:'eidolon.workflow-tasktree-wait';src:string;input:unknown;config:Record<string,unknown>;
}>;
/** An explicit ExternalJob uses the original wait/token/checkpoint protocol; ordinary jobs keep their behavior. */
export function createWorkflowTaskTreeCtrlWaitHandler(options:Readonly<{
    controller:()=>TickController;
    opened(handle:WaitHandle,runtime:unknown,wait:WorkflowTaskTreeCtrlWait):void;
}>){
    return new WaitNodeHandler('external-job',options.controller,async(ctx,handle)=>{
        const cfg=ctx.node.Config as {src?:unknown;config?:Record<string,unknown>};
        if(cfg.config?.taskTree!==true)return;
        if(typeof cfg.src!=='string')throw new Error('workflow_tasktree_wait_code_required');
        const wait={kind:'eidolon.workflow-tasktree-wait' as const,src:cfg.src,input:normalizeFlowClosedValue(flowStateOf(ctx).current,'TaskTree wait input'),config:normalizeFlowClosedValue(cfg.config,'TaskTree wait config') as Record<string,unknown>};
        handle.metadata={...handle.metadata,taskTree:wait};
        options.opened(handle,ctx.runtime,wait);
    });
}
