// Bounded opt-in acceptance: the shipping adapter receives the unmodified response.
import {appendFileSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
const {upstream,output}=JSON.parse(readFileSync(join(process.cwd(),'.global-live-audit.json'),'utf8'))
const actual=globalThis.fetch;let count=0
globalThis.fetch=Object.assign(async(input:any,init?:RequestInit)=>{
  const url=new URL(input instanceof Request?input.url:String(input))
  const body=JSON.parse(String(init?.body??(input instanceof Request?await input.clone().text():'{}')))
  if(url.origin!==upstream||body.model!=='deepseek-v4.1-flash'||body.reasoning_effort!=='high'||body.thinking?.type!=='enabled'||body.response_format?.type!=='json_object'||++count>4)throw new Error('global_live_model_or_budget_mismatch')
  const id=crypto.randomUUID(),emit=(value:object)=>appendFileSync(output,JSON.stringify({id,...value})+'\n',{mode:0o600})
  emit({kind:'request',model:body.model,effort:body.reasoning_effort,thinking:body.thinking.type,responseFormat:body.response_format.type})
  try{
    const response=await actual(input,init);emit({kind:'response',status:response.status})
    if(response.ok){void response.clone().text().then(wire=>{
      let content=''
      for(const line of wire.split('\n'))if(line.startsWith('data:')){const data=line.slice(5).trim();if(data&&data!=='[DONE]'){const delta=JSON.parse(data).choices?.[0]?.delta?.content;if(typeof delta==='string')content+=delta}}
      let jsonValid=false;try{JSON.parse(content);jsonValid=true}catch{}
      emit({kind:'output_evidence',jsonValid,one:content.includes('GLOBAL_TASK_ONE_CONFIRMED'),two:content.includes('GLOBAL_TASK_TWO_CONFIRMED')})
    }).catch(()=>emit({kind:'output_observation_unavailable'}))}
    return response
  }catch{emit({kind:'transport_failure'});throw new Error('global_live_transport_failed')}
},{preconnect:actual.preconnect}) as typeof fetch
