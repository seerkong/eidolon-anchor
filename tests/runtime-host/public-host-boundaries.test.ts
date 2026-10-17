import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, rename } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installBundledSystemSkills } from "@cell/ai-support/system-skill/SystemSkillInstaller"
import { createHost } from "../../cell/packages/ai-runtime-host-capsule/src/host"
import { __setLlmAdapterFactoryForTest, createSessionRuntimeAssembly, type SessionRuntimeReady } from "../../cell/packages/ai-runtime-host-capsule/src/session/SessionRuntimeAssembly"
import { createMockProviderCacheCostObservation } from "../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream"
import type { HostAuthorizationEffects, HostRequest } from "../../cell/packages/ai-runtime-host-contract/src"
import { createActor } from "../../cell/packages/ai-core-logic/src/runtime/actor"
import { createVM } from "../../cell/packages/ai-core-logic/src/runtime/runtime"
import { appendLiveHistoryMessageToConversationDomainRuntime, ensureVmConversationDomainRuntime } from "../../cell/packages/ai-organ-logic/src/conversationCapsule/coreLogic"
import { createPublicHistoryReader } from "../../cell/packages/ai-runtime-host-capsule/src/publicHistory"
import { projectInputContentText } from '@shared/composer'

const caller: HostRequest = { principal: { principalId: "owner", grantsVersion: "1" }, requestId: "boundary-request" }
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); __setLlmAdapterFactoryForTest(null) })
function adapter() {
  return { type: "openai", runtime: { adapterName: "openai", providerId: "openai" }, async createStream(options: any) {
    async function* stream() { yield { choices: [{ delta: { content: "public reply" } }] }; yield { choices: [{ delta: {}, finish_reason: "stop" }] } }
    return { stream: stream(), providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }) }
  } }
}
async function fixture(authorization: HostAuthorizationEffects = { permits: () => true, currentGrantsVersion: () => "1" }, factory: () => Promise<any> = async () => adapter()) {
  const root = await mkdtemp(join(tmpdir(), "anchor-host-boundaries-")); const workDir = join(root, "workspace"); const globalRoot = join(root, "global")
  await mkdir(join(workDir, ".eidolon"), { recursive: true }); await installBundledSystemSkills({ globalRoot }); __setLlmAdapterFactoryForTest(factory)
  const host = await createHost({ workDir, globalRoot, authorization, runtimeConfig: { adapter: "openai", model: "gpt-4o-mini", mcp: false } })
  cleanup.push(async () => { await host.close(); await rm(root, { recursive: true, force: true }) })
  return { host, workDir, globalRoot, create: () => host.createSession(caller, { commandId: "create", profileId: "ai-coding", expectedServerInstanceId: host.capabilities(caller).serverInstanceId }) }
}
async function until(read: () => Promise<boolean>) {
  const deadline = Date.now() + 5000
  while (!await read()) { if (Date.now() >= deadline) throw new Error("boundary_timeout"); await Bun.sleep(10) }
}
test("actor preflight rejection leaves no receipt or tombstone and the same ID can be corrected", async () => {
  const { host, create } = await fixture(); const session = await create()
  const command = { commandId: "actor-request", surfaceId: "pane", expectedEpoch: session.epoch, kind: "create_actor" as const,
    payload: { profileId: "ai-coding", modelRef: "missing-model-reference" } }
  await expect(host.command(caller, session, command)).rejects.toMatchObject({ status: 400, error: { code: "invalid_model_ref" } })
  await expect(host.commandStatus(caller, session, { commandId: command.commandId, expectedEpoch: session.epoch })).rejects.toMatchObject({ status: 404, error: { code: "command_not_found" } })
  expect((await host.actors(caller, session)).actors).toHaveLength(1)
  expect((await host.command(caller, session, { ...command, payload: { profileId: "ai-coding", displayName: "Corrected" } })).status).toBe("accepted")
  await until(async () => (await host.commandStatus(caller, session, { commandId: command.commandId, expectedEpoch: session.epoch })).state === "applied")
  expect((await host.actors(caller, session)).actors).toHaveLength(2)
}, 30000)
test("actor directory exposes read-history-only actors without granting observe", async () => {
  let onlyHistory = false
  const { host, create } = await fixture({ currentGrantsVersion: () => "1", permits: (_principal, target) => !onlyHistory || target.kind !== "actor" || target.action === "read_history" })
  const session = await create(); const primary = (await host.actors(caller, session)).actors[0]; onlyHistory = true
  expect((await host.history(caller, { sessionId: session.sessionId, actorId: primary.actorId }, {})).messages).toEqual([])
  const directory = await host.actors(caller, session)
  expect(directory.actors.map(actor => actor.actorId)).toContain(primary.actorId)
  expect(directory.actors[0].allowedActions).toEqual(["read_history"])
}, 30000)
test("persisted actor directory restores exact member identities without activating an adapter or writer", async () => {
  const f = await fixture(); const session = await f.create()
  const before = (await f.host.actors(caller, session)).actors
  await f.host.close()
  let activations = 0
  __setLlmAdapterFactoryForTest(async () => { activations++; throw new Error("directory_must_not_activate") })
  const host = await createHost({ workDir: f.workDir, globalRoot: f.globalRoot,
    authorization: { permits: () => true, currentGrantsVersion: () => "1" } })
  cleanup.push(() => host.close())
  const directory = await host.actors(caller, session, { directoryOnly: true })
  expect(directory.actors.map(actor => [actor.actorId, actor.memberId, actor.executionKind])).toEqual(before.map(actor => [actor.actorId, actor.memberId, actor.executionKind]))
  expect(activations).toBe(0)
  expect(directory.actors.every(actor => !actor.capabilities.textInput && actor.allowedActions.every(action => ["observe", "read_history"].includes(action)))).toBe(true)
}, 30000)
test("a real persisted organization identity restores as read-only while ordinary sessions retain controls", async () => {
  const f = await fixture(); const session = await f.create()
  const ordinary = (await f.host.actors(caller, session)).actors[0]
  expect(ordinary.allowedActions).toContain("send_text"); expect(session.readOnly).toBe(false)
  await f.host.close()
  // Use the same production session assembly and snapshot writer as a TUI owner;
  // no alternate host factory or recovery hook is introduced for this fixture.
  let ready!: SessionRuntimeReady
  const assembly = await createSessionRuntimeAssembly({ sessionKey: session.sessionId,
    config: { workDir: f.workDir, globalRoot: f.globalRoot, profileId: "ai-coding", adapter: "openai", model: "gpt-4o-mini", mcp: false },
    onRuntimeReady(value) { ready = value } })
  expect(assembly).toBeTruthy()
  try {
    ready.actor.identity = { kind: "member", memberId: "restored-member", name: "Restored member", role: "worker", lane: "worker" } as any
    await ready.persistSnapshot()
  } finally { await assembly!.dispose() }
  const restoredHost = await createHost({ workDir: f.workDir, globalRoot: f.globalRoot,
    authorization: { permits: () => true, currentGrantsVersion: () => "1" }, runtimeConfig: { adapter: "openai", model: "gpt-4o-mini", mcp: false } })
  cleanup.push(() => restoredHost.close())
  const restored = (await restoredHost.sessions(caller, {})).sessions.find(item => item.sessionId === session.sessionId)!
  expect(restored.readOnly).toBe(true)
  const actor = (await restoredHost.actors(caller, restored)).actors.find(item => item.actorId === ordinary.actorId)!
  expect(actor.executionKind).toBe(ordinary.executionKind)
  expect(actor.allowedActions).toEqual(["observe", "read_history"])
  expect(actor.capabilities).toEqual({ textInput: false, cancelTurn: false, questionnaireAnswer: false })
  expect((await restoredHost.history(caller, { sessionId: restored.sessionId, actorId: actor.actorId }, {})).messages).toEqual([])
  await expect(restoredHost.command(caller, restored, { commandId: "readonly-create", surfaceId: "pane", expectedEpoch: restored.epoch,
    kind: "create_actor", payload: { profileId: "ai-coding" } })).rejects.toMatchObject({ status: 403, error: { code: "session_read_only" } })
  await expect(restoredHost.command(caller, restored, { commandId: "readonly-send", surfaceId: "pane", expectedEpoch: restored.epoch,
    kind: "send_text", payload: { actorId: actor.actorId, text: "must not execute" } })).rejects.toMatchObject({ status: 403 })
}, 30000)

test("grant version is revalidated after asynchronous session activation", async () => {
  let version = "1"; let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
  const { host, create } = await fixture({ currentGrantsVersion: () => version, permits: () => true }, async () => { entered(); await gate; return adapter() })
  const opening = create()
  try { await started; version = "2"; release(); await expect(opening).rejects.toMatchObject({ status: 403, error: { code: "forbidden" } }) }
  finally { release(); await opening.catch(() => {}); await host.close() }
}, 30000)
test("host close drains an opening assembly and rejects its late successful response", async () => {
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve })
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
  const { host, create } = await fixture(undefined, async () => { entered(); await gate; return adapter() })
  const opening = create()
  try {
    await started; const closing = host.close(); release()
    await expect(opening).rejects.toMatchObject({ status: 503, error: { code: "host_closed" } })
    await closing
    expect(() => host.capabilities(caller)).toThrow("host_closed")
  } finally { release(); await opening.catch(() => {}); await host.close() }
}, 30000)
test("observe-only receives subsequent committed events but cannot read prior snapshot or HTTP history", async () => {
  const observer: HostRequest = { principal: { principalId: "observer", grantsVersion: "1" }, requestId: "observer-request" }
  const { host, create } = await fixture({ currentGrantsVersion: () => "1", permits: (principal, target) => principal.principalId !== "observer" || target.kind !== "actor" || target.action === "observe" })
  const session = await create(); const actor = (await host.actors(caller, session)).actors[0]
  const send = async (id: string) => {
    await host.command(caller, session, { commandId: id, expectedEpoch: session.epoch, surfaceId: "pane", kind: "send_text", payload: { actorId: actor.actorId, text: id } })
    await until(async () => (await host.commandStatus(caller, session, { commandId: id, expectedEpoch: session.epoch })).associatedTurn?.state === "succeeded")
  }
  await send("before")
  const subscription = await host.subscribe(observer, session, { actors: [actor.actorId] }); const it = subscription.frames[Symbol.asyncIterator]()
  try {
    const initial = (await it.next()).value; expect(initial.kind).toBe("snapshot"); expect(initial.payload.histories).toEqual([])
    await expect(host.history(observer, { sessionId: session.sessionId, actorId: actor.actorId }, {})).rejects.toMatchObject({ status: 403 })
    await send("after")
    let found = false
    for (let index = 0; index < 30; index++) {
      const next = await Promise.race([it.next(), Bun.sleep(1000).then(() => { throw new Error("observation_timeout") })])
      if (next.done) break
      if (next.value.kind === "history.committed" && JSON.stringify(next.value.payload.message).includes("after")) { found = true; break }
    }
    expect(found).toBe(true)
  } finally { subscription.close() }
}, 30000)

test("real host distinguishes provider execution failure from an accepted delivery receipt", async () => {
  const f = await fixture(undefined, async () => ({ ...adapter(), async createStream() { throw new Error("controlled-provider-failure") } }))
  const session = await f.create(); const actor = (await f.host.actors(caller, session)).actors[0]
  const receipt = await f.host.command(caller, session, { commandId: "provider-fails", surfaceId: "pane", expectedEpoch: session.epoch, kind: "send_text", payload: { actorId: actor.actorId, text: "go" } })
  expect(receipt.status).toBe("accepted")
  await until(async () => (await f.host.commandStatus(caller, session, { commandId: "provider-fails", expectedEpoch: session.epoch })).associatedTurn?.state === "failed")
  const status = await f.host.commandStatus(caller, session, { commandId: "provider-fails", expectedEpoch: session.epoch })
  expect(status.state).toBe("applied"); expect(status.associatedTurn?.state).toBe("failed")
}, 30000)

test("real host checkpoint write failure remains distinct from successful turn execution", async () => {
  let enter!: () => void; const entered = new Promise<void>(resolve => { enter = resolve })
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
  const f = await fixture(undefined, async () => ({ ...adapter(), async createStream(options: any) {
    async function* stream() { enter(); await gate; yield { choices: [{ delta: { content: "completed despite checkpoint fault" } }] }; yield { choices: [{ delta: {}, finish_reason: "stop" }] } }
    return { stream: stream(), providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }) }
  } }))
  const session = await f.create(); const actor = (await f.host.actors(caller, session)).actors[0]
  const receipt = await f.host.command(caller, session, { commandId: "checkpoint-fails", surfaceId: "pane", expectedEpoch: session.epoch, kind: "send_text", payload: { actorId: actor.actorId, text: "go" } })
  expect(receipt.status).toBe("accepted"); await entered
  const directory = join(f.workDir, ".eidolon", "sessions", session.sessionId, "runtime_state")
  const manifest = join(directory, "manifest.json"), backup = `${manifest}.fixture-backup`
  await mkdir(directory, { recursive: true }); const hadManifest = existsSync(manifest)
  if (hadManifest) await rename(manifest, backup)
  await mkdir(manifest) // Deterministic EISDIR, even for a privileged test user.
  try {
    release()
    await until(async () => (await f.host.commandStatus(caller, session, { commandId: "checkpoint-fails", expectedEpoch: session.epoch })).associatedTurn?.state === "succeeded")
    let checkpoint: any
    await until(async () => {
      const subscription = await f.host.subscribe(caller, session, { actors: [actor.actorId] })
      try { checkpoint = (await subscription.frames[Symbol.asyncIterator]().next()).value.payload.checkpoint; return checkpoint.state === "failed" }
      finally { subscription.close() }
    })
    expect(checkpoint.error.code).toBe("checkpoint_failed")
    expect((await f.host.commandStatus(caller, session, { commandId: "checkpoint-fails", expectedEpoch: session.epoch })).associatedTurn?.state).toBe("succeeded")
    expect(JSON.stringify(await f.host.history(caller, { sessionId: session.sessionId, actorId: actor.actorId }, {}))).toContain("completed despite checkpoint fault")
  } finally { release(); await rm(manifest, { recursive: true, force: true }); if (hadManifest) await rename(backup, manifest) }
}, 30000)

test("real Questionnaire caller controls recover after disconnect while only C is displayed", async () => {
  let providerCalls = 0
  const f = await fixture(undefined, async () => ({ ...adapter(), async createStream(options: any) {
    const answered = ++providerCalls > 1
    async function* stream() {
      if (!answered) {
        yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "question-tool", type: "function", function: { name: "Questionnaire", arguments: JSON.stringify({ questionnaireId: "caller-question", title: "Caller question", suspendPolicy: "pause_all", questions: [{ id: "q", prompt: "Proceed?", type: "text", required: true }] }) } }] } }] }
        yield { choices: [{ delta: {}, finish_reason: "tool_calls" }] }
      } else { yield { choices: [{ delta: { content: "answered successfully" } }] }; yield { choices: [{ delta: {}, finish_reason: "stop" }] } }
    }
    return { stream: stream(), providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }) }
  } }))
  const session = await f.create(); const a = (await f.host.actors(caller, session)).actors[0]
  await f.host.command(caller, session, { commandId: "create-C", surfaceId: "pane", expectedEpoch: session.epoch, kind: "create_actor", payload: { profileId: "ai-coding", displayName: "C" } })
  await until(async () => (await f.host.commandStatus(caller, session, { commandId: "create-C", expectedEpoch: session.epoch })).state === "applied")
  const c = (await f.host.actors(caller, session)).actors.find(actor => actor.displayName === "C")!
  const first = await f.host.subscribe(caller, session, { actors: [c.actorId] })
  await first.frames[Symbol.asyncIterator]().next()
  const receipt = await f.host.command(caller, session, { commandId: "question-work", surfaceId: "pane", expectedEpoch: session.epoch, kind: "send_text", payload: { actorId: a.actorId, text: "private actor A input" } })
  expect(receipt.status).toBe("accepted")
  await until(async () => (await f.host.commandStatus(caller, session, { commandId: "question-work", expectedEpoch: session.epoch })).associatedTurn?.state === "waiting_input")
  first.close()
  const resumed = await f.host.subscribe(caller, session, { actors: [c.actorId] })
  let snapshot: any
  try { snapshot = (await resumed.frames[Symbol.asyncIterator]().next()).value.payload } finally { resumed.close() }
  expect(snapshot.callerControls.commandIds).toContain("question-work")
  expect(snapshot.callerControls.questionnaireIds).toContain("caller-question")
  const question = snapshot.questions.find((item: any) => item.questionnaireId === "caller-question")
  expect(question).toMatchObject({ actorId: a.actorId, state: "pending", canAnswer: true })
  expect(question.schema.questions[0].prompt).toContain("Proceed?")
  expect(snapshot.histories.every((history: any) => history.actorId === c.actorId)).toBe(true)
  expect(snapshot.pendingStreams.every((stream: any) => stream.actorId === c.actorId)).toBe(true)
  expect(JSON.stringify(snapshot)).not.toContain("private actor A input")
  const retireC={commandId:'retire-idle-C',kind:'archive_actor' as const,expectedServerInstanceId:f.host.capabilities(caller).serverInstanceId,
    expectedEpoch:session.epoch,expectedLifecycleRevision:0}
  // Even an idle, unrelated Actor cannot be retired while a real Questionnaire
  // waits elsewhere in the same Session. No answer or cancellation is implied.
  await expect(f.host.manageActor!(caller,{sessionId:session.sessionId,actorId:c.actorId},retireC)).rejects.toMatchObject({status:409,error:{code:'session_busy'}})
  await expect(f.host.manageActor!(caller,{sessionId:session.sessionId,actorId:c.actorId},{...retireC,commandId:'delete-idle-C',kind:'delete_actor'})).rejects.toMatchObject({status:409,error:{code:'session_busy'}})
  expect((await f.host.actors(caller,session)).actors.find(actor=>actor.actorId===c.actorId)!.lifecycle?.state).toBe('active')
  await f.host.command(caller, session, { commandId: "answer-A", surfaceId: "pane", expectedEpoch: session.epoch, kind: "answer_question", payload: { actorId: a.actorId, turnId: question.turnId, questionnaireId: question.questionnaireId, responseText: "Q1: yes" } })
  await until(async () => (await f.host.commandStatus(caller, session, { commandId: "question-work", expectedEpoch: session.epoch })).associatedTurn?.state === "succeeded")
  expect((await f.host.commandStatus(caller, session, { commandId: "answer-A", expectedEpoch: session.epoch })).state).toBe("applied")
  expect(providerCalls).toBe(2)
  expect(JSON.stringify(await f.host.history(caller, { sessionId: session.sessionId, actorId: a.actorId }, {}))).toContain("answered successfully")
  await until(async()=>!await f.host.isBusy!())
  expect((await f.host.manageActor!(caller,{sessionId:session.sessionId,actorId:c.actorId},retireC)).lifecycle.state).toBe('archived')
}, 30000)

test('real detached delegate blocks idle Actor retirement after its foreground caller finishes, without cancelling or replaying work',async()=>{
  let release!:()=>void,childEntered=false,calls=0,childCalls=0,delegated=false;
  const gate=new Promise<void>(resolve=>{release=resolve});
  const f=await fixture(undefined,async()=>({...adapter(),async createStream(options:any){
    calls++;
    const child=options.messages.some((message:any)=>message.role==='user'&&projectInputContentText(message.content).includes('P3_DETACHED_CHILD'));
    const completedTool=options.messages.some((message:any)=>message.role==='tool');
    async function* stream(){
      if(child){childCalls++;childEntered=true;await gate;yield {choices:[{delta:{content:'P3_DETACHED_COMPLETE'}}]};}
      else if(!completedTool&&!delegated){
        delegated=true;
        yield {choices:[{delta:{tool_calls:[{index:0,id:'p3-detached',type:'function',function:{name:'RunDelegateActor',arguments:JSON.stringify({description:'P3 background barrier',prompt:'P3_DETACHED_CHILD',agent_type:'code',mode:'detached'})}}]}}]};
        yield {choices:[{delta:{},finish_reason:'tool_calls'}]};return;
      }else yield {choices:[{delta:{content:'P3_FOREGROUND_COMPLETE'}}]};
      yield {choices:[{delta:{},finish_reason:'stop'}]};
    }
    return {stream:stream(),providerOutput:Promise.resolve({provider_cache_cost_observation:createMockProviderCacheCostObservation(options)})};
  }}));
  try{
    const session=await f.create(),primary=(await f.host.actors(caller,session)).actors[0]!;
    await f.host.command(caller,session,{commandId:'background-idle',surfaceId:'pane',expectedEpoch:session.epoch,kind:'create_actor',payload:{profileId:'ai-coding',displayName:'Idle background witness'}});
    await until(async()=>(await f.host.commandStatus(caller,session,{commandId:'background-idle',expectedEpoch:session.epoch})).state==='applied');
    const idle=(await f.host.actors(caller,session)).actors.find(actor=>actor.displayName==='Idle background witness')!;
    await f.host.command(caller,session,{commandId:'background-parent',surfaceId:'pane',expectedEpoch:session.epoch,kind:'send_text',payload:{actorId:primary.actorId,text:'P3 start controlled detached work'}});
    await until(async()=>childEntered);
    await until(async()=>(await f.host.commandStatus(caller,session,{commandId:'background-parent',expectedEpoch:session.epoch})).associatedTurn?.state==='succeeded');
    const background=(await f.host.actors(caller,session)).actors.find(actor=>['detached','delegate'].includes(actor.executionKind));
    expect(background).toBeDefined();expect(background!.runtimeState).toBe('running');
    const archive={commandId:'background-archive',kind:'archive_actor' as const,expectedServerInstanceId:f.host.capabilities(caller).serverInstanceId,expectedEpoch:session.epoch,expectedLifecycleRevision:0};
    for(const kind of ['archive_actor','delete_actor'] as const)
      await expect(f.host.manageActor!(caller,{sessionId:session.sessionId,actorId:idle.actorId},{...archive,kind})).rejects.toMatchObject({status:409,error:{code:'session_busy'}});
    expect((await f.host.actors(caller,session)).actors.find(actor=>actor.actorId===idle.actorId)!.lifecycle?.state).toBe('active');
    release();
    // A child completion notification may wake the original caller once. Its
    // scheduling is not a retirement effect or a second child execution.
    await until(async()=>!await f.host.isBusy!()
      &&JSON.stringify(await f.host.history(caller,{sessionId:session.sessionId,actorId:background!.actorId},{})).includes('P3_DETACHED_COMPLETE'));
    expect((await f.host.manageActor!(caller,{sessionId:session.sessionId,actorId:idle.actorId},archive)).lifecycle.state).toBe('archived');
    expect(JSON.stringify(await f.host.history(caller,{sessionId:session.sessionId,actorId:primary.actorId},{}))).toContain('P3_FOREGROUND_COMPLETE');
    await f.host.close();
    expect(childCalls).toBe(1);expect(calls).toBeGreaterThanOrEqual(3);expect(calls).toBeLessThanOrEqual(4);
  }finally{release();}
},30000);

test("host history adapter binds emitted content refs to the delivered owner fence during reentrant publication", () => {
  const actor = createActor({ key: "main" }); const vm = createVM({ controlActorKey: actor.key, actors: { main: actor }, outerCtx: { metadata: { sessionId: "internal-session" } } })
  const owner = ensureVmConversationDomainRuntime(vm)
  const append = (messageId: string) => appendLiveHistoryMessageToConversationDomainRuntime({ vm, actorKey: actor.key, actorId: actor.id, message: { role: "assistant", messageId, content: messageId } })
  const earlier = owner.historyStateSignal.subscribe(() => { earlier.unsubscribe(); append("second") })
  const refs: { messageId: string; historyRevision: string }[] = []; let id = 0
  const reader = createPublicHistoryReader({ vm, sessionId: "public-session", epoch: "epoch", authorization: { permits: () => true, currentGrantsVersion: () => "1" }, identity: { newId: () => String(++id), now: () => 0 },
    onCommitted: payload => refs.push(payload.message.contentRef!), onError: error => { throw error },
  })
  try {
    append("first")
    expect(refs.map(ref => ref.messageId)).toEqual(["first", "second"])
    const chunk = reader.content(caller, actor.id, refs[0])
    expect(JSON.parse(Buffer.from(chunk.data, "base64").toString()).parts[0].text).toBe("first")
  } finally { earlier.unsubscribe(); reader.close() }
})
