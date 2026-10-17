// Test-only child-process provider. The daemon, IPC, original execution and all stores remain real.
import {appendFileSync} from 'node:fs'
import {join} from 'node:path'
import {__setLlmAdapterFactoryForTest} from '@cell/ai-runtime-host-capsule/session/SessionRuntimeAssembly'
import {createMockProviderCacheCostObservation} from '../../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream'
let calls=0
__setLlmAdapterFactoryForTest(async(_adapter,workDir)=>({type:'openai',runtime:{adapterName:'openai',providerId:'fixture'},async createStream(options:any){
  const call=++calls;appendFileSync(join(workDir!,'global-provider-calls.jsonl'),JSON.stringify({call})+'\n')
  return {stream:(async function*(){yield {choices:[{delta:{content:JSON.stringify({value:`canonical-daemon-result-${call}`})}}]};yield {choices:[{delta:{},finish_reason:'stop'}]}})(),providerOutput:Promise.resolve({provider_cache_cost_observation:createMockProviderCacheCostObservation(options)})}
}}))
