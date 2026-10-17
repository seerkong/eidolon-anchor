import {afterEach, expect, test} from 'bun:test';
import {existsSync,mkdirSync,mkdtempSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bashCoreLogic} from '../../src/composer/AIAgent/tools/Bash/Logic';
import {configureLocalPermissionConfigStore} from '../../src/permissions/LocalPermissionConfig';
import {evaluateLocalToolPermission} from '../../src/permissions/LocalPermissionEvaluator';
import {LocalFilePermissionConfigStore} from '@cell/ai-support/permissions/LocalFilePermissionConfigStore';
import {privateReadExecutionBoundary,resolveSandboxBackendSelection} from '../../src/sandbox/SandboxBackendRuntime';

const roots:string[]=[];
afterEach(()=>{configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'private-runtime-e2e-')));roots.push(root);
 const app=join(root,'app'),privateRoot=join(root,'private');
 mkdirSync(app);mkdirSync(privateRoot);writeFileSync(join(privateRoot,'sentinel'),'NEVER_RETURN_PRIVATE_SENTINEL');
 configureLocalPermissionConfigStore({...LocalFilePermissionConfigStore,
  privateRuntimePaths:()=>[privateRoot],protectedPermissionConfigPaths:()=>[],
  loadLocalPermissionsConfig:()=>({rules:[{permission:'*',pattern:'*',action:'allow'}],overrides:[]}),
  loadWorkspaceAccessConfig:()=>({workspaces:{}}),
 });
 const facets=new Map<string,unknown>();
 const runtime:any={vm:{actorRuntime:{ensureFacet:(key:string,factory:()=>unknown)=>{if(!facets.has(key))facets.set(key,factory());return facets.get(key);},setFacet:(key:string,value:unknown)=>facets.set(key,value)},aiFacet:{},holonRuntime:{},outerCtx:{workDir:app,metadata:{local_permissions:{authority_root:root},exec_protocol:{mode:'default'},sandbox_permissions:{sandbox_mode:'workspace-write',network_access:'disabled'}}}}};
 const run=(command:string)=>bashCoreLogic(runtime,{command,workdir:app,timeoutSeconds:10} as any,{} as any);
 return {root,app,privateRoot,run};
}

test.skipIf(process.platform!=='darwin')('native bash develops and checks a large application without reading private data',async()=>{
 const f=fixture();mkdirSync(join(f.app,'node_modules'));
 for(let i=0;i<10050;i++)writeFileSync(join(f.app,'node_modules',`empty-${i}`),'');
 writeFileSync(join(f.app,'safe.test.ts'),`import {test,expect} from 'bun:test';test('real check',()=>expect(2+2).toBe(4));`);
 const result:any=await f.run(`${JSON.stringify(process.execPath)} test safe.test.ts`);
 expect(result.outcome?.status).toBe('completed');expect(result.output).toContain('1 pass');
 const boundary=privateReadExecutionBoundary(resolveSandboxBackendSelection({workDir:f.app}));
 const durations:number[]=[];
 for(let i=0;i<100;i++){const start=performance.now();const decision=evaluateLocalToolPermission({workDir:f.app,authorityRoot:f.root,toolName:'bash',payload:{command:'bun test',workdir:f.app},...boundary});expect(decision.action).toBe('allow');durations.push(performance.now()-start);}
 const p95=durations.sort((a,b)=>a-b)[94]!;expect(p95).toBeLessThan(50);
 console.log(JSON.stringify({kind:'permission-latency',files:10050,samples:100,p95Ms:p95}));
 symlinkSync(f.privateRoot,join(f.app,'private-link'));
 writeFileSync(join(f.app,'probe.ts'),`import {readFileSync} from 'node:fs';const p=['private','link'].join('-')+'/sentinel';try{console.log(readFileSync(p,'utf8'));process.exit(9);}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;console.log('PRIVATE_READ_DENIED');}`);
 const denied:any=await f.run(`${JSON.stringify(process.execPath)} probe.ts`);
 expect(denied.outcome?.status).toBe('completed');expect(denied.output).toContain('PRIVATE_READ_DENIED');expect(denied.output).not.toContain('NEVER_RETURN');
},30000);

test('unenforced large scopes report unknown authorization rather than claiming a private match',()=>{
 const f=fixture();mkdirSync(join(f.app,'node_modules'));
 for(let i=0;i<10050;i++)writeFileSync(join(f.app,'node_modules',`empty-${i}`),'');
 expect(()=>evaluateLocalToolPermission({workDir:f.app,authorityRoot:f.root,toolName:'bash',payload:{command:'bun test',workdir:f.app}})).toThrow('private_runtime_scope_unproven');
 expect(()=>evaluateLocalToolPermission({workDir:f.app,authorityRoot:f.root,toolName:'bash',payload:{command:'bun test',workdir:f.app,enforcedPrivateReadPaths:[f.privateRoot]}})).toThrow('private_runtime_scope_unproven');
 expect(()=>evaluateLocalToolPermission({workDir:f.app,authorityRoot:f.root,toolName:'bash',payload:{command:'bun test',workdir:f.app},enforcedPrivateReadPaths:[]})).toThrow('private_runtime_scope_unproven');
 expect(privateReadExecutionBoundary({...resolveSandboxBackendSelection({workDir:f.app}),backendName:'unsandboxed'})).toBeUndefined();
},30000);

test.skipIf(process.platform!=='darwin')('explicit private references remain denied despite enforced process isolation',async()=>{
 const f=fixture();const result=await f.run(`cat ${JSON.stringify(join(f.privateRoot,'sentinel'))}`);
 expect(String(result)).toContain('Private runtime');expect(String(result)).not.toContain('NEVER_RETURN');
});

test.skipIf(process.platform!=='darwin')('process HOME can be task-owned without weakening denied host paths',async()=>{
 const f=fixture();mkdirSync(join(f.app,'home'));writeFileSync(join(f.app,'home','.npmrc'),'registry=https://registry.npmjs.com\n');
 const selection=resolveSandboxBackendSelection({workDir:f.app,metadata:{sandbox_permissions:{sandbox_mode:'workspace-write',home_dir:join(f.app,'home'),network_access:'disabled'}}});
 const {executeStreamingSandboxedBashCommand}=await import('../../src/sandbox/SandboxBackendRuntime');
 const result=await executeStreamingSandboxedBashCommand({selection,cwd:f.app,timeoutMs:5000,command:'printf "%s" "$HOME"'});
 expect(result.ok).toBeTrue();expect(result.outputText).toBe(join(f.app,'home'));
});

const python='/Users/kongweixian/.local/share/uv/python/cpython-3.12.7-macos-aarch64-none/bin/python3.12';
const checker='/Users/kongweixian/.agents/skills/cdmt-mission-lite/scripts/check_mission.mjs';
test.skipIf(process.platform!=='darwin'||!existsSync(python)||!existsSync(checker))('native Python venv and installed skill run read-only beside 50k dependencies',async()=>{
 const f=fixture();mkdirSync(join(f.app,'dependencies'));
 for(let i=0;i<50010;i++)writeFileSync(join(f.app,'dependencies',`empty-${i}`),'');
 const setup:any=await f.run(`${JSON.stringify(python)} -m venv --without-pip .venv`);
 expect(setup.outcome?.status).toBe('completed');
 writeFileSync(join(f.app,'check.py'),`import pathlib,sys\nassert sys.prefix != sys.base_prefix\nprint('VENV_OK')\np=pathlib.Path(${JSON.stringify(f.privateRoot)}) / ('sent'+'inel')\ntry:\n print(p.read_text());sys.exit(9)\nexcept PermissionError:\n print('PRIVATE_READ_DENIED')\n`);
 const checked:any=await f.run('.venv/bin/python check.py');
 expect(checked.outcome?.status).toBe('completed');expect(checked.output).toContain('VENV_OK');expect(checked.output).toContain('PRIVATE_READ_DENIED');expect(checked.output).not.toContain('NEVER_RETURN');
 // The actual installed checker rejects an invalid fixture. This proves
 // execution without forging a successful mission or changing the skill.
 const skillResult:any=await f.run(`${JSON.stringify(process.execPath)} ${JSON.stringify(checker)} . --phase preflight`);
 expect(skillResult.outcome?.status).toBe('failed');expect(skillResult.output).toContain('MISSION.md');expect(skillResult.output).not.toContain('Private runtime');
 writeFileSync(join(f.app,'write-probe.ts'),`import {openSync,closeSync} from 'node:fs';try{closeSync(openSync(${JSON.stringify(checker)},'r+'));process.exit(9);}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;console.log('SKILL_READ_ONLY');}`);
 const writeDenied:any=await f.run(`${JSON.stringify(process.execPath)} write-probe.ts`);
 expect(writeDenied.outcome?.status).toBe('completed');expect(writeDenied.output).toContain('SKILL_READ_ONLY');
},60000);
