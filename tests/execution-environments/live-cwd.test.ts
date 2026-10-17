import {test,expect} from 'bun:test'
import {mkdir,writeFile,access} from 'node:fs/promises'
import {join} from 'node:path'
import {fixture,workerCommand,security,principal} from '../daemon/helpers'
import {serveDaemon} from '../../backend/packages/elysia/src/daemonServe'
import {prepareSkillDrivenOrganizationWorkspace} from '../../cell/packages/ai-organ-logic/tests/workflow/prepareSkillDrivenOrganizationWorkspace'

async function scenario(revoke=false){
 const f=await fixture();let daemon:Awaited<ReturnType<typeof serveDaemon>>|undefined,calls=0
 let allowed=true;const marker=join(f.a,'must-not-exist');const inputs:string[]=[];let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve})
 const provider=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){const body=await request.json();inputs.push(JSON.stringify(body));const call=++calls;if(call>2)return new Response('budget exceeded',{status:429});const event=(delta:unknown,finish_reason:string|null=null)=>'data: '+JSON.stringify({id:'env',object:'chat.completion.chunk',created:1,model:'a',choices:[{index:0,delta,finish_reason}]})+'\n\n';
   if(call===1){await gate;return new Response(event({role:'assistant',tool_calls:[{index:0,id:'cwd-tool',type:'function',function:{name:'bash',arguments:JSON.stringify({command:revoke?`pwd; printf unauthorized > '${marker}'`:'pwd',description:'Observe authorized execution cwd'})}}]},'tool_calls')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}})}
   if(revoke){expect(JSON.stringify((body as any).messages.filter((message:any)=>message.role==='tool'))).toContain('resource_unavailable');return new Response(event({role:'assistant',content:JSON.stringify({value:'Execution location permission revoked'})})+event({},'stop')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}})}
   expect(JSON.stringify((body as any).messages.filter((message:any)=>message.role==='tool'))).toContain(f.a);expect(inputs[1]).toContain(f.a);return new Response(event({role:'assistant',content:JSON.stringify({value:'GLOBAL_SOURCE_ONLY actual cwd '+f.a})})+event({},'stop')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}})
 }})
 try{
  const source=join(f.globalRoot,'daemon');await mkdir(source,{recursive:true});await prepareSkillDrivenOrganizationWorkspace(source,{tools:['bash'],prompt:'GLOBAL_SOURCE_ONLY: use Bash pwd once then return strict JSON {"value":"actual cwd"}.'})
  await prepareSkillDrivenOrganizationWorkspace(f.a,{tools:['bash'],namespace:'poison.target',memberRef:'target-member',holonRef:'target-holon',prompt:'TARGET_ORGANIZATION_MUST_NOT_BECOME_SOURCE'})
  await writeFile(join(f.globalRoot,'llm-provider.json'),JSON.stringify({providers:[{id:'fixture',adapter:'openai',options:{apiKey:'controlled-test-only',baseURL:`http://127.0.0.1:${provider.port}/v1`},models:[{id:'a',limits:{context:32000,output:4096}}]}]}))
  await writeFile(join(f.a,'.eidolon','llm-provider.json'),JSON.stringify({providers:[{id:'poison',adapter:'openai',options:{apiKey:'controlled-test-only',baseURL:'http://127.0.0.1:1'},models:[{id:'z',limits:{context:8000,output:1024}}]}]}))
  await writeFile(join(f.a,'.eidolon','agent-present.json'),JSON.stringify({defaultPreset:'poison',presets:{poison:{primary:{model:'poison/z'}}}}))
  daemon=await serveDaemon({globalRoot:f.globalRoot,workerCommand,security:{...security,authorization:{currentGrantsVersion:()=> '1',permits:(_p,target)=>target.kind==='execution-environment'&&target.action==='execute'?allowed:true}},listen:{port:0},runtimeConfig:{mcp:false}})
  const workspace=await daemon.daemon.register(f.a);await daemon.daemon.open(workspace.workspaceKey)
  const cap=daemon.daemon.capabilities();await daemon.daemon.open(cap.globalWorkspaceKey);const port=daemon.daemon.scope(cap.globalWorkspaceKey).port,r={principal,requestId:'env-test'},directory=await port.participantDirectory!(r)
  expect(directory.contacts.some(c=>c.recipient.ref==='target-member')).toBe(false)
  const recipient=directory.contacts.find(c=>c.available&&c.recipient.kind==='member')!.recipient,environment=daemon.daemon.environments(r).environments[0]!.ref
  const binding=await port.openParticipant!(r,{bindingKey:'environment-a',recipient,expectedServerInstanceId:port.capabilities(r).serverInstanceId,executionEnvironment:environment});expect(binding.executionEnvironment).toEqual(environment)
  await port.submitExecution!(r,{bindingKey:binding.bindingKey,recipient,commandId:'original-env-work',text:'Observe the actual execution cwd',contextCut:{schemaVersion:'bridge.im-context/v1',cutId:'env-cut',messages:[]}})
  const entered=Date.now()+10000;while(calls<1){if(Date.now()>entered)throw Error('model_request_not_entered');await Bun.sleep(50)}
  await expect(daemon.daemon.closeWorkspace(workspace.workspaceKey)).rejects.toThrow('execution_environment_busy');if(revoke)allowed=false;release();
  const end=Date.now()+30000;let result:any
  while(true){const page=await port.executionOutputPage!(r,{bindingKey:binding.bindingKey});result=page.outputs.find(o=>o.kind==='result');if(result)break;const work=await port.participantWork!(r,{bindingKey:binding.bindingKey});if(work.work[0]?.status==='Failed'){const log=Bun.spawnSync(['rg','-n','-o','EIDOLON_[A-Z_]+|errorCode[^,}]{0,150}|message[^,}]{0,150}',join(source,'.eidolon','sessions',binding.sessionId,'holon-task-runtime')]);throw Error('environment_task_failed:'+JSON.stringify({calls,work,diagnostics:log.stdout.toString().slice(-8000)}))}if(Date.now()>end)throw Error('environment_result_timeout:'+JSON.stringify(await port.participantWork!(r,{bindingKey:binding.bindingKey})));await Bun.sleep(100)}
  expect(calls).toBe(2);expect(inputs[0]).toContain('GLOBAL_SOURCE_ONLY');expect(inputs.join('')).not.toContain('TARGET_ORGANIZATION_MUST_NOT_BECOME_SOURCE');expect(result.execution.executionEnvironment).toEqual(environment);expect(result.text).toContain(revoke?'permission revoked':f.a);if(revoke){await expect(access(marker)).rejects.toThrow();const work=await port.participantWork!(r,{bindingKey:binding.bindingKey});expect(work.settings?.canSetModel).toBe(false);await expect(port.submitExecution!(r,{bindingKey:binding.bindingKey,recipient,commandId:'revoked-new',text:'must not execute',contextCut:{schemaVersion:'bridge.im-context/v1',cutId:'revoked',messages:[]}})).rejects.toThrow('forbidden')}
 }finally{release();await daemon?.close();provider.stop(true);await f.cleanup()}
}
test('original global member executes actual Bash in registered cwd without adopting target organization or provider',()=>scenario(),45000)
test('grant revoked after model admission blocks the actual tool lease and subsequent submissions',()=>scenario(true),45000)
