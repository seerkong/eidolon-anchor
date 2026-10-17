// Explicit local-only preload. Original Bash, permission runtime, resource leases and task settlement stay real.
import {appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {__setLlmAdapterFactoryForTest} from '@cell/ai-runtime-host-capsule/session/SessionRuntimeAssembly';
import {createMockProviderCacheCostObservation} from '../../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream';
let calls=0;
__setLlmAdapterFactoryForTest(async(_adapter,workDir)=>({type:'openai',runtime:{adapterName:'openai',providerId:'fixture'},async createStream(options:any){
    const call=++calls;appendFileSync(join(workDir!,'tasktree-provider-calls.jsonl'),JSON.stringify({call,workDir})+'\n');
    return {stream:(async function*(){
        if(call%2===1){yield {choices:[{delta:{tool_calls:[{index:0,id:`cwd-${call}`,type:'function',function:{name:'bash',arguments:JSON.stringify({command:'pwd > tasktree-cwd.txt',description:'Verify original authorized cwd'})}}]}}]};yield {choices:[{delta:{},finish_reason:'tool_calls'}]}}
        else{yield {choices:[{delta:{content:JSON.stringify({value:`canonical-tasktree-${call}`})}}]};yield {choices:[{delta:{},finish_reason:'stop'}]}}
    })(),providerOutput:Promise.resolve({provider_cache_cost_observation:createMockProviderCacheCostObservation(options)})};
}}));
