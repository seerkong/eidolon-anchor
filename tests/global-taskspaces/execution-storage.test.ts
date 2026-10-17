import {afterEach,expect,test} from 'bun:test'
import {mkdtemp,mkdir,rm,symlink,readFile,writeFile} from 'node:fs/promises'
import {existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {prepareGlobalRootExecutionPaths} from '../../cell/packages/ai-runtime-host-support/src/globalTaskSpaces'
import {installBundledSystemSkills} from '@cell/ai-support/system-skill/SystemSkillInstaller'
import {LocalFileRuntimeSnapshotRepository} from '@cell/ai-support/runtime/LocalFileRuntimeSnapshotRepository'
import {__setLlmAdapterFactoryForTest,createSessionRuntimeAssembly,type SessionRuntimeReady} from '../../cell/packages/ai-runtime-host-capsule/src/session/SessionRuntimeAssembly'

afterEach(()=>__setLlmAdapterFactoryForTest(null))
test('managed VM snapshots use their owner directory and never enter the navigable Session inventory',async()=>{
  const root=await mkdtemp(join(tmpdir(),'global-execution-storage-')),globalRoot=join(root,'global'),workDir=join(globalRoot,'daemon')
  await mkdir(workDir,{recursive:true});await installBundledSystemSkills({globalRoot})
  let calls=0,ready!:SessionRuntimeReady,bridge:Awaited<ReturnType<typeof createSessionRuntimeAssembly>>|undefined
  __setLlmAdapterFactoryForTest(async()=>({type:'openai',runtime:{adapterName:'openai',providerId:'fixture'},async createStream(){calls++;throw new Error('unexpected_provider_request')}}))
  try{
    const paths=prepareGlobalRootExecutionPaths(workDir,'a'.repeat(40))
    bridge=await createSessionRuntimeAssembly({sessionKey:'managed-fixture',ownedSessionDir:paths.sessionDir,config:{workDir,globalRoot,adapter:'openai',model:'mock',mcp:false,profileId:'ai-coding'},requireExplicitGoalActivation:true,onRuntimeReady(value){ready=value}})
    expect(ready.sessionDir).toBe(paths.sessionDir);ready.activateSessionMaterialization();await ready.persistSnapshot()
    expect(existsSync(join(paths.sessionDir,'runtime_state'))).toBe(true)
    expect(existsSync(join(workDir,'.eidolon','sessions'))).toBe(false);expect(calls).toBe(0)
    const repository=new LocalFileRuntimeSnapshotRepository(join(paths.sessionDir,'runtime_state'))
    expect(await repository.inspectQuestionnaires('managed-fixture')).toEqual([])
    await expect(repository.inspectQuestionnaires('foreign-session')).rejects.toThrow('session mismatch')
    const manifest=JSON.parse(await readFile(repository.manifestPath,'utf8')),questionFile=join(repository.rootDir,manifest.questionnairesFile??'questionnaires.xnl'),original=await readFile(questionFile)
    await writeFile(questionFile,'x'.repeat(1024*1024+1))
    await expect(repository.inspectQuestionnaires('managed-fixture')).rejects.toThrow('byte budget')
    await writeFile(questionFile,original)
    await writeFile(repository.manifestPath,JSON.stringify({...manifest,questionnairesFile:'../../foreign/questionnaires.xnl'}))
    await expect(repository.inspectQuestionnaires('managed-fixture')).rejects.toThrow('escapes authority')
    await writeFile(repository.manifestPath,JSON.stringify(manifest))
    await bridge!.dispose();bridge=undefined
    bridge=await createSessionRuntimeAssembly({sessionKey:'managed-fixture',ownedSessionDir:paths.sessionDir,config:{workDir,globalRoot,adapter:'openai',model:'mock',mcp:false,profileId:'ai-coding'},requireExplicitGoalActivation:true,onRuntimeReady(value){ready=value}})
    expect(ready.sessionDir).toBe(paths.sessionDir);expect(calls).toBe(0)
  }finally{await bridge!?.dispose();await rm(root,{recursive:true,force:true})}
},30000)
test('execution storage rejects a public-looking path and symlinked owner directories',async()=>{
  const root=await mkdtemp(join(tmpdir(),'global-execution-containment-')),outside=await mkdtemp(join(tmpdir(),'global-execution-outside-'))
  try{
    expect(()=>prepareGlobalRootExecutionPaths(root,'c'.repeat(40),false)).toThrow()
    expect(existsSync(join(root,'.eidolon'))).toBe(false)
    expect(()=>prepareGlobalRootExecutionPaths(root,'../outside')).toThrow('invalid_global_execution_identity')
    await mkdir(join(root,'.eidolon','global-taskspaces'),{recursive:true});await symlink(outside,join(root,'.eidolon','global-taskspaces','executions'),'dir')
    expect(()=>prepareGlobalRootExecutionPaths(root,'b'.repeat(40))).toThrow('global_execution_storage_invalid')
    expect(existsSync(join(outside,'b'.repeat(40)))).toBe(false)
  }finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true})}
})
