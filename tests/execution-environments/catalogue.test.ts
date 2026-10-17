import {test,expect} from 'bun:test'
import {fixture,workerCommand,principal,security} from '../daemon/helpers'
import {serveDaemon} from '../../backend/packages/elysia/src/daemonServe'
import {parseWireResponse,parseExecutionEnvironmentDirectory} from '@cell/ai-runtime-host-contract'

test('real parent catalogue distinguishes registered, ready and separately authorized execution',async()=>{
 const f=await fixture();let server:Awaited<ReturnType<typeof serveDaemon>>|undefined,allowed=true
 try{
  server=await serveDaemon({globalRoot:f.globalRoot,workerCommand,listen:{port:0},runtimeConfig:{mcp:false},security:{...security,authorization:{currentGrantsVersion:()=> '1',permits:(_p,target)=>target.kind==='execution-environment'&&target.action==='execute'?allowed:true}}})
  const workspace=await server.daemon.register(f.a),cap=server.daemon.capabilities()
  const read=async()=>{const response=await fetch(server!.address+'/v1/daemon/execution-environments',{headers:{Authorization:'Bearer '+'D'.repeat(43),'X-Eidolon-Daemon-Instance':cap.daemonInstanceId}});expect(response.status).toBe(200);return parseWireResponse(await response.json(),parseExecutionEnvironmentDirectory)}
  let directory=await read();expect(directory.environments).toHaveLength(1);expect(directory.environments[0]?.canExecute).toBe(false)
  await server.daemon.open(workspace.workspaceKey);directory=await read();const environment=directory.environments[0]!;expect(environment.canExecute).toBe(true)
  expect((await server.daemon.resolveEnvironment({principal,requestId:'resolve'},environment.ref,'execute')).workspace.workDir).toBe(f.a)
  allowed=false;expect((await read()).environments[0]?.unavailableReason).toBe('forbidden');await expect(server.daemon.resolveEnvironment({principal,requestId:'revoke'},environment.ref,'execute')).rejects.toThrow('forbidden')
  allowed=true;await server.daemon.closeWorkspace(workspace.workspaceKey);expect((await read()).environments[0]?.canExecute).toBe(false)
 }finally{await server?.close();await f.cleanup()}
},30000)
