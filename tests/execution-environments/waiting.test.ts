import {test,expect} from 'bun:test';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,workerCommand,security,principal} from '../daemon/helpers';
import {serveDaemon} from '../../backend/packages/elysia/src/daemonServe';
import {prepareSkillDrivenOrganizationWorkspace} from '../../cell/packages/ai-organ-logic/tests/workflow/prepareSkillDrivenOrganizationWorkspace';
test('environment waiting questions retain the exact original owner and current answer authorization',async()=>{
 const f=await fixture();let native:Awaited<ReturnType<typeof serveDaemon>>|undefined,calls=0,allowed=true;
 const provider=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){const body=await request.json() as any,call=++calls;if(call>2)return new Response('budget exceeded',{status:429});const event=(delta:unknown,finish_reason:string|null=null)=>'data: '+JSON.stringify({id:'waiting',object:'chat.completion.chunk',created:1,model:'a',choices:[{index:0,delta,finish_reason}]})+'\n\n';
 if(call===1)return new Response(event({role:'assistant',tool_calls:[{index:0,id:'environment-question',type:'function',function:{name:'Questionnaire',arguments:JSON.stringify({questionnaireId:'environment-confirm',kind:'approval',title:'原环境任务确认',suspendPolicy:'continue_others',questions:[{id:'answer',prompt:'确认此原任务',type:'text',required:true}]})}}]},'tool_calls')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
 expect(JSON.stringify(body.messages)).toContain('original answer');return new Response(event({role:'assistant',content:JSON.stringify({value:'Original environment answer complete'})})+event({},'stop')+'data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
 }});
 async function until(fn:()=>Promise<boolean>){const end=Date.now()+30000;while(!await fn()){if(Date.now()>end)throw Error('original_environment_question_timeout');await Bun.sleep(100);}}
 try{
 const root=join(f.globalRoot,'daemon');await mkdir(root,{recursive:true});await prepareSkillDrivenOrganizationWorkspace(root,{tools:['Questionnaire']});await writeFile(join(f.globalRoot,'llm-provider.json'),JSON.stringify({providers:[{id:'fixture',adapter:'openai',options:{apiKey:'controlled-test-only',baseURL:`http://127.0.0.1:${provider.port}/v1`},models:[{id:'a',limits:{context:32000,output:4096}}]}]}));
 native=await serveDaemon({globalRoot:f.globalRoot,workerCommand,security:{...security,authorization:{currentGrantsVersion:()=> '1',permits:(_p,target)=>target.kind==='execution-environment'&&target.action==='execute'?allowed:true}},listen:{port:0},runtimeConfig:{mcp:false}});
 const a=await native.daemon.register(f.a),b=await native.daemon.register(f.b);await native.daemon.open(a.workspaceKey);await native.daemon.open(b.workspaceKey);const cap=native.daemon.capabilities();await native.daemon.open(cap.globalWorkspaceKey);
 const port=native.daemon.scope(cap.globalWorkspaceKey).port,r={principal,requestId:'waiting'},recipient=(await port.participantDirectory!(r)).contacts.find(c=>c.available&&c.recipient.kind==='member')!.recipient,environment=native.daemon.environments(r).environments.find(e=>e.ref.workspaceKey===a.workspaceKey)!.ref;
 const binding=await port.openParticipant!(r,{bindingKey:'waiting-a',recipient,expectedServerInstanceId:port.capabilities(r).serverInstanceId,executionEnvironment:environment});
 await port.submitExecution!(r,{bindingKey:binding.bindingKey,recipient,commandId:'original-waiting',text:'Ask for an original answer',contextCut:{schemaVersion:'bridge.im-context/v1',cutId:'waiting-cut',messages:[]}});
 const read=()=>port.participantWork!(r,{bindingKey:binding.bindingKey});await until(async()=>Boolean((await read()).work[0]?.questions[0]?.canAnswer));const waiting=(await read()).work[0]!;expect(waiting.questions[0]!.execution.executionEnvironment).toEqual(environment);expect(calls).toBe(1);await expect(native.daemon.closeWorkspace(a.workspaceKey)).rejects.toThrow('execution_environment_busy');
 const answer={kind:'answer' as const,bindingKey:binding.bindingKey,commandId:waiting.commandId,questionnaireId:'environment-confirm',responseText:'Q1: original answer'};allowed=false;expect((await read()).work[0]!.questions[0]!.canAnswer).toBe(false);await expect(port.controlParticipant!(r,answer)).rejects.toThrow('forbidden');expect(calls).toBe(1);allowed=true;await port.controlParticipant!(r,answer);
 await until(async()=> (await port.executionOutputPage!(r,{bindingKey:binding.bindingKey})).outputs.some(o=>o.kind==='result'));const result=(await port.executionOutputPage!(r,{bindingKey:binding.bindingKey})).outputs.find(o=>o.kind==='result')!;expect(result.execution!.executionEnvironment).toEqual(environment);expect(result.text).toBe('Original environment answer complete');expect(calls).toBe(2);
 }finally{await native?.close();provider.stop(true);await f.cleanup();}
},45000);
