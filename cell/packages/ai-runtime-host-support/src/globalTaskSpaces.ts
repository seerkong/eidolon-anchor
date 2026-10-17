import { join,sep } from 'node:path';
import {existsSync,lstatSync,mkdirSync,realpathSync} from 'node:fs';
import { FileTaskSpaceOwner,taskArtifactBodyFromBytes } from 'task-manager-file-support';
import {canonicalOwnDataBytes} from 'task-manager-contract';
/** Composition supplies the daemon's canonical global workspace, never an HTTP path. */
export function openGlobalTaskSpaceOwner(globalWorkspace: string) {
    return new FileTaskSpaceOwner({ root: join(globalWorkspace, '.eidolon', 'global-taskspaces', 'task-spaces') });
}
export function globalTaskBindingArtifact(value:unknown){return taskArtifactBodyFromBytes(canonicalOwnDataBytes(value),'application/json')}

/** Paths are derived from a server execution digest. No public request supplies a path. */
export function prepareGlobalRootExecutionPaths(globalWorkspace:string,executionId:string,create=true){
  if(!/^[a-f0-9]{40}$/.test(executionId))throw new Error('invalid_global_execution_identity')
  const root=realpathSync(globalWorkspace)
  let current=root
  for(const part of ['.eidolon','global-taskspaces','executions',executionId]){
    current=join(current,part)
    if(!existsSync(current)&&create)mkdirSync(current,{mode:0o700})
    const stat=lstatSync(current)
    if(stat.isSymbolicLink()||!stat.isDirectory()||!realpathSync(current).startsWith(root+sep))throw new Error('global_execution_storage_invalid')
  }
  const sessionDir=join(current,'runtime-session')
  if(!existsSync(sessionDir)&&create)mkdirSync(sessionDir,{mode:0o700})
  const stat=lstatSync(sessionDir)
  if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('global_execution_storage_invalid')
  return {supportRoot:current,sessionDir}
}
