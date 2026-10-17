import {expect,test} from 'bun:test';
import {mkdtemp,mkdir,rm,readFile,writeFile,readdir,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createActor,createVM,serializeActor,serializeVM} from '../../../../cell/packages/ai-core-logic/src';
import {LocalFileRuntimeSnapshotRepository} from '../../../../cell/packages/ai-support/src';
import {createHost} from '../../../../cell/packages/ai-runtime-host-capsule/src/host';
import {createSessionWriterLeaseEffects,openHostSessionRegistry,readPersistedSessionInventory} from '../../../../cell/packages/ai-runtime-host-support/src';
import {createAnchorHttpHost} from '../../../../backend/packages/elysia/src/runtimeRoutes';
import {bearerAuthentication} from '../../../../backend/packages/elysia/src/runtimeAuth';
import {parsePersistedSessionPage,parsePersistedSessionPreflight,parseImportedSessionResult,type HostRequest} from '../../../../cell/packages/ai-runtime-host-contract/src';

const request:HostRequest={principal:{principalId:'owner',grantsVersion:'1'},requestId:'p3-history'};
async function scene(run:(work:string,root:string,seed:(id:string,version?:3|4)=>Promise<LocalFileRuntimeSnapshotRepository>)=>Promise<void>){
  const root=await mkdtemp(join(tmpdir(),'anchor-p3-history-host-')),work=join(root,'work');
  try{
    await mkdir(join(work,'.eidolon'),{recursive:true});
    const seed=async(id:string,version:3|4=4)=>{
      const directory=join(work,'.eidolon','sessions',id),repo=new LocalFileRuntimeSnapshotRepository(join(directory,'runtime_state'));
      const actor=createActor({key:'main',type:'primary',systemPrompts:['isolated history']}),vm=createVM({controlActorKey:'main',actors:{main:actor}});
      await repo.writeSnapshot({vm:serializeVM(vm),actors:{main:serializeActor(actor)},fibers:{},questionnaires:[]});
      await writeFile(join(directory,'tui-session.json'),JSON.stringify({title:`Original ${id}`,deleted:false}));
      if(version===3)for(const path of await readdir(directory,{recursive:true})){
        if(!path.endsWith('.json'))continue;const file=join(directory,path),value=JSON.parse(await readFile(file,'utf8'));
        if(value.version===4)value.version=3;if(value.schemaVersion===4)value.schemaVersion=3;await writeFile(file,JSON.stringify(value));
      }
      return repo;
    };
    await run(work,root,seed);
  }finally{await rm(root,{recursive:true,force:true})}
}
test('authorized readonly inventory, source preflight and exact admission preserve original identities, leases and durable receipts',async()=>{
  await scene(async(work,root,seed)=>{
    const repo=await seed('original'),originalActors=await repo.readActorDirectory();expect(originalActors).toHaveLength(1);
    await seed('denied');await seed('hidden');
    await writeFile(join(work,'.eidolon/sessions/hidden/tui-session.json'),JSON.stringify({title:'Hidden',deleted:true}));
    let denied='',grants='1';
    const authorization={currentGrantsVersion:()=>grants,permits:(_p:unknown,t:{action:string;sessionId?:string})=>t.action!==denied&&t.sessionId!=='denied'};
    const options={workDir:work,globalRoot:join(root,'global'),authorization};let host=await createHost(options);
    const token='history-host-'+ 'x'.repeat(48);let http=createAnchorHttpHost({runtime:host,listen:{port:0},security:{authenticate:bearerAuthentication(token,request.principal),authorization}});await http.start();
    const wire=(path:string,payload?:unknown)=>fetch(http.address+path,{method:payload===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...(payload===undefined?{}:{'Content-Type':'application/json'})},...(payload===undefined?{}:{body:JSON.stringify(payload)})});
    const dto=async(response:Response)=>{expect(response.status).toBe(200);const {requestId:_r,...value}=await response.json();return value};
    try{
      const filesBefore=(await readdir(join(work,'.eidolon/sessions/original'),{recursive:true})).sort();
      const page=parsePersistedSessionPage(await dto(await wire('/v1/persisted-sessions')));
      expect(page.candidates.map(c=>c.sessionId)).toEqual(['original']);expect(page.candidates[0]!.registered).toBe(false);
      const preview=parsePersistedSessionPreflight(await dto(await wire('/v1/persisted-sessions/original/preflight')));
      expect(preview).toMatchObject({snapshotVersion:4,controlActorKey:'main',actorCount:1,registered:false,migrationRequired:false});
      expect((await readdir(join(work,'.eidolon/sessions/original'),{recursive:true})).sort()).toEqual(filesBefore);
      expect((await host.sessions(request,{})).sessions).toHaveLength(0);
      const command={commandId:'accept',expectedServerInstanceId:host.capabilities(request).serverInstanceId,expectedSourceDigest:preview.sourceDigest,upgrade:false};
      denied='import_session';expect((await wire('/v1/persisted-sessions/original/imports',command)).status).toBe(403);denied='';
      const held=await createSessionWriterLeaseEffects().acquire(join(work,'.eidolon/sessions/original'));
      try{expect((await wire('/v1/persisted-sessions/original/imports',command)).status).toBe(409)}finally{held.release()}
      const result=parseImportedSessionResult(await dto(await wire('/v1/persisted-sessions/original/imports',command)));
      expect(result).toMatchObject({migrated:false,sourceDigest:preview.sourceDigest,session:{sessionId:'original',displayName:'Original original'}});
      expect((await host.sessions(request,{})).sessions).toHaveLength(1);
      expect((await repo.preflightSnapshot()).sourceDigest).toBe(preview.sourceDigest);
      expect(await repo.readActorDirectory()).toEqual(originalActors);
      await http.close();host=await createHost(options);
      http=createAnchorHttpHost({runtime:host,listen:{port:0},security:{authenticate:bearerAuthentication(token,request.principal),authorization}});await http.start();
      expect(parseImportedSessionResult(await dto(await wire('/v1/persisted-sessions/original/imports',command)))).toEqual(result);
      expect(parseImportedSessionResult(await dto(await wire('/v1/persisted-sessions/original/imports/accept')))).toEqual(result);
      expect((await wire('/v1/persisted-sessions/original/imports',{...command,upgrade:true})).status).toBe(409);
      expect((await wire('/v1/persisted-sessions/original/preflight?path=/tmp')).status).toBe(400);
      denied='discover_sessions';expect((await wire('/v1/persisted-sessions')).status).toBe(403);denied='';grants='2';expect((await wire('/v1/persisted-sessions')).status).toBe(401);grants='1';
    }finally{await http.close()}
  });
},30000);

test('explicit legacy upgrade backs up original head while unsupported, hidden, archived and changed sources cannot be admitted',async()=>{
  await scene(async(work,root,seed)=>{
    const legacy=await seed('legacy',3),oldHead=await readFile(legacy.manifestPath,'utf8');const changed=await seed('changed');await seed('unsupported');
    await writeFile(join(work,'.eidolon/sessions/unsupported/runtime_state/manifest.json'),JSON.stringify({version:99}));
    const host=await createHost({workDir:work,globalRoot:join(root,'global'),authorization:{currentGrantsVersion:()=> '1',permits:()=>true}});
    try{
      const preview=await host.preflightPersistedSession!(request,{sessionId:'legacy'}),command={commandId:'legacy',expectedServerInstanceId:host.capabilities(request).serverInstanceId,expectedSourceDigest:preview.sourceDigest,upgrade:false};
      await expect(host.importPersistedSession!(request,{sessionId:'legacy'},command)).rejects.toMatchObject({status:409,error:{code:'persisted_session_upgrade_required'}});
      expect(await readFile(legacy.manifestPath,'utf8')).toBe(oldHead);
      const result=await host.importPersistedSession!(request,{sessionId:'legacy'},{...command,upgrade:true});expect(result.migrated).toBe(true);
      expect(await readFile(join(legacy.rootDir,result.backupFile!),'utf8')).toBe(oldHead);expect(result.session.sessionId).toBe('legacy');
      await expect(host.preflightPersistedSession!(request,{sessionId:'unsupported'})).rejects.toMatchObject({status:422});
      const previous=await host.preflightPersistedSession!(request,{sessionId:'changed'});const head=JSON.parse(await readFile(changed.manifestPath,'utf8'));await writeFile(changed.manifestPath,JSON.stringify({...head,createdAt:'change'}));
      await expect(host.importPersistedSession!(request,{sessionId:'changed'},{...command,commandId:'changed',expectedSourceDigest:previous.sourceDigest})).rejects.toMatchObject({status:409});
      expect((await host.sessions(request,{})).sessions.map(s=>s.sessionId)).toEqual(['legacy']);
    }finally{await host.close()}
    const registry=openHostSessionRegistry(join(work,'.eidolon/web-host'));
    try{registry.management.commit({principalId:'owner',sessionId:'legacy'},{commandId:'archive',kind:'archive',expectedServerInstanceId:'past',expectedEpoch:'past',expectedMetadataRevision:0},Date.now())}finally{registry.close()}
    const restarted=await createHost({workDir:work,authorization:{currentGrantsVersion:()=> '1',permits:()=>true}});
    try{
      expect((await restarted.persistedSessions!(request,{})).candidates.map(c=>c.sessionId)).not.toContain('legacy');
      await expect(restarted.preflightPersistedSession!(request,{sessionId:'legacy'})).rejects.toMatchObject({status:409,error:{code:'session_archived'}});
    }finally{await restarted.close()}
  });
},30000);

test('inventory cursors expire on original metadata changes and no discovery follows session or parent symlinks',async()=>{
  await scene(async(work,root,seed)=>{
    await seed('one');await seed('two');const host=await createHost({workDir:work,authorization:{currentGrantsVersion:()=> '1',permits:()=>true}});
    try{
      const page=await host.persistedSessions!(request,{limit:1});expect(page.nextCursor).toBeDefined();
      await writeFile(join(work,'.eidolon/sessions/two/tui-session.json'),JSON.stringify({title:'Changed'}));
      await expect(host.persistedSessions!(request,{limit:1,after:page.nextCursor})).rejects.toMatchObject({status:410});
      await symlink(join(root,'outside'),join(work,'.eidolon/sessions/linked'));
      expect((await readPersistedSessionInventory(work)).candidates.map(c=>c.sessionId)).not.toContain('linked');
      await expect(host.preflightPersistedSession!(request,{sessionId:'../outside'})).rejects.toMatchObject({status:400});
      await rm(join(work,'.eidolon/sessions'),{recursive:true});await mkdir(join(root,'outside'));await symlink(join(root,'outside'),join(work,'.eidolon/sessions'));
      await expect(host.persistedSessions!(request,{})).rejects.toMatchObject({status:422});
      expect(await readdir(join(root,'outside'))).toEqual([]);
    }finally{await host.close()}
  });
},30000);

test('private Bot backing sessions cannot be discovered, preflighted or imported even by their owning principal',async()=>{
  await scene(async(work,_root,seed)=>{
    await seed('private-bot');
    const registry=openHostSessionRegistry(join(work,'.eidolon/web-host'));
    try{registry.bindParticipant({principalId:'owner',bindingKey:'private-channel',recipient:{kind:'member',ref:'writer',ownerScopeRef:'workspace',bindingRef:'binding',bindingDigest:'digest',admissionRef:'admission'},
      session:{sessionId:'private-bot',storageKey:'private-bot',profileId:'ai-coding',displayName:'Private bot',createdAt:1}})}finally{registry.close()}
    const host=await createHost({workDir:work,authorization:{currentGrantsVersion:()=> '1',permits:()=>true}});
    try{
      expect((await host.persistedSessions!(request,{})).candidates).toEqual([]);
      await expect(host.preflightPersistedSession!(request,{sessionId:'private-bot'})).rejects.toMatchObject({status:403});
      await expect(host.importPersistedSession!(request,{sessionId:'private-bot'},{commandId:'reject',expectedServerInstanceId:host.capabilities(request).serverInstanceId,expectedSourceDigest:'sha256:'+'a'.repeat(64),upgrade:false})).rejects.toMatchObject({status:403});
    }finally{await host.close()}
  });
});
