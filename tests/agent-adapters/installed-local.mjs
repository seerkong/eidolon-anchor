import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentDrivers} from '../../cell/packages/ai-runtime-host-support/src/agentDrivers.ts';
import {createAgentProcessEffects} from '../../cell/packages/ai-runtime-host-support/src/agentProcess.ts';

// Execute installed binaries and production drivers, with disposable CLI homes and
// deterministic loopback inference. This verifies wire compatibility, not live auth.
const root=await mkdtemp(join(tmpdir(),'eidolon-installed-agents-')),exact='Installed CLI original result\n  Unicode 𝌆\n',requests=[],runs=[];
const sse=events=>new Response(events.map(([event,data])=>`${event?'event: '+event+'\n':''}data: ${JSON.stringify(data)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
let calls=0;
const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){
 const path=new URL(request.url).pathname;requests.push({method:request.method,path});
 if(request.method==='GET'&&path.endsWith('/models'))return Response.json({object:'list',data:[{id:'fixture-model',object:'model',owned_by:'isolated'}]});
 if(path.endsWith('/count_tokens'))return Response.json({input_tokens:100});
 if(request.method!=='POST')return new Response('isolated endpoint only',{status:404});
 const body=await request.json();assert(++calls<=12,'bounded local inference');
 if(path.endsWith('/responses')){
  const item={id:'msg-'+calls,type:'message',role:'assistant',status:'completed',phase:'final_answer',content:[{type:'output_text',text:exact,annotations:[]}]},response={id:'resp-'+calls,object:'response',created_at:0,status:'completed',model:body.model,output:[item],usage:{input_tokens:100,output_tokens:10,total_tokens:110}};
  return sse([['response.created',{type:'response.created',response:{...response,status:'in_progress',output:[]}}],['response.output_item.added',{type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}}],['response.content_part.added',{type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}}],['response.output_text.delta',{type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:exact}],['response.output_text.done',{type:'response.output_text.done',item_id:item.id,output_index:0,content_index:0,text:exact}],['response.content_part.done',{type:'response.content_part.done',item_id:item.id,output_index:0,content_index:0,part:item.content[0]}],['response.output_item.done',{type:'response.output_item.done',output_index:0,item}],['response.completed',{type:'response.completed',response}]]);
 }
 if(path.endsWith('/messages')){
  const message={id:'msg-'+calls,type:'message',role:'assistant',model:body.model,content:[{type:'text',text:exact}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:100,output_tokens:10}};
  if(!body.stream)return Response.json(message);
  return sse([['message_start',{type:'message_start',message:{...message,content:[],stop_reason:null,usage:{input_tokens:100,output_tokens:0}}}],['content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}}],['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:exact}}],['content_block_stop',{type:'content_block_stop',index:0}],['message_delta',{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:10}}],['message_stop',{type:'message_stop'}]]);
 }
 if(path.endsWith('/chat/completions')){
  const common={id:'chat-'+calls,object:'chat.completion.chunk',created:0,model:body.model};
  return new Response([JSON.stringify({...common,choices:[{index:0,delta:{role:'assistant',content:exact},finish_reason:null}]}),JSON.stringify({...common,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110}}),'[DONE]'].map(data=>'data: '+data+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
 }
 return new Response('unexpected inference protocol',{status:400});
}});
const base='http://127.0.0.1:'+server.port;
try{
 for(const provider of ['codex','claude','grok']){
  const home=join(root,provider),work=join(home,'work');await mkdir(work,{recursive:true});
  if(provider==='codex')await writeFile(join(home,'config.toml'),`model_provider = "fixture"\nmodel = "fixture-model"\ncheck_for_update_on_startup = false\n[model_providers.fixture]\nname = "Isolated local fixture"\nbase_url = "${base}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[analytics]\nenabled = false\n`);
  if(provider==='grok')await writeFile(join(home,'config.toml'),`[model.fixture-model]\nmodel = "fixture-model"\nbase_url = "${base}/v1"\napi_key = "isolated-local-only"\napi_backend = "chat_completions"\ncontext_window = 32000\n[cli]\nauto_update = false\n[telemetry]\ntrace_upload = false\n`);
  const actual=createAgentProcessEffects(),versions=await actual.version(provider);
  const childEnv={PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,HOME:home,CODEX_HOME:home,CLAUDE_CONFIG_DIR:home,GROK_HOME:home,ANTHROPIC_BASE_URL:base,ANTHROPIC_API_KEY:'isolated-local-only',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1',GROK_DISABLE_AUTOUPDATER:'1',GROK_MODELS_BASE_URL:base+'/v1',XAI_API_KEY:'isolated-local-only'};
  const effects={...actual,spawn(command,cwd){const saved={...process.env};try{for(const key of Object.keys(process.env))delete process.env[key];Object.assign(process.env,childEnv);return actual.spawn(command,cwd);}finally{for(const key of Object.keys(process.env))delete process.env[key];Object.assign(process.env,saved);}}};
  const environment={kind:'daemon-workspace',daemonId:'isolated',workspaceKey:'work',revision:1},events=[];
  const input={command:{source:{kind:'agent-adapter',daemonId:'isolated',adapterId:provider,revision:1},bindingKey:'channel-'+provider,commandId:'command-'+provider,text:'Return the isolated fixture reply.',contextCut:{schemaVersion:'bridge.im-context/v1',cutId:'cut',messages:[]}},configuration:{provider,name:provider,model:'fixture-model',environment,enabled:true},environment:{ref:environment,workspace:{workspaceKey:'work',workDir:work,workspaceId:work,revision:1,placement:'workspace'}}};
  const driver=createAgentDrivers(effects);
  for(let turn=0;turn<(provider==='grok'?1:2);turn++){
  const previous=runs.at(-1);const next=turn?{...input,sessionId:previous.handle.sessionId,command:{...input.command,commandId:input.command.commandId+'-resume'}}:input;
  const run=driver.start(next,async event=>{events.push(event.kind);});
  const timer=setTimeout(()=>{void run.close();},45000);
  try{const result=await run.result;runs.push({provider,version:versions,state:result.state,errorCode:result.errorCode,handle:result.handle,events});console.log(JSON.stringify(runs.at(-1)));assert.equal(result.state,'completed',provider+' installed original protocol');assert.equal(result.text,exact,provider+' complete exact original bytes');assert.equal(result.handle.provider,provider);assert(result.handle.sessionId);if(turn)assert.equal(result.handle.sessionId,previous.handle.sessionId,provider+' resumes original session');}
  finally{clearTimeout(timer);await run.close();}
  }
 }
}finally{await server.stop(true);await rm(root,{recursive:true,force:true});}
console.log(JSON.stringify({passed:true,runs,localInferenceCalls:calls,requests,paidCalls:0,liveAuthentication:'unverified',cleaned:true}));
