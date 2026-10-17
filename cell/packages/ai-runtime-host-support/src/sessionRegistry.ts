/// <reference types="bun-types" />
import { Database } from "bun:sqlite"
import {createHash} from 'node:crypto'
import { mkdirSync, openSync, closeSync, constants } from "node:fs"
import { join } from "node:path"
import { createConversationPublicationStore } from "./conversationPublication"
import { createExecutionOutputStore } from './executionOutput'
import { createSessionManagementStore, type SessionManagementLimits } from "./sessionManagement"
import { parseSessionProjectContext, parseHostParticipantBindingReceipt, type HostParticipantRecipient, type HostParticipantBindingReceipt, type SessionProjectContext } from "@cell/ai-runtime-host-contract"
import {parseImportPersistedSessionCommand,parseImportedSessionResult,type ImportPersistedSessionCommand,type ImportedSessionResult} from '@cell/ai-runtime-host-contract'
import type {ExecutionEnvironmentRef} from '@cell/ai-runtime-host-contract'

export type StoredHostSession = Readonly<{ sessionId: string; storageKey: string; profileId: string; displayName: string; createdAt: number; projectContext?: SessionProjectContext; participantBinding?: HostParticipantBindingReceipt & { principalId: string } }>
const recipientFingerprint = (r: HostParticipantRecipient) => JSON.stringify([r.kind, r.ref, r.ownerScopeRef, r.bindingRef, r.bindingDigest, r.admissionRef ?? null])

/** Durable public identity mapping only. Conversation and execution state remain in their owners. */
export function openHostSessionRegistry(directory: string, managementLimits?: SessionManagementLimits) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const filename = join(directory, "sessions.sqlite")
  closeSync(openSync(filename, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600))
  const database = new Database(filename, { strict: true })
  database.exec(`PRAGMA busy_timeout=2000;
    CREATE TABLE IF NOT EXISTS host_sessions (
      sessionId TEXT PRIMARY KEY, storageKey TEXT NOT NULL UNIQUE, profileId TEXT NOT NULL,
      displayName TEXT NOT NULL, createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS host_session_context (
      sessionId TEXT PRIMARY KEY, projectContext TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS host_session_commands (
      instanceId TEXT NOT NULL, principalId TEXT NOT NULL, commandId TEXT NOT NULL,
      profileId TEXT NOT NULL, sessionId TEXT NOT NULL,
      PRIMARY KEY(instanceId, principalId, commandId)
    );
    CREATE TABLE IF NOT EXISTS host_participant_bindings (
      principalId TEXT NOT NULL, bindingKey TEXT NOT NULL, fingerprint TEXT NOT NULL,
      recipient TEXT NOT NULL, sessionId TEXT NOT NULL UNIQUE,
      PRIMARY KEY(principalId, bindingKey)
    );
    CREATE TABLE IF NOT EXISTS host_session_imports (
      principalId TEXT NOT NULL, sessionId TEXT NOT NULL, commandId TEXT NOT NULL,
      digest TEXT NOT NULL, result TEXT NOT NULL, bytes INTEGER NOT NULL,
      PRIMARY KEY(principalId,sessionId,commandId)
    );`)
  if(!database.query<{name:string},[]>('PRAGMA table_info(host_participant_bindings)').all().some(row=>row.name==='executionEnvironment'))database.exec('ALTER TABLE host_participant_bindings ADD COLUMN executionEnvironment TEXT')
  const withContext = (session: StoredHostSession): StoredHostSession => {
    const context = database.query<{ projectContext: string }, [string]>("SELECT projectContext FROM host_session_context WHERE sessionId=?").get(session.sessionId)
    const binding = database.query<{ principalId: string; bindingKey: string; recipient: string;executionEnvironment:string|null }, [string]>("SELECT principalId,bindingKey,recipient,executionEnvironment FROM host_participant_bindings WHERE sessionId=?").get(session.sessionId)
    return { ...session, ...(context ? { projectContext: parseSessionProjectContext(JSON.parse(context.projectContext)) } : {}),
      ...(binding ? { participantBinding: { ...parseHostParticipantBindingReceipt({ bindingKey: binding.bindingKey, recipient: JSON.parse(binding.recipient), sessionId: session.sessionId,...(binding.executionEnvironment?{executionEnvironment:JSON.parse(binding.executionEnvironment)}:{}) }), principalId: binding.principalId } } : {}) }
  }
  const get = (id: string) => {
    const row = database.query<StoredHostSession, [string]>("SELECT * FROM host_sessions WHERE sessionId=?").get(id)
    return row ? withContext(row) : undefined
  }
  const management = createSessionManagementStore(database, managementLimits)
  const participantBinding = (principalId: string, bindingKey: string) => {
    const row = database.query<{ recipient: string; sessionId: string;executionEnvironment:string|null }, [string, string]>(
      'SELECT recipient,sessionId,executionEnvironment FROM host_participant_bindings WHERE principalId=? AND bindingKey=?').get(principalId, bindingKey)
    return row ? parseHostParticipantBindingReceipt({ bindingKey, recipient: JSON.parse(row.recipient), sessionId: row.sessionId,...(row.executionEnvironment?{executionEnvironment:JSON.parse(row.executionEnvironment)}:{}) }) : undefined
  }
  const insertSession = (s: StoredHostSession) => {
    database.query('INSERT INTO host_sessions VALUES (?,?,?,?,?)').run(s.sessionId, s.storageKey, s.profileId, s.displayName, s.createdAt)
    if (s.projectContext) database.query('INSERT INTO host_session_context VALUES (?,?)').run(s.sessionId, JSON.stringify(parseSessionProjectContext(s.projectContext)))
  }
  const importDigest=(command:ImportPersistedSessionCommand)=>createHash('sha256').update(JSON.stringify(parseImportPersistedSessionCommand(command))).digest('hex');
  const importRow=(principalId:string,sessionId:string,commandId:string)=>database.query<{digest:string;result:string},[string,string,string]>(
    'SELECT digest,result FROM host_session_imports WHERE principalId=? AND sessionId=? AND commandId=?').get(principalId,sessionId,commandId);
  const imported=(principalId:string,sessionId:string,command:ImportPersistedSessionCommand)=>{
    const row=importRow(principalId,sessionId,command.commandId);if(!row)return undefined;
    if(row.digest!==importDigest(command))throw new Error('idempotency_conflict');
    return parseImportedSessionResult(JSON.parse(row.result));
  };
  let closed = false
  return {
    get,
    imported,
    importedResult(principalId:string,sessionId:string,commandId:string){
      const row=importRow(principalId,sessionId,commandId);return row?parseImportedSessionResult(JSON.parse(row.result)):undefined;
    },
    importSession:database.transaction((input:{principalId:string;session:StoredHostSession;command:ImportPersistedSessionCommand;result:ImportedSessionResult})=>{
      const old=imported(input.principalId,input.session.sessionId,input.command);if(old)return old;
      const current=get(input.session.sessionId);
      if(current?.participantBinding)throw new Error('participant_session_private');
      if(management.metadata(input.session.sessionId)?.lifecycle==='archived')throw new Error('session_archived');
      if(current&&(current.storageKey!==input.session.storageKey||current.profileId!==input.session.profileId))throw new Error('session_identity_conflict');
      const result=parseImportedSessionResult(input.result);
      if(result.session.sessionId!==input.session.sessionId||result.commandId!==input.command.commandId)throw new Error('session_identity_conflict');
      const encoded=JSON.stringify(result),bytes=Buffer.byteLength(encoded)+Buffer.byteLength(input.principalId)+Buffer.byteLength(input.session.sessionId)+Buffer.byteLength(input.command.commandId)+64;
      const used=database.query<{records:number;bytes:number},[]>('SELECT COUNT(*) AS records,COALESCE(SUM(bytes),0) AS bytes FROM host_session_imports').get()!;
      if(used.records>=10000||used.bytes+bytes>64*1024*1024)throw new Error('session_import_capacity');
      if(!current)insertSession(input.session);
      database.query('INSERT INTO host_session_imports VALUES (?,?,?,?,?,?)').run(input.principalId,input.session.sessionId,input.command.commandId,importDigest(input.command),encoded,bytes);
      return result;
    }).immediate,
    participantBinding,
    bindParticipant: database.transaction((input: { principalId: string; bindingKey: string; recipient: HostParticipantRecipient; session: StoredHostSession;executionEnvironment?:ExecutionEnvironmentRef }): HostParticipantBindingReceipt => {
      const receipt = parseHostParticipantBindingReceipt({ bindingKey: input.bindingKey, recipient: input.recipient, sessionId: input.session.sessionId,...(input.executionEnvironment?{executionEnvironment:input.executionEnvironment}:{}) })
      const previous = participantBinding(input.principalId, input.bindingKey)
      if (previous) {
        if (recipientFingerprint(previous.recipient) !== recipientFingerprint(input.recipient)) throw new Error('participant_binding_conflict')
        const a=previous.executionEnvironment,b=input.executionEnvironment
        if(Boolean(a)!==Boolean(b)||a&&b&&['kind','daemonId','workspaceKey','revision'].some(k=>a[k as keyof ExecutionEnvironmentRef]!==b[k as keyof ExecutionEnvironmentRef]))throw new Error('participant_binding_conflict')
        if (!get(previous.sessionId)) throw new Error('session_registry_inconsistent')
        return previous
      }
      const count = database.query<{ total: number }, []>('SELECT COUNT(*) AS total FROM host_participant_bindings').get()!.total
      if (count >= 4096) throw new Error('participant_binding_capacity')
      insertSession(input.session)
      database.query('INSERT INTO host_participant_bindings (principalId,bindingKey,fingerprint,recipient,sessionId,executionEnvironment) VALUES (?,?,?,?,?,?)').run(input.principalId, input.bindingKey,
        recipientFingerprint(input.recipient), JSON.stringify(input.recipient), input.session.sessionId,input.executionEnvironment?JSON.stringify(input.executionEnvironment):null)
      return receipt
    }).immediate,
    creation: (instanceId: string, principalId: string, commandId: string) => database.query<{ sessionId: string }, [string, string, string]>(
      'SELECT sessionId FROM host_session_commands WHERE instanceId=? AND principalId=? AND commandId=?').get(instanceId, principalId, commandId),
    publications: createConversationPublicationStore(database),
    executionOutputs: createExecutionOutputStore(database),
    management,
    *participantSessions(){
      const statement=database.prepare<StoredHostSession,[]>('SELECT s.* FROM host_sessions s JOIN host_participant_bindings b ON b.sessionId=s.sessionId ORDER BY s.createdAt,s.sessionId')
      try{for(const row of statement.iterate())yield withContext(row)}finally{statement.finalize()}
    },
    *list() {
      // A pagination early return must release the statement, not reuse an unfinished cached iterator.
      const statement = database.prepare<StoredHostSession, []>(`SELECT s.* FROM host_sessions s LEFT JOIN host_session_metadata m ON m.sessionId=s.sessionId
        WHERE (m.lifecycle IS NULL OR m.lifecycle='active')
        AND NOT EXISTS (SELECT 1 FROM host_participant_bindings b WHERE b.sessionId=s.sessionId) ORDER BY s.createdAt,s.sessionId`)
      try { for (const row of statement.iterate()) yield withContext(row) }
      finally { statement.finalize() }
    },
    create: database.transaction((input: { instanceId: string; principalId: string; commandId: string; session: StoredHostSession }): StoredHostSession => {
      const old = database.query<{ profileId: string; sessionId: string }, [string, string, string]>(
        "SELECT profileId,sessionId FROM host_session_commands WHERE instanceId=? AND principalId=? AND commandId=?",
      ).get(input.instanceId, input.principalId, input.commandId)
      if (old) {
        if (old.profileId !== input.session.profileId) throw new Error("idempotency_conflict")
        const session = get(old.sessionId)
        if (!session) throw new Error("session_registry_inconsistent")
        return session
      }
      const s = input.session
      insertSession(s)
      database.query("INSERT INTO host_session_commands VALUES (?,?,?,?,?)").run(input.instanceId, input.principalId, input.commandId, s.profileId, s.sessionId)
      return s
    }),
    close() { if (!closed) { closed = true; database.close() } },
  }
}
