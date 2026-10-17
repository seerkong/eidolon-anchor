import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm, rename } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installBundledSystemSkills } from "@cell/ai-support/system-skill/SystemSkillInstaller"
import { LocalFileConversationPersistenceRepositoryFactory } from "@cell/ai-support"
import { readRuntimeControlEffectEvidence } from "../../../../cell/packages/ai-file-store-logic/src"
import { createMockProviderCacheCostObservation } from "../../../../cell/packages/ai-organ-logic/tests/AIAgent/__test_support__/mockProcessStream"
import { __setLlmAdapterFactoryForTest } from "../../../../cell/packages/ai-runtime-host-capsule/src/session/SessionRuntimeAssembly"
import { createHost } from "../../../../cell/packages/ai-runtime-host-capsule/src/host"
import { parseActorDirectory, parseCommandEnvelope, parseCommandStatus, parseObservationFrame, type HostRequest, type CommandEnvelope, type QuestionRecord } from "../../../../cell/packages/ai-runtime-host-contract/src"

afterEach(() => __setLlmAdapterFactoryForTest(null))
const request: HostRequest = { principal: { principalId: "private-owner", grantsVersion: "private-grant" }, requestId: "goal-test" }
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "anchor-web-goal-")), workDir = join(root, "work"), globalRoot = join(root, "global")
  await mkdir(join(workDir, ".eidolon"), { recursive: true })
  await writeFile(join(workDir, ".eidolon/llm-provider.json"), JSON.stringify({ providers: [{ id: "one", adapter: "openai", options: { apiKey: "test" }, models: [{ id: "a", limits: { context: 8000, output: 1024 } }] }] }))
  await writeFile(join(workDir, ".eidolon/agent-present.json"), JSON.stringify({ defaultPreset: "test", presets: { test: { primary: { model: "one/a" } } } }))
  await installBundledSystemSkills({ globalRoot })
  return { root, workDir, globalRoot }
}
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 12000
  while (true) { const value = await read(); if (done(value)) return value; if (Date.now() > end) throw new Error(`goal_timeout:${JSON.stringify(value)}`); await Bun.sleep(5) }
}

test("goal wire contracts reject private activation, stale semantics and non-primary projections", () => {
  const command = { commandId: "c", surfaceId: "s", expectedEpoch: "e", kind: "set_goal", payload: { actorId: "a", expectedGoalId: null, operation: "set", objective: "exact objective", tokenBudget: 100 } } as const
  expect(parseCommandEnvelope(command)).toEqual(command)
  for (const payload of [{ ...command.payload, objective: " " }, { ...command.payload, tokenBudget: 1.2 }, { ...command.payload, tokenBudget: 0 },
    { ...command.payload, activation: {} }, { ...command.payload, expectedGoalId: undefined }, { ...command.payload, operation: "pause" }, { ...command.payload, objective: "字".repeat(6000) }]) expect(() => parseCommandEnvelope({ ...command, payload })).toThrow()
  const actor = { actorId: "a", displayName: "Primary", executionKind: "primary", runtimeState: "idle", allowedActions: ["observe", "set_goal", "continue_goal"], capabilities: { textInput: true, cancelTurn: true, questionnaireAnswer: true },
    threadGoal: { scope: "session", controlActorId: "a", accounting: "session_estimate", record: null, resumeRequired: false } } as const
  expect(parseActorDirectory({ epoch: "e", actors: [actor] }).actors[0]).toEqual(actor)
  for (const invalid of [{ ...actor, executionKind: "interactive" }, { ...actor, threadGoal: { ...actor.threadGoal, controlActorId: "other" } }, { ...actor, threadGoal: { ...actor.threadGoal, activation: {} } }]) {
    expect(() => parseActorDirectory({ epoch: "e", actors: [invalid] })).toThrow()
    expect(() => parseObservationFrame({ kind: "actor.updated", epoch: "e", seq: 1, cursor: "c", payload: invalid })).toThrow()
  }
  for (const associatedTurn of [{ actorId: "a", turnId: "t", state: "running", canCancel: true, pendingQuestionIds: [], source: "goal" }, { actorId: "a", turnId: "t", state: "running", canCancel: true, pendingQuestionIds: [], goalId: "g" }]) {
    expect(() => parseCommandStatus({ commandId: "c", epoch: "e", state: "applied", associatedTurn })).toThrow()
    expect(() => parseObservationFrame({ kind: "turn.updated", epoch: "e", seq: 1, cursor: "c", payload: associatedTurn })).toThrow()
  }
  for (const goal of [{ cleared: false }, { cleared: true, goalId: "g" }, { cleared: true, status: "active" }]) expect(() => parseCommandStatus({ commandId: "c", epoch: "e", state: "applied", result: { goal } })).toThrow()
})

test("real Host goal continues through two tracked Web turns and model audit completes the original owner", async () => {
  const { root, workDir, globalRoot } = await fixture()
  let calls = 0
  const inputs: string[] = []
  __setLlmAdapterFactoryForTest(async () => ({ type: "openai", runtime: { adapterName: "openai", providerId: "one" }, async createStream(options: any) {
    const call = ++calls; inputs.push(JSON.stringify(options.messages))
    if (call > 3) throw new Error("unexpected_extra_goal_turn")
    return { stream: (async function* () {
      if (call === 2) {
        yield { choices: [{ delta: { tool_calls: [{ index: 0, id: "goal-complete", type: "function", function: { name: "update_goal", arguments: JSON.stringify({ status: "complete", reason: "two continuation turns were observed and the objective was verified" }) } }] } }] }
        yield { choices: [{ delta: {}, finish_reason: "tool_calls" }] }
      } else {
        yield { choices: [{ delta: { content: call === 1 ? "first step complete; continue" : "objective verified" } }] }
        yield { choices: [{ delta: {}, finish_reason: "stop" }] }
      }
    })(), providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }) }
  } }))
  const config = { workDir, globalRoot, runtimeConfig: { model: "one/a", mcp: false }, authorization: { currentGrantsVersion: () => request.principal.grantsVersion, permits: () => true } }
  let host = await createHost(config)
  try {
    let session = await host.createSession(request, { commandId: "session", expectedServerInstanceId: host.capabilities(request).serverInstanceId, profileId: "ai-coding" })
    const primary = (await host.actors(request, session)).actors[0]!
    expect(primary.threadGoal).toMatchObject({ scope: "session", record: null, controlActorId: primary.actorId })
    const subscription = await host.subscribe(request, session, { actors: [primary.actorId] })
    const observed: any[] = []
    const read = (async () => { for await (const frame of subscription.frames) { parseObservationFrame(frame); observed.push(frame) } })()
    const command: CommandEnvelope = { kind: "set_goal", commandId: "explicit-goal", expectedEpoch: session.epoch, surfaceId: "web", payload: { actorId: primary.actorId, expectedGoalId: null, operation: "set", objective: "perform two tracked steps and audit completion", tokenBudget: 100000 } }
    const receipt = await host.command(request, session, command)
    expect(receipt).not.toHaveProperty("turnId")
    expect(await host.command(request, session, command)).toEqual(receipt)
    const applied = await until(() => host.commandStatus(request, session, { commandId: command.commandId, expectedEpoch: session.epoch }), value => value.state !== "accepted")
    expect(applied).toMatchObject({ state: "applied", result: { goal: { cleared: false, status: "active" } } })
    const final = await until(() => host.actors(request, session), value => value.actors[0]?.threadGoal?.record?.status === "complete")
    expect(final.actors[0]!.threadGoal!.record).toMatchObject({ objective: "perform two tracked steps and audit completion", tokenBudget: 100000, completionAudit: "two continuation turns were observed and the objective was verified" })
    await until(async () => observed.filter(frame => frame.kind === "turn.updated" && frame.payload.source === "goal" && frame.payload.state === "succeeded"), turns => new Set(turns.map(turn => turn.payload.turnId)).size === 2)
    expect(calls).toBe(3)
    const sessionDir = join(workDir, '.eidolon/sessions', session.sessionId)
    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)
    const generations = await Promise.all((await repository.listHistoryGenerationIds()).map(id => repository.loadHistoryGeneration(id)))
    const messages = generations.flatMap(generation => generation?.messages ?? []).map(record => record.message)
    const turnIds = new Set(observed.filter(frame => frame.kind === 'turn.updated' && frame.payload.source === 'goal').map(frame => frame.payload.turnId))
    const origins = messages.filter(message => message.executionOrigin?.source === 'web').map(message => message.executionOrigin!)
    expect(new Set(origins.map(origin => origin.turnId))).toEqual(turnIds)
    for (const origin of origins) expect(origin).toMatchObject({ sessionId: session.sessionId, actorId: primary.actorId, epoch: session.epoch, principalId: request.principal.principalId })
    const effects = await readRuntimeControlEffectEvidence(sessionDir)
    const providerEffects = effects.filter(effect => effect.kind === 'request' && effect.effectKind === 'provider_completion')
    expect(new Set(providerEffects.map(effect => effect.executionOrigin?.turnId))).toEqual(turnIds)
    expect(providerEffects.every(effect => effect.originSchemaVersion === 1 && effect.executionOrigin?.source === 'web')).toBe(true)
    for (const input of inputs) { expect(input).not.toContain("private-owner"); expect(input).not.toContain("private-grant"); expect(input).not.toContain("explicit-goal") }
    expect(JSON.stringify(final)).not.toContain("activation")
    const goalId = final.actors[0]!.threadGoal!.record!.goalId
    await expect(host.command(request, session, { ...command, commandId: "stale", payload: { actorId: primary.actorId, expectedGoalId: "old", operation: "clear" } })).rejects.toMatchObject({ error: { code: "goal_changed" } })
    await expect(host.command(request, session, { kind: "continue_goal", commandId: "terminal", surfaceId: "web", expectedEpoch: session.epoch, payload: { actorId: primary.actorId, goalId } })).rejects.toMatchObject({ error: { code: "goal_not_active" } })
    subscription.close(); await read
    await host.close(); host = await createHost(config)
    const reopened = await host.actors(request, session); session = { ...session, epoch: reopened.epoch }
    expect(reopened.actors[0]!.threadGoal!.record).toMatchObject({ goalId, status: "complete", tokenBudget: 100000 })
    expect(calls).toBe(3)
  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
}, 30000)

test("goal turns share questionnaire ownership, answer and cancel; restart waits for an explicit new activation", async () => {
  const { root, workDir, globalRoot } = await fixture()
  let calls = 0, parserCalls = 0, finish = false
  __setLlmAdapterFactoryForTest(async () => ({ type: "openai", runtime: { adapterName: "openai", providerId: "one" }, async createStream(options: any) {
    if (JSON.stringify(options.messages).includes("QUESTIONNAIRE_ANSWER_PARSER_V2")) {
      parserCalls++
      return { stream: (async function* () { yield { choices: [{ delta: { content: JSON.stringify({ status: "ok", answers: { q: "proceed" }, errors: [] }) } }] }; yield { choices: [{ delta: {}, finish_reason: "stop" }] } })() }
    }
    const call = ++calls
    if (call > 5) throw new Error("unexpected_goal_replay")
    return { stream: (async function* () {
      const tool = finish && call === 4 ? { name: "update_goal", arguments: { status: "complete", reason: "resume was explicit and the exact goal was verified" } }
        : call === 1 || call === 3 ? { name: "Questionnaire", arguments: { questionnaireId: `goal-question-${call}`, title: "Goal decision", suspendPolicy: "pause_all", questions: [{ id: "q", prompt: "Proceed?", type: "text", required: true }] } } : undefined
      if (tool) {
        yield { choices: [{ delta: { tool_calls: [{ index: 0, id: `tool-${call}`, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } }] } }] }
        yield { choices: [{ delta: {}, finish_reason: "tool_calls" }] }
      } else {
        yield { choices: [{ delta: { content: "step settled" } }] }; yield { choices: [{ delta: {}, finish_reason: "stop" }] }
      }
    })(), providerOutput: Promise.resolve({ provider_cache_cost_observation: createMockProviderCacheCostObservation(options) }) }
  } }))
  const config = { workDir, globalRoot, runtimeConfig: { model: "one/a", mcp: false }, authorization: { currentGrantsVersion: () => request.principal.grantsVersion, permits: () => true } }
  let host = await createHost(config)
  const subscriptions: Awaited<ReturnType<typeof host.subscribe>>[] = []
  try {
    let session = await host.createSession(request, { commandId: "session", expectedServerInstanceId: host.capabilities(request).serverInstanceId, profileId: "ai-coding" })
    const primary = (await host.actors(request, session)).actors[0]!
    const control = (id: string, payload: Extract<CommandEnvelope, { kind: "set_goal" }>["payload"]) => host.command(request, session, { kind: "set_goal", commandId: id, surfaceId: "web", expectedEpoch: session.epoch, payload })
    const observed: any[][] = [[], []]
    for (let i = 0; i < 2; i++) {
      const subscription = await host.subscribe(request, session, { actors: [primary.actorId] }); subscriptions.push(subscription)
      void (async () => { for await (const frame of subscription.frames) { parseObservationFrame(frame); observed[i]!.push(frame) } })()
    }
    await control("start", { actorId: primary.actorId, expectedGoalId: null, operation: "set", objective: "answer one decision and cancel the next without replay" })
    const first = await until(async () => observed[0]!.find(frame => frame.kind === "question.updated" && frame.payload.state === "pending")?.payload, Boolean) as QuestionRecord
    const goalId = (await host.actors(request, session)).actors[0]!.threadGoal!.record!.goalId
    const firstTurn = observed[0]!.find(frame => frame.kind === "turn.updated" && frame.payload.turnId === first.turnId)!.payload
    expect(firstTurn).toMatchObject({ source: "goal", goalId })
    await expect(control("busy-edit", { actorId: primary.actorId, expectedGoalId: goalId, operation: "edit", objective: "must not replace while waiting" })).rejects.toMatchObject({ error: { code: "session_busy" } })
    await host.command(request, session, { kind: "answer_question", commandId: "answer", surfaceId: "web", expectedEpoch: session.epoch, payload: { actorId: primary.actorId, turnId: first.turnId, questionnaireId: first.questionnaireId, responseText: "proceed" } })
    const second = await until(async () => observed[0]!.find(frame => frame.kind === "question.updated" && frame.payload.state === "pending" && frame.payload.questionnaireId !== first.questionnaireId)?.payload, Boolean) as QuestionRecord
    expect(second.turnId).not.toBe(first.turnId)
    await host.command(request, session, { kind: "cancel_turn", commandId: "cancel", surfaceId: "web", expectedEpoch: session.epoch, payload: { actorId: primary.actorId, turnId: second.turnId } })
    await until(async () => observed[0]!.find(frame => frame.kind === "turn.updated" && frame.payload.turnId === second.turnId && frame.payload.state === "cancelled"), Boolean)
    for (const frames of observed) {
      expect(frames.some(frame => frame.kind === "question.updated" && frame.payload.questionnaireId === first.questionnaireId && frame.payload.state === "answered")).toBe(true)
      expect(frames.some(frame => frame.kind === "question.updated" && frame.payload.questionnaireId === second.questionnaireId && frame.payload.state === "cancelled")).toBe(true)
    }
    expect((await host.actors(request, session)).actors[0]!.threadGoal!.record).toMatchObject({ goalId, status: "paused", suspensionReason: "cancelled" })
    expect(calls).toBe(3)
    for (const subscription of subscriptions) subscription.close()
    await host.close(); host = await createHost(config)
    const reopened = await host.actors(request, session); session = { ...session, epoch: reopened.epoch }
    expect(reopened.actors[0]!.threadGoal).toMatchObject({ resumeRequired: true, record: { goalId, status: "paused" } })
    // Wait through multiple real idle-hook intervals, rather than infer no replay from a snapshot.
    await Bun.sleep(300); expect(calls).toBe(3)
    await expect(host.command(request, session, { kind: "answer_question", commandId: "old-answer", surfaceId: "web", expectedEpoch: session.epoch, payload: { actorId: primary.actorId, turnId: second.turnId, questionnaireId: second.questionnaireId, responseText: "stale" } })).rejects.toMatchObject({ status: 404, error: { code: "turn_not_found" } })
    finish = true
    await control("resume", { actorId: primary.actorId, expectedGoalId: goalId, operation: "resume" })
    await until(() => host.actors(request, session), value => value.actors[0]!.threadGoal!.record!.status === "complete" && value.actors[0]!.runtimeState === "idle" && calls === 5)
    expect(calls).toBe(5)
    expect(parserCalls).toBe(1)
  } finally { for (const subscription of subscriptions) subscription.close(); await host.close(); await rm(root, { recursive: true, force: true }) }
}, 30000)

test("revoked authorization pauses before continuation and interactive actors cannot control the session goal", async () => {
  const { root, workDir, globalRoot } = await fixture()
  let calls = 0, denyContinuation = false
  __setLlmAdapterFactoryForTest(async () => ({ type: "openai", runtime: { adapterName: "openai", providerId: "one" }, async createStream() { calls++; throw new Error("no model expected") } }))
  const host = await createHost({ workDir, globalRoot, runtimeConfig: { model: "one/a", mcp: false }, authorization: {
    currentGrantsVersion: () => request.principal.grantsVersion, permits: (_principal, target) => !denyContinuation || target.action !== "continue_goal",
  } })
  try {
    const session = await host.createSession(request, { commandId: "session", expectedServerInstanceId: host.capabilities(request).serverInstanceId, profileId: "ai-coding" })
    const primary = (await host.actors(request, session)).actors[0]!
    await host.command(request, session, { commandId: "create", surfaceId: "web", expectedEpoch: session.epoch, kind: "create_actor", payload: { profileId: "ai-coding" } })
    await until(() => host.commandStatus(request, session, { commandId: "create", expectedEpoch: session.epoch }), value => value.state !== "accepted")
    const interactive = (await host.actors(request, session)).actors.find(actor => actor.actorId !== primary.actorId)!
    expect(interactive).not.toHaveProperty("threadGoal"); expect(interactive.allowedActions).not.toContain("set_goal")
    const command: CommandEnvelope = { commandId: "set", surfaceId: "web", expectedEpoch: session.epoch, kind: "set_goal", payload: { actorId: primary.actorId, expectedGoalId: null, operation: "set", objective: "must wait for permission" } }
    await expect(host.command(request, session, { ...command, commandId: "wrong-actor", payload: { ...command.payload, actorId: interactive.actorId } })).rejects.toMatchObject({ status: 403 })
    await expect(host.command(request, session, { ...command, commandId: "wrong-epoch", expectedEpoch: "old" })).rejects.toMatchObject({ status: 409 })
    await host.command(request, session, command)
    await until(() => host.commandStatus(request, session, { commandId: "set", expectedEpoch: session.epoch }), value => value.state !== "accepted")
    denyContinuation = true
    const final = await until(() => host.actors(request, session), value => value.actors[0]!.threadGoal!.record?.status === "paused")
    expect(final.actors[0]!.threadGoal!.record).toMatchObject({ suspensionReason: "authorization_revoked" })
    expect(calls).toBe(0)
    const goalId = final.actors[0]!.threadGoal!.record!.goalId
    await expect(host.command(request, session, { ...command, commandId: "forbidden-resume", payload: { actorId: primary.actorId, expectedGoalId: goalId, operation: "resume" } })).rejects.toMatchObject({ status: 403 })
    expect((await host.actors(request, session)).actors[0]!.threadGoal!.record!.status).toBe("paused")
  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
}, 30000)

test("a real checkpoint filesystem failure reports unknown and cannot authorize a goal turn", async () => {
  const { root, workDir, globalRoot } = await fixture()
  let calls = 0
  __setLlmAdapterFactoryForTest(async () => ({ type: "openai", runtime: { adapterName: "openai", providerId: "one" }, async createStream() { calls++; throw new Error("unsaved_goal_must_not_execute") } }))
  const config = { workDir, globalRoot, runtimeConfig: { model: "one/a", mcp: false }, authorization: { currentGrantsVersion: () => request.principal.grantsVersion, permits: () => true } }
  let host = await createHost(config)
  let snapshotPath: string | undefined, hadSnapshot = false
  try {
    let session = await host.createSession(request, { commandId: "session", expectedServerInstanceId: host.capabilities(request).serverInstanceId, profileId: "ai-coding" })
    const primary = (await host.actors(request, session)).actors[0]!
    snapshotPath = join(workDir, ".eidolon/sessions", session.sessionId, "runtime_state")
    try { await rename(snapshotPath, snapshotPath + ".test-backup"); hadSnapshot = true } catch (error: any) { if (error.code !== "ENOENT") throw error }
    await writeFile(snapshotPath, "isolated checkpoint fault")
    const subscription = await host.subscribe(request, session, { actors: [primary.actorId] })
    const frames: any[] = []
    const read = (async () => { for await (const frame of subscription.frames) frames.push(frame) })()
    const command: CommandEnvelope = { kind: "set_goal", commandId: "unsaved", surfaceId: "web", expectedEpoch: session.epoch, payload: { actorId: primary.actorId, expectedGoalId: null, operation: "set", objective: "persist before executing" } }
    const receipt = await host.command(request, session, command)
    const status = await until(() => host.commandStatus(request, session, { commandId: "unsaved", expectedEpoch: session.epoch }), value => value.state !== "accepted")
    expect(status).toMatchObject({ state: "unknown", error: { code: "goal_checkpoint_failed", state: "unknown" }, result: { goal: { status: "paused", cleared: false } } })
    expect(await host.command(request, session, command)).toEqual(receipt)
    expect((await host.actors(request, session)).actors[0]!.threadGoal).toMatchObject({ resumeRequired: true, record: { status: "paused", suspensionReason: "checkpoint_failed" } })
    await until(async () => frames.find(frame => frame.kind === "checkpoint.updated" && frame.payload.state === "failed"), Boolean)
    await Bun.sleep(250); expect(calls).toBe(0)
    subscription.close(); await read
    await rm(snapshotPath, { force: true })
    if (hadSnapshot) await rename(snapshotPath + ".test-backup", snapshotPath)
    snapshotPath = undefined
    await host.close(); host = await createHost(config)
    const reopened = await host.actors(request, session); session = { ...session, epoch: reopened.epoch }
    expect(reopened.actors[0]!.threadGoal!.record).toMatchObject({ status: "paused", objective: "persist before executing" })
    await Bun.sleep(250); expect(calls).toBe(0)
  } finally {
    if (snapshotPath) { await rm(snapshotPath, { force: true }); if (hadSnapshot) await rename(snapshotPath + ".test-backup", snapshotPath) }
    await host.close(); await rm(root, { recursive: true, force: true })
  }
}, 30000)
