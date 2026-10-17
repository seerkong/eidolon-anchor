import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHost} from '../../cell/packages/ai-runtime-host-capsule/src/host'
import {__setLlmAdapterFactoryForTest} from '../../cell/packages/ai-runtime-host-capsule/src/session/SessionRuntimeAssembly'
import {createMockProviderCacheCostObservation} from '../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream'
import {installBundledSystemSkills} from '@cell/ai-support/system-skill/SystemSkillInstaller'
import {seedBotResources} from '../runtime-host/fixtures/bots'
import type {GlobalTaskSpaceView} from '@cell/ai-runtime-host-contract'
import {prepareSkillDrivenOrganizationWorkspace} from '../../cell/packages/ai-organ-logic/tests/workflow/prepareSkillDrivenOrganizationWorkspace'

export const globalRequest={principal:{principalId:'owner',grantsVersion:'1'},requestId:'controlled-global-execution'}
export async function globalFixture(beforeResult?:(call:number)=>Promise<void>,questionFirst:boolean|'permission'=false,hostOptions:Partial<Parameters<typeof createHost>[0]>={}){
  const root=await mkdtemp(join(tmpdir(),'global-controlled-')),globalRoot=join(root,'global'),workDir=join(globalRoot,'daemon')
  await mkdir(workDir,{recursive:true});await installBundledSystemSkills({globalRoot});if(questionFirst)await prepareSkillDrivenOrganizationWorkspace(workDir,{tools:questionFirst==='permission'?['read']:['Questionnaire']});else await seedBotResources(root,workDir)
  if(questionFirst==='permission'){await writeFile(join(globalRoot,'permissions.json'),JSON.stringify({permission:{'*':'deny',read:{'secret.txt':'ask'}}}));await writeFile(join(workDir,'secret.txt'),'private fixture material')}
  let calls=0
  __setLlmAdapterFactoryForTest(async()=>({type:'openai',runtime:{adapterName:'openai',providerId:'fixture'},async createStream(options:any){
    const call=++calls
    return {stream:(async function*(){await beforeResult?.(call);if(questionFirst&&call===1){const tool=questionFirst==='permission'?{name:'read',arguments:JSON.stringify({filePath:'secret.txt'})}:{name:'Questionnaire',arguments:JSON.stringify({questionnaireId:'domain-question',title:'Choose the task outcome',suspendPolicy:'pause_all',questions:[{id:'q',prompt:'Which outcome?',type:'text',required:true}]})};yield {choices:[{delta:{tool_calls:[{index:0,id:'domain-question-tool',type:'function',function:tool}]}}]};yield {choices:[{delta:{},finish_reason:'tool_calls'}]}}else{yield {choices:[{delta:{content:JSON.stringify({value:`canonical-result-${call}`})}}]};yield {choices:[{delta:{},finish_reason:'stop'}]}}})(),providerOutput:Promise.resolve({provider_cache_cost_observation:createMockProviderCacheCostObservation(options)})}
  }}))
  const options={workDir,globalRoot,globalAuthority:{daemonId:'controlled-fixture',globalWorkspaceKey:'global'},authorization:{permits:()=>true,currentGrantsVersion:()=> '1'},runtimeConfig:{adapter:'openai' as const,model:'mock',mcp:false},...hostOptions}
  let host=await createHost(options)
  const recipient=(await host.participantDirectory!(globalRequest)).contacts.find(contact=>contact.recipient.kind==='holon'&&contact.available)!.recipient
  return {
    get host(){return host},options,workDir,recipient,get calls(){return calls},
    async restart(){await host.close();host=await createHost(options)},
    async cleanup(){try{await host.close()}finally{__setLlmAdapterFactoryForTest(null);await rm(root,{recursive:true,force:true})}},
    async until(taskSpaceId:string,condition:(view:GlobalTaskSpaceView)=>boolean){
      const deadline=Date.now()+10000
      while(true){const view=await host.globalTaskSpace!(globalRequest,{taskSpaceId});if(condition(view))return view;if(Date.now()>deadline)throw new Error('global_state_timeout '+JSON.stringify(view));await Bun.sleep(20)}
    },
  }
}
