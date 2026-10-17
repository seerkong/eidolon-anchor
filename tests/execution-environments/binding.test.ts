import {test,expect} from 'bun:test'
import {mkdir} from 'node:fs/promises'
import {join} from 'node:path'
import {fixture,workerCommand,security,principal} from '../daemon/helpers'
import {serveDaemon} from '../../backend/packages/elysia/src/daemonServe'
import {prepareSkillDrivenOrganizationWorkspace} from '../../cell/packages/ai-organ-logic/tests/workflow/prepareSkillDrivenOrganizationWorkspace'
test('bindings persist the frozen location and reject another location, cwd, stale version or target permission',async()=>{
 const f=await fixture();let native:Awaited<ReturnType<typeof serveDaemon>>|undefined,allowed=true
 const start=()=>serveDaemon({globalRoot:f.globalRoot,workerCommand,security:{...security,authorization:{currentGrantsVersion:()=> '1',permits:(_p,target)=>target.kind==='execution-environment'&&target.action==='execute'?allowed:true}},listen:{port:0},runtimeConfig:{mcp:false}})
 try{
  const root=join(f.globalRoot,'daemon');await mkdir(root,{recursive:true});await prepareSkillDrivenOrganizationWorkspace(root,{tools:['Questionnaire']});native=await start();const a=await native.daemon.register(f.a),b=await native.daemon.register(f.b);await native.daemon.open(a.workspaceKey);await native.daemon.open(b.workspaceKey)
  const cap=native.daemon.capabilities();await native.daemon.open(cap.globalWorkspaceKey);let port=native.daemon.scope(cap.globalWorkspaceKey).port;const r={principal,requestId:'binding'},recipient=(await port.participantDirectory!(r)).contacts.find(c=>c.available&&c.recipient.kind==='member')!.recipient,refs=native.daemon.environments(r).environments.map(e=>e.ref),one=refs.find(e=>e.workspaceKey===a.workspaceKey)!,two=refs.find(e=>e.workspaceKey===b.workspaceKey)!
  const input={bindingKey:'fixed-location',recipient,expectedServerInstanceId:port.capabilities(r).serverInstanceId,executionEnvironment:one},receipt=await port.openParticipant!(r,input);expect(receipt.executionEnvironment).toEqual(one)
  await expect(port.openParticipant!(r,{...input,executionEnvironment:two})).rejects.toThrow('participant_binding_conflict')
  await expect(port.openParticipant!(r,{...input,bindingKey:'stale',executionEnvironment:{...one,revision:2}})).rejects.toThrow('execution_environment_changed')
  await expect(port.openParticipant!(r,{...input,bindingKey:'path',executionEnvironment:{...one,cwd:f.b} as any})).rejects.toThrow()
  allowed=false;await expect(port.openParticipant!(r,{...input,bindingKey:'revoked'})).rejects.toThrow('forbidden');allowed=true
  await native.close();native=await start();await native.daemon.open(a.workspaceKey);await native.daemon.open(cap.globalWorkspaceKey);port=native.daemon.scope(cap.globalWorkspaceKey).port
  const restored=await port.openParticipant!(r,{...input,expectedServerInstanceId:port.capabilities(r).serverInstanceId});expect(restored).toEqual(receipt)
  expect((await port.participantWork!(r,{bindingKey:'fixed-location'})).work).toHaveLength(0)
  await native.daemon.closeWorkspace(a.workspaceKey);await expect(port.submitExecution!(r,{bindingKey:'fixed-location',recipient,commandId:'not-dispatched',text:'must not run',contextCut:{schemaVersion:'bridge.im-context/v1',cutId:'cut',messages:[]}})).rejects.toThrow('execution_environment_not_ready')
 }finally{await native?.close();await f.cleanup()}
},30000)
