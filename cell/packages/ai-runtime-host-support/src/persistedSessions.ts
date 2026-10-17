import {createHash} from 'node:crypto'
import {constants} from 'node:fs'
import {lstat,open,opendir,realpath} from 'node:fs/promises'
import {join} from 'node:path'
import type {PersistedSessionCandidate} from '@cell/ai-runtime-host-contract'

const manifestLimit=1024*1024, inventoryLimit=16*1024*1024;
const missing=(error:unknown)=>(error as {code?:string}).code==='ENOENT';
export function validPersistedSessionId(id:string){return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(id)&&id!=='.'&&id!=='..'}

/** Only the owning workspace's original session root is addressable. Never accept
 * a client path, resolve a symlink, or create source directories during discovery. */
export async function persistedSessionDirectory(workDir:string,sessionId?:string):Promise<string|undefined>{
  if(sessionId!==undefined&&!validPersistedSessionId(sessionId))throw new Error('invalid_session_id');
  let current=await realpath(workDir);
  for(const part of ['.eidolon','sessions',...(sessionId===undefined?[]:[sessionId])]){
    current=join(current,part);
    let stat;try{stat=await lstat(current)}catch(error){if(missing(error))return undefined;throw error}
    if(stat.isSymbolicLink()||!stat.isDirectory()||await realpath(current)!==current)throw new Error('persisted_session_path_unsafe');
  }
  return current;
}

async function readJson(filename:string,limit:number):Promise<{value:unknown;digest:string;bytes:number}|undefined>{
  let file;try{file=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW)}catch(error){if(missing(error))return undefined;throw error}
  try{
    const stat=await file.stat();if(!stat.isFile()||stat.size>limit)throw new Error('persisted_session_metadata_limit');
    const bytes=Buffer.alloc(stat.size+1);let used=0;
    while(used<bytes.length){const read=await file.read(bytes,used,bytes.length-used,null);if(!read.bytesRead)break;used+=read.bytesRead}
    if(used!==stat.size)throw new Error('persisted_session_source_changed');
    const data=bytes.subarray(0,used);
    let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data))}catch{value=null}
    return {value,digest:createHash('sha256').update(data).digest('hex'),bytes:used};
  }finally{await file.close()}
}

export type PersistedSessionInventory=Readonly<{candidates:readonly PersistedSessionCandidate[];revision:string}>;
export async function readPersistedSessionInventory(workDir:string):Promise<PersistedSessionInventory>{
  const directory=await persistedSessionDirectory(workDir);
  if(!directory)return {candidates:[],revision:'absent'};
  const names:string[]=[];const entries=await opendir(directory);let entryCount=0;
  for await(const entry of entries){
    if(++entryCount>4096)throw new Error('persisted_session_inventory_limit');
    if(entry.isDirectory()&&validPersistedSessionId(entry.name))names.push(entry.name);
  }
  names.sort();const candidates:PersistedSessionCandidate[]=[],hash=createHash('sha256');let total=0;
  for(const sessionId of names){
    const sessionDir=await persistedSessionDirectory(workDir,sessionId);
    if(!sessionDir)throw new Error('persisted_session_source_changed');
    const runtimeDir=join(sessionDir,'runtime_state');
    let manifest:Awaited<ReturnType<typeof readJson>>;
    try{
      const stat=await lstat(runtimeDir);
      if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error('persisted_session_path_unsafe');
      manifest=await readJson(join(runtimeDir,'manifest.json'),manifestLimit);
    }catch(error){if(!missing(error))throw error}
    const metadata=await readJson(join(sessionDir,'tui-session.json'),65536);
    total+=(manifest?.bytes??0)+(metadata?.bytes??0);
    if(total>inventoryLimit)throw new Error('persisted_session_inventory_limit');
    const info=metadata?.value as {title?:unknown;deleted?:unknown}|null|undefined;
    if(metadata&&(!info||typeof info!=='object'||Array.isArray(info)))throw new Error('persisted_session_metadata_invalid');
    const title=typeof info?.title==='string'&&info.title.trim()?info.title.trim():sessionId;
    if(title.length>512||Buffer.byteLength(title)>1024)throw new Error('persisted_session_metadata_limit');
    const data=manifest?.value as {version?:unknown}|null|undefined;
    const format=!manifest?'history-only':!data||typeof data!=='object'||Array.isArray(data)?'corrupt':data.version===4?'v4':data.version===3?'legacy-v3':'unsupported';
    candidates.push({sessionId,displayName:title,format,registered:false,tuiHidden:info?.deleted===true});
    hash.update(JSON.stringify([sessionId,manifest?.digest??null,metadata?.digest??null]));
    if(await persistedSessionDirectory(workDir,sessionId)!==sessionDir)throw new Error('persisted_session_source_changed');
  }
  if(await persistedSessionDirectory(workDir)!==directory)throw new Error('persisted_session_source_changed');
  return {candidates,revision:hash.digest('hex')};
}
