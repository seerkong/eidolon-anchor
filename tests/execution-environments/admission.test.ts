import {test,expect} from 'bun:test'
import {parseExecutionEnvironmentRef,resolveExecutionEnvironment,type ExecutionEnvironmentAdmission} from '../../cell/packages/ai-runtime-host-logic/src/executionEnvironments'
const request={principal:{principalId:'owner',grantsVersion:'1'},requestId:'request'},ref={kind:'daemon-workspace' as const,daemonId:'daemon',workspaceKey:'project',revision:1}
function fixture(){let grants='1',allowed=true,open=true,workspace:any={workspaceKey:'project',workspaceId:'/registered',workDir:'/registered',revision:1,placement:'workspace',state:'ready',serverInstanceId:'worker'};const runtime:ExecutionEnvironmentAdmission={daemonId:'daemon',globalWorkspaceKey:'global',principalId:'owner',grantsVersion:'1',authorization:{permits:()=>allowed,currentGrantsVersion:()=>grants},isOpen:()=>open,currentWorkspace:key=>key===workspace.workspaceKey?workspace:undefined,canonicalDirectory:async p=>p};return {runtime,setGrants:(value:string)=>{grants=value},setAllowed:(value:boolean)=>{allowed=value},setOpen:(value:boolean)=>{open=value},setWorkspace:(value:any)=>{workspace=value},workspace:()=>workspace}}
test('closed reference excludes path, source role, model, credential and foreign scope fields',()=>{
 expect(parseExecutionEnvironmentRef(ref)).toEqual(ref)
 for(const field of ['cwd','workDir','workspaceId','principalId','modelRef','credentialRef','recipient','serverInstanceId'])expect(()=>parseExecutionEnvironmentRef({...ref,[field]:'forged'})).toThrow()
 expect(()=>parseExecutionEnvironmentRef({...ref,revision:0})).toThrow()
})
test('parent proves registered ready workspace and current execute grant without trusting a path',async()=>{
 const f=fixture(),context=await resolveExecutionEnvironment(f.runtime,request,ref,'execute');expect(context.workspace.workDir).toBe('/registered');expect(Object.isFrozen(context.workspace)).toBe(true)
 for(const bad of [{...ref,daemonId:'foreign'},{...ref,workspaceKey:'global'},{...ref,revision:2}])await expect(resolveExecutionEnvironment(f.runtime,request,bad,'execute')).rejects.toThrow()
 await expect(resolveExecutionEnvironment(f.runtime,{...request,principal:{...request.principal,principalId:'other'}},ref,'execute')).rejects.toThrow('forbidden')
 f.setAllowed(false);await expect(resolveExecutionEnvironment(f.runtime,request,ref,'execute')).rejects.toThrow('forbidden');f.setAllowed(true);f.setGrants('2');await expect(resolveExecutionEnvironment(f.runtime,request,ref,'execute')).rejects.toThrow('forbidden')
})
test('late registration/grant change and symlink retarget cannot produce a trusted execution directory',async()=>{
 const f=fixture();const changed={...f.runtime,canonicalDirectory:async()=>{f.setWorkspace({...f.workspace(),revision:2});return '/registered'}};await expect(resolveExecutionEnvironment(changed,request,ref,'execute')).rejects.toThrow('changed')
 const g=fixture();await expect(resolveExecutionEnvironment({...g.runtime,canonicalDirectory:async()=>'/different'},request,ref,'execute')).rejects.toThrow('changed')
 const h=fixture();await expect(resolveExecutionEnvironment({...h.runtime,canonicalDirectory:async()=>{h.setGrants('2');return '/registered'}},request,ref,'execute')).rejects.toThrow('forbidden')
})
test('a closed target can expose old facts with a read grant but cannot authorize new tool work',async()=>{
 const f=fixture();f.setWorkspace({...f.workspace(),state:'registered'});expect((await resolveExecutionEnvironment(f.runtime,request,ref,'read')).workspace.workspaceKey).toBe('project');await expect(resolveExecutionEnvironment(f.runtime,request,ref,'execute')).rejects.toThrow('not_ready');f.setOpen(false);await expect(resolveExecutionEnvironment(f.runtime,request,ref,'read')).rejects.toThrow('daemon_closing')
})
