import {expect,test} from 'bun:test';
import {mkdtemp,rm,readFile,writeFile,readdir,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createActor,createVM,serializeActor,serializeVM} from '../../../../cell/packages/ai-core-logic/src';
import {LocalFileRuntimeSnapshotRepository} from '../../../../cell/packages/ai-support/src';
import {createWorkflowLifecycleSnapshotImporter} from '../../../../cell/packages/ai-organ-logic/src/workflow/runtime/WorkflowLifecycleFacet';
async function scene(run:(repo:LocalFileRuntimeSnapshotRepository,root:string)=>Promise<void>){
  const root=await mkdtemp(join(tmpdir(),'anchor-p3-preflight-')),repo=new LocalFileRuntimeSnapshotRepository(join(root,'runtime_state'));
  try{
    const actor=createActor({key:'main',type:'primary',systemPrompts:['isolated preparation']}),vm=createVM({controlActorKey:actor.key,actors:{main:actor}});
    await repo.writeSnapshot({vm:serializeVM(vm),actors:{main:serializeActor(actor)},fibers:{},questionnaires:[]});
    await run(repo,root);
  }finally{await rm(root,{recursive:true,force:true});}
}
async function files(root:string):Promise<Record<string,string>>{
  const result:Record<string,string>={};
  async function visit(path:string){for(const entry of await readdir(path,{withFileTypes:true})){const full=join(path,entry.name);if(entry.isDirectory())await visit(full);else result[full.slice(root.length)]=await readFile(full,'utf8');}}
  await visit(root);return result;
}
async function legacy(root:string){
  for(const [name,bytes] of Object.entries(await files(root))){
    if(!name.endsWith('.json'))continue;
    const value=JSON.parse(bytes);if(value.version===4)value.version=3;if(value.schemaVersion===4)value.schemaVersion=3;
    await writeFile(join(root,name),JSON.stringify(value));
  }
}
test('current snapshot preflight preserves every source byte and identity, has a stable digest and performs no writes',async()=>{
  await scene(async(repo,root)=>{
    const before=await files(root),first=await repo.preflightSnapshot(),again=await repo.preflightSnapshot();
    expect(first).toMatchObject({version:4,actorCount:1,controlActorKey:'main',migrationRequired:false,hasPersistentIdentity:false});
    expect(first.sourceDigest).toBe(again.sourceDigest);expect(await files(root)).toEqual(before);
    const actorFile=Object.keys(before).find(p=>p.endsWith('/actor.json'))!,actor=JSON.parse(before[actorFile]);actor.agentName='changed';
    await writeFile(join(root,actorFile),JSON.stringify(actor));expect((await repo.preflightSnapshot()).sourceDigest).not.toBe(first.sourceDigest);
  });
});
test('unknown and corrupt versions are explicitly rejected and a preflight cannot migrate or remove their bytes',async()=>{
  await scene(async(repo,root)=>{
    const manifest=JSON.parse(await readFile(repo.manifestPath,'utf8'));manifest.version=999;await writeFile(repo.manifestPath,JSON.stringify(manifest));
    const before=await files(root);await expect(repo.preflightSnapshot()).rejects.toThrow('unsupported');expect(await files(root)).toEqual(before);
    await writeFile(repo.manifestPath,'{corrupt');await expect(repo.preflightSnapshot()).rejects.toThrow();expect(await readFile(repo.manifestPath,'utf8')).toBe('{corrupt');
  });
});
test('legacy v3 inspection retains original authority and never calls the runtime importer',async()=>{
  await scene(async(repo,root)=>{
    await legacy(root);
    let invoked=false;
    const reader=new LocalFileRuntimeSnapshotRepository(repo.rootDir,{importers:[{migrationId:'must-not-run',sourceVersion:3,targetVersion:4,importSnapshot(){invoked=true;throw new Error('preflight wrote');}}]});
    const before=await files(root),inspection=await reader.preflightSnapshot();
    expect(inspection).toMatchObject({version:3,migrationRequired:true,controlActorKey:'main',actorCount:1});
    expect(invoked).toBe(false);expect(await files(root)).toEqual(before);
  });
});
test('explicit v3 upgrade uses the runtime importer, retains original backup and supports exact receipt reconciliation',async()=>{
  await scene(async(repo,root)=>{
    await legacy(root);
    const owner=new LocalFileRuntimeSnapshotRepository(repo.rootDir,{importers:[createWorkflowLifecycleSnapshotImporter()]});
    const before=await files(root),head=before['/runtime_state/manifest.json'],prepared=await owner.preflightSnapshot();
    await expect(owner.upgradePreparedSnapshot('wrong digest')).rejects.toThrow('digest');expect(await files(root)).toEqual(before);
    const result=await owner.upgradePreparedSnapshot(prepared.sourceDigest);expect(result.migrated).toBe(true);expect(result.inspection.version).toBe(4);
    expect(await readFile(join(repo.rootDir,result.backupFile!),'utf8')).toBe(head);
    const after=await files(root);for(const [path,bytes] of Object.entries(before))if(path!=='/runtime_state/manifest.json')expect(after[path]).toBe(bytes);
    expect(await owner.upgradePreparedSnapshot(prepared.sourceDigest)).toEqual(result);expect(await files(root)).toEqual(after);
  });
});
for(const point of ['before-head-swap','after-head-swap'] as const)test(`upgrade failure at ${point} retains a recoverable original head or an exactly proven admitted head`,async()=>{
  await scene(async(repo,root)=>{
    await legacy(root);const original=await readFile(repo.manifestPath,'utf8'),importers=[createWorkflowLifecycleSnapshotImporter()];
    const failing=new LocalFileRuntimeSnapshotRepository(repo.rootDir,{importers,migrationFaultInjector(at){if(at===point)throw new Error('injected fault');}});
    const prepared=await failing.preflightSnapshot();await expect(failing.upgradePreparedSnapshot(prepared.sourceDigest)).rejects.toThrow('injected fault');
    const healthy=new LocalFileRuntimeSnapshotRepository(repo.rootDir,{importers}),inspection=await healthy.preflightSnapshot();
    expect(inspection.version).toBe(point==='before-head-swap'?3:4);
    const result=await healthy.upgradePreparedSnapshot(prepared.sourceDigest);expect(result.inspection.version).toBe(4);
    expect(await readFile(join(repo.rootDir,result.backupFile!),'utf8')).toBe(original);
  });
});
test('preflight rejects symlink references and oversized manifests without reading outside the original authority',async()=>{
  await scene(async(repo,root)=>{
    const manifest=JSON.parse(await readFile(repo.manifestPath,'utf8')),file=join(repo.rootDir,manifest.vmFile),original=await readFile(file);
    await writeFile(join(root,'outside-test.json'),original);await rm(file);await symlink(join(root,'outside-test.json'),file);
    await expect(repo.preflightSnapshot()).rejects.toThrow('no-symlink');await rm(file);await writeFile(file,original);
    await writeFile(repo.manifestPath,' '.repeat(1024*1024+1));await expect(repo.preflightSnapshot()).rejects.toThrow('budget');
  });
});
