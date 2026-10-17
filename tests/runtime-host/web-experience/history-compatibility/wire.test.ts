import {expect,test} from 'bun:test';
import {parsePersistedSessionPage,parsePersistedSessionPreflight,parseImportPersistedSessionCommand,parseImportedSessionResult} from '../../../../cell/packages/ai-runtime-host-contract/src';
const digest='sha256:'+'a'.repeat(64),candidate={sessionId:'original',displayName:'Original TUI',format:'legacy-v3',registered:false,tuiHidden:false};
const preflight={sessionId:'original',displayName:'Original TUI',snapshotVersion:3 as const,sourceDigest:digest,controlActorKey:'main',actorCount:1,readOnly:false,migrationRequired:true,registered:false,tuiHidden:false};
const command={commandId:'accept',expectedServerInstanceId:'server',expectedSourceDigest:digest,upgrade:true};
test('history import wire retains exact source and acceptance and rejects arbitrary paths, metadata and unsupported previews',()=>{
  expect(parsePersistedSessionPage({candidates:[candidate]}).candidates[0]?.sessionId).toBe('original');
  expect(parsePersistedSessionPreflight(preflight)).toEqual(preflight);expect(parseImportPersistedSessionCommand(command)).toEqual(command);
  for(const input of [{...command,path:'/etc'},{...command,expectedSourceDigest:'not-digest'},{...command,upgrade:'yes'}])expect(()=>parseImportPersistedSessionCommand(input)).toThrow();
  for(const input of [{...preflight,snapshotVersion:999},{...preflight,migrationRequired:false},{...preflight,actorCount:65},{...preflight,actorCount:0},{...preflight,provider:{apiKey:'must-not-cross'}}])expect(()=>parsePersistedSessionPreflight(input)).toThrow();
  expect(()=>parsePersistedSessionPage({candidates:[candidate,candidate]})).toThrow();
});
test('receipt requires original source, current admitted format and canonical backup reference without leaking filesystem paths',()=>{
  const receipt={commandId:'accept',session:{sessionId:'original',epoch:'epoch',displayName:'Original TUI',readOnly:false},sourceDigest:digest,snapshotVersion:4,migrated:true,backupFile:'migration-backups/v3-'+'b'.repeat(64)+'.json'};
  expect(parseImportedSessionResult(receipt).session.sessionId).toBe('original');
  for(const input of [{...receipt,backupFile:'/Users/private/manifest.json'},{...receipt,migrated:false},{...receipt,snapshotVersion:3},{...receipt,sourceDigest:'sha256:'+'z'.repeat(64)}])expect(()=>parseImportedSessionResult(input)).toThrow();
});
