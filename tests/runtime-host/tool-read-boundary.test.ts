import {afterEach, expect, test} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createActor, createVM} from '@cell/ai-core-logic';
import {ToolFuncRegistry} from '@cell/ai-core-logic/runtime/ToolFuncRegistry';
import {buildReadToolDef} from '@cell/ai-organ-logic/composer/AIAgent/tools/Read';
import {configureLocalPermissionConfigStore} from '@cell/ai-organ-logic/permissions/LocalPermissionConfig';
import {LocalFilePermissionConfigStore, hostPackageCredentialPaths} from '@cell/ai-support/permissions/LocalFilePermissionConfigStore';

const roots:string[]=[];
afterEach(()=>{configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'actual-read-boundary-'));roots.push(root);
  const workDir=path.join(root,'work'),authorityRoot=path.join(root,'authority'),home=path.join(root,'host');
  for(const dir of [workDir,authorityRoot,home])fs.mkdirSync(dir);
  const registry=new ToolFuncRegistry();registry.register(buildReadToolDef());
  const actor=createActor({key:'reviewer',id:'reviewer',type:'interactive'});
  const vm=(mode:string)=>createVM({controlActorKey:actor.key,actors:{[actor.key]:actor},outerCtx:{workDir,metadata:{exec_protocol:{mode},local_permissions:{authority_root:authorityRoot}}}});
  return {root,workDir,authorityRoot,home,registry,actor,vm};
}
test('actual Read never returns a host credential or link even in trusted modes',async()=>{
  const f=fixture(),secret=path.join(f.home,'.npmrc'),alias=path.join(f.workDir,'linked-config');
  fs.writeFileSync(secret,'SYNTHETIC_SECRET_MUST_NOT_RETURN');fs.symlinkSync(secret,alias);
  fs.writeFileSync(path.join(f.authorityRoot,'permissions.json'),JSON.stringify({permission:{read:'allow'}}));
  configureLocalPermissionConfigStore({...LocalFilePermissionConfigStore,privateRuntimePaths:()=>hostPackageCredentialPaths(f.home)});
  for(const mode of ['default','full-auto','dangerous'])for(const filePath of [secret,alias]){
    const output=String(await f.registry.call('read',f.vm(mode),f.actor,{filePath,scopeIntent:'external'}));
    expect(output).toContain('Error:');expect(output).not.toContain('SYNTHETIC_SECRET_MUST_NOT_RETURN');
  }
});
test('actual reviewer Read permits only the three declared input roots',async()=>{
  const f=fixture(),allowed=['targets','frozen','facts'];
  fs.writeFileSync(path.join(f.authorityRoot,'permissions.json'),JSON.stringify({permission:{read:{'*':'deny',...Object.fromEntries(allowed.flatMap(dir=>[[dir,'allow'],[dir+'/*','allow']]))}}}));
  for(const dir of allowed){fs.mkdirSync(path.join(f.workDir,dir));fs.writeFileSync(path.join(f.workDir,dir,'data.txt'),'NEUTRAL_'+dir);}
  fs.writeFileSync(path.join(f.workDir,'prior-review.txt'),'OLD_JUDGMENT_MUST_NOT_RETURN');
  for(const dir of allowed)expect(String(await f.registry.call('read',f.vm('default'),f.actor,{filePath:path.join(f.workDir,dir,'data.txt')}))).toContain('NEUTRAL_'+dir);
  for(const filePath of [f.workDir,path.join(f.workDir,'prior-review.txt')]){
    const output=String(await f.registry.call('read',f.vm('default'),f.actor,{filePath}));
    expect(output).toContain('Error:');expect(output).not.toContain('OLD_JUDGMENT_MUST_NOT_RETURN');
  }
});
