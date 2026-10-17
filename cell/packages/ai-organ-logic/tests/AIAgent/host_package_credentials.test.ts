import {afterEach, expect, test, spyOn} from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {configureLocalPermissionConfigStore} from '@cell/ai-organ-logic';
import {evaluateLocalToolPermission} from '@cell/ai-organ-logic/permissions/LocalPermissionEvaluator';
import {LocalFilePermissionConfigStore, hostPackageCredentialPaths} from '../../../ai-support/src/permissions/LocalFilePermissionConfigStore';
import {expandHomePath} from '../../../ai-support/src/permissions/LocalPermissionPaths';

const roots:string[]=[];
afterEach(()=>{configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});

test('credential aliases are normalized without executing shell expressions',()=>{
  for(const prefix of ['~','$HOME','${HOME}','$USERPROFILE','${USERPROFILE}','%USERPROFILE%','$env:USERPROFILE','${env:HOME}','%userprofile%','$env:userprofile','${env:home}'])
    expect(expandHomePath(prefix+'/.npmrc','/fixture/home')).toBe('/fixture/home/.npmrc');
  expect(expandHomePath('$(command)/.npmrc','/fixture/home')).toBe('$(command)/.npmrc');
});

test('hard protection precedes broad allow, external grants and symlink aliases',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'host-credential-guard-'));roots.push(root);
  const home=path.join(root,'host'),workDir=path.join(root,'work'),authorityRoot=path.join(root,'authority');
  for(const dir of [home,workDir,authorityRoot])fs.mkdirSync(dir);
  fs.writeFileSync(path.join(home,'.npmrc'),'SYNTHETIC_PRIVATE_SENTINEL');
  fs.writeFileSync(path.join(workDir,'.npmrc'),'registry=https://registry.npmjs.com');
  fs.symlinkSync(path.join(home,'.npmrc'),path.join(workDir,'linked-config'));
  fs.writeFileSync(path.join(authorityRoot,'permissions.json'),JSON.stringify({permission:{read:'allow',edit:'allow',bash:{'*':'allow'}}}));
  configureLocalPermissionConfigStore({...LocalFilePermissionConfigStore,privateRuntimePaths:()=>hostPackageCredentialPaths(home)});
  const grant={kind:'workspace_access_grant' as const,toolName:'read',workDir,grantPath:home,requestedAccessKind:'write' as const};
  for(const filePath of [path.join(home,'.npmrc'),path.join(workDir,'linked-config')]){
    const decision=evaluateLocalToolPermission({workDir,authorityRoot,toolName:'read',payload:{filePath,scopeIntent:'external'},approvalGrant:grant,additionalWritableRoots:[home]});
    expect(decision.action).toBe('deny');expect(decision.approvalGrant).toBeUndefined();
    expect(()=>evaluateLocalToolPermission({workDir,authorityRoot,toolName:'bash',payload:{command:'cat '+filePath}})).toThrow('Private runtime');
  }
  fs.unlinkSync(path.join(workDir,'linked-config'));
  expect(()=>evaluateLocalToolPermission({workDir,authorityRoot,toolName:'bash',payload:{command:'npm config list'}})).toThrow('Private runtime');
  expect(evaluateLocalToolPermission({workDir,authorityRoot,toolName:'read',payload:{filePath:path.join(workDir,'.npmrc')}}).action).toBe('allow');
  expect(evaluateLocalToolPermission({workDir,authorityRoot,toolName:'bash',payload:{command:'bun install --registry https://registry.npmjs.com',workdir:workDir}}).action).toBe('allow');
});

test('production host credential spellings cannot be approved; no credential content is read',()=>{
  configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);
  const workDir=fs.mkdtempSync(path.join(os.tmpdir(),'host-credential-empty-'));roots.push(workDir);
  for(const prefix of ['~','$HOME','${HOME}','$USERPROFILE','${USERPROFILE}','$env:USERPROFILE','${env:HOME}','%userprofile%','$env:userprofile','${env:home}']){
    expect(evaluateLocalToolPermission({workDir,toolName:'read',payload:{filePath:prefix+'/.npmrc',scopeIntent:'external'}}).action).toBe('deny');
    expect(()=>evaluateLocalToolPermission({workDir,toolName:'bash',payload:{command:'cat "'+prefix+'/.npmrc"'}})).toThrow('Private runtime');
  }
  for(const file of ['.npmrc','.bunfig.toml'])for(const prefix of ['~'+os.userInfo().username,'~another-user'])
    expect(()=>evaluateLocalToolPermission({workDir,toolName:'bash',payload:{command:'cat '+prefix+'/'+file}})).toThrow('Private runtime');
});

test('recursive authorization cannot starve heartbeat on a slow dependency tree',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bounded-private-scope-'));roots.push(root);
  const workDir=path.join(root,'work'),authorityRoot=path.join(root,'authority');fs.mkdirSync(workDir);fs.mkdirSync(authorityRoot);
  for(let i=0;i<600;i++)fs.writeFileSync(path.join(workDir,'dependency-'+i),'');
  fs.writeFileSync(path.join(authorityRoot,'permissions.json'),JSON.stringify({permission:{bash:{'*':'allow'}}}));
  configureLocalPermissionConfigStore({...LocalFilePermissionConfigStore,privateRuntimePaths:()=>hostPackageCredentialPaths(path.join(root,'host'))});
  const original=fs.realpathSync;
  const delayed=spyOn(fs,'realpathSync').mockImplementation((...args:any[])=>{
    if(String(args[0]).startsWith(workDir))Bun.sleepSync(2);
    return (original as any)(...args);
  });
  try{
    const start=performance.now();
    expect(()=>evaluateLocalToolPermission({workDir,authorityRoot,toolName:'bash',payload:{command:'grep -rn text .'}})).toThrow('private_runtime_scope_unproven');
    expect(performance.now()-start).toBeLessThan(500);
  }finally{delayed.mockRestore();}
});

test('long inline program/data literals do not become filesystem faults or bypass private scope',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'long-inline-permission-'));roots.push(root);
  const workDir=path.join(root,'work'),authorityRoot=path.join(root,'authority'),home=path.join(root,'host');
  fs.mkdirSync(workDir);fs.mkdirSync(authorityRoot);
  fs.writeFileSync(path.join(authorityRoot,'permissions.json'),JSON.stringify({permission:{bash:{'*':'allow'}}}));
  configureLocalPermissionConfigStore({...LocalFilePermissionConfigStore,privateRuntimePaths:()=>hostPackageCredentialPaths(home)});
  const program='import sys; print('+JSON.stringify('x'.repeat(400))+')';
  const data=JSON.stringify({content:'x'.repeat(400)});
  for(const command of ['python -c '+JSON.stringify(program),"printf '%s' '"+data+"' | python -m json.tool"]){
    expect(evaluateLocalToolPermission({workDir,authorityRoot,toolName:'bash',payload:{command}}).action).toBe('allow');
  }
  const privatePath=path.join(home,'.npmrc');
  const privateProgram=program+'; print(open('+JSON.stringify(privatePath)+').read())';
  expect(()=>evaluateLocalToolPermission({workDir,authorityRoot,toolName:'bash',payload:{command:'python -c '+JSON.stringify(privateProgram)}})).toThrow('Private runtime');
  fs.writeFileSync(path.join(workDir,'plain-file'),'synthetic');
  expect(LocalFilePermissionConfigStore.canonicalProtectionPath!(path.join(workDir,'plain-file','unreachable'))).toBe(path.join(fs.realpathSync(workDir),'plain-file','unreachable'));
});

test('inaccessible and cyclic candidate paths remain unproven under broad permission rules',()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'unproven-inline-permission-'));roots.push(root);
  const workDir=path.join(root,'work'),authorityRoot=path.join(root,'authority');fs.mkdirSync(workDir);fs.mkdirSync(authorityRoot);
  fs.writeFileSync(path.join(authorityRoot,'permissions.json'),JSON.stringify({permission:{bash:{'*':'allow'}}}));
  configureLocalPermissionConfigStore({...LocalFilePermissionConfigStore,privateRuntimePaths:()=>hostPackageCredentialPaths(path.join(root,'host'))});
  for(const code of ['EACCES','ELOOP']){
    const blocked=path.join(workDir,'blocked'),original=fs.realpathSync;
    const fault=spyOn(fs,'realpathSync').mockImplementation((...args:any[])=>{
      if(String(args[0])===blocked)throw Object.assign(new Error('synthetic '+code),{code});
      return (original as any)(...args);
    });
    try{
      expect(()=>evaluateLocalToolPermission({workDir,authorityRoot,toolName:'bash',payload:{command:'cat '+blocked}})).toThrow('synthetic '+code);
      expect(LocalFilePermissionConfigStore.inspectRecursivePrivateRuntime!(blocked,authorityRoot)).toBe('unproven');
    }finally{fault.mockRestore();}
  }
});
