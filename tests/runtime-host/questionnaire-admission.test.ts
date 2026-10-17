import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { createVM, ensureVmSessionState } from "@cell/ai-core-logic/runtime/runtime"
import { createActorSurfaceFacade } from "@cell/ai-core-logic/runtime/ActorSurface"
import { cancelQuestionnaireRow } from "@cell/ai-core-logic/runtime/QuestionnaireRows"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { aiAgentCooperativeStep, aiAgentLoopStreaming } from "@cell/ai-organ-logic/exec/AiAgentExecutor"
import { createAiAgentOrchestratorDriver } from "@cell/ai-organ-logic/OrchestratorDriver"
import { authorizeLocalToolCall } from "../../cell/packages/ai-organ-logic/src/permissions/LocalPermissionRuntime"
import { configureLocalPermissionConfigStore } from "../../cell/packages/ai-organ-logic/src/permissions/LocalPermissionConfig"
import { LocalFilePermissionConfigStore } from "@cell/ai-support"
import { questionnaireCoreLogic } from "../../cell/packages/ai-organ-logic/src/composer/AIAgent/tools/Questionnaire/Logic"
import { createQuestionnaireHostEffects } from "../../cell/packages/ai-runtime-host-capsule/src/questionnaireHost"
import {
  admitHostCommand, createCommandIndex, createObservationState, publishObservation,
  releaseHostQuestion, preflightObservation, type CommandRuntime, type CommandLimits, type ObservationRuntime,
} from "../../cell/packages/ai-runtime-host-logic/src"
import { createObservationCursorEffects, createObservationQueueEffects } from "../../cell/packages/ai-runtime-host-support/src"
import type { ActorSummary, CommandReceipt, HostRequest } from "../../cell/packages/ai-runtime-host-contract/src"

function fixture(limits?: CommandLimits, observationLimits?: ObservationRuntime["limits"]) {
  const a = createActor({ key: "A" }), b = createActor({ key: "B" })
  const vm = createVM({ controlActorKey: a.key, actors: { A: a, B: b }, registries: { toolRegistry: new ToolFuncRegistry() } })
  const jobs: (() => Promise<void>)[] = []
  let sequence = 0, permits = true
  const authorization = { permits: () => permits, currentGrantsVersion: () => "1" }
  const identity = { newId: () => `turn-${++sequence}`, now: () => 0 }
  const request: HostRequest = { principal: { principalId: "owner", grantsVersion: "1" }, requestId: "r" }
  const summary = (actorId: string): ActorSummary => ({ actorId, displayName: actorId, executionKind: "interactive", runtimeState: "idle", allowedActions: ["observe", "send_text", "answer_question", "cancel_turn"], capabilities: { textInput: true, cancelTurn: true, questionnaireAnswer: true } })
  const observations: ObservationRuntime = { sessionId: "s", epoch: "e", state: createObservationState(), authorization, identity, cursors: createObservationCursorEffects(), queues: createObservationQueueEffects(), limits: observationLimits }
  for (const actor of [a, b]) publishObservation(observations, { kind: "actor.created", payload: summary(actor.id) })
  const surface = createActorSurfaceFacade(vm)
  const commands: CommandRuntime = { sessionId: "s", epoch: "e", index: createCommandIndex(), authorization, identity,
    effects: {
      digest: text => text, actor: actorId => [a.id, b.id].includes(actorId) ? summary(actorId) : undefined,
      preflight: () => {}, defer: job => jobs.push(job),
      execute: async command => {
        if (command.kind === "answer_question") {
          const result = surface.submitQuestionnaireResponse(command.payload.questionnaireId, command.payload.responseText)
          if (result.status !== "submitted") throw new Error(result.status)
        }
      },
      publishCommand: (principalId, payload) => publishObservation(observations, { kind: "command.updated", principalId, payload }),
    },
  }
  const turns = new Map<string, string>()
  for (const actor of [a, b]) {
    const receipt = admitHostCommand(commands, request, { commandId: `send-${actor.key}`, surfaceId: "test", expectedEpoch: "e", kind: "send_text", payload: { actorId: actor.id, text: "hello" } }) as CommandReceipt
    turns.set(actor.id, receipt.turnId!)
  }
  vm.effects.questionnaires = createQuestionnaireHostEffects({ commands, observations, limits,
    actorId: ({ id, key }) => vm.actors[key]?.id === id ? id : undefined,
    currentTurn: actorId => turns.has(actorId) ? { request, turnId: turns.get(actorId)! } : undefined,
  })
  const invoke = (actor = a, questionnaireId = `question-${actor.key}`, prompt = "Continue?") => questionnaireCoreLogic({ vm, actor, toolCallId: `tool-${actor.key}` } as any, {
    questionnaireId, suspendPolicy: "pause_all", questions: [{ id: "q", prompt, type: "single_select", choices: [{ value: "yes", label: "Yes" }, "no"] }],
  }, {})
  return { vm, a, b, request, commands, observations, invoke, turns, deny: () => { permits = false }, flush: async () => { for (const job of jobs.splice(0)) await job() } }
}

test("real Questionnaire tool rejects answer-capacity exhaustion before row/mailbox/publication mutation", async () => {
  const f = fixture({ receipts: 4, identities: 4, terminalTtlMs: 100 })
  const seq = f.observations.state.seq
  await expect(f.invoke()).rejects.toThrow("control_capacity")
  expect(f.a.pendingQuestionnaires).toEqual({})
  expect(f.a.mailboxes.control).toEqual([])
  expect(ensureVmSessionState(f.vm).questionnaires).toEqual({})
  expect(f.commands.index.questions.size).toBe(0)
  expect(f.commands.index.reserved).toBe(2)
  expect(f.observations.state.seq).toBe(seq)
})

test("schema and combined observation capacity are checked before any questionnaire owner write", async () => {
  const f = fixture()
  await expect(f.invoke(f.a, "oversize", "x".repeat(65537))).rejects.toThrow()
  expect(ensureVmSessionState(f.vm).questionnaires).toEqual({})
  expect(f.commands.index.reserved).toBe(2)
  const g = fixture(undefined, { schemaBytes: 10 })
  await expect(g.invoke()).rejects.toThrow("question_capacity")
  expect(g.a.mailboxes.control).toEqual([])
  expect(g.commands.index.questions.size).toBe(0)
})

test("questionnaire authorization refusal cannot leave a waiting actor", async () => {
  const f = fixture(); f.deny()
  await expect(f.invoke()).rejects.toThrow("question_forbidden")
  expect(f.a.pendingQuestionnaires).toEqual({})
  expect(f.a.mailboxes.control).toEqual([])
})

test("combined question/turn/command metadata reservation rejects before owner mutation", async () => {
  const f = fixture()
  const questionnaireId = "q".repeat(256)
  const publication = { kind: "question.updated" as const, payload: { actorId: f.a.id, turnId: f.turns.get(f.a.id)!, questionnaireId, state: "pending" as const, canAnswer: true } }
  let found = false
  for (let bytes = 1024; bytes < 8192; bytes += 16) {
    f.observations.limits = { metadataBytes: bytes }
    try { preflightObservation(f.observations, publication); found = true; break } catch {}
  }
  expect(found).toBe(true)
  const seq = f.observations.state.seq
  await expect(f.invoke(f.a, questionnaireId)).rejects.toThrow("snapshot_capacity")
  expect(f.a.pendingQuestionnaires).toEqual({})
  expect(f.commands.index.questions.size).toBe(0)
  expect(f.observations.state.seq).toBe(seq)
})

test("Web questionnaire waits only its actor; answer routing releases control schema and retains bounded display details", async () => {
  const f = fixture()
  await f.invoke(f.a); await f.invoke(f.b)
  expect(f.a.pendingQuestionnaires["question-A"].suspendPolicy).toBe("continue_others")
  expect(f.a.mailboxes.control[0]).toMatchObject({ kind: "questionnaire_pending", suspendPolicy: "continue_others" })
  const pending = f.commands.index.questions.get("question-A")!.record
  expect(pending.schema?.questions[0].options).toEqual([{ id: "yes", label: "Yes" }, { id: "no", label: "no" }])
  const base = { commandId: "answer-a", surfaceId: "test", expectedEpoch: "e", kind: "answer_question" as const }
  expect(() => admitHostCommand(f.commands, f.request, { ...base, payload: { actorId: f.b.id, turnId: f.turns.get(f.b.id)!, questionnaireId: "question-A", responseText: "yes" } })).toThrow("question_not_pending")
  expect(admitHostCommand(f.commands, f.request, { ...base, payload: { actorId: f.a.id, turnId: f.turns.get(f.a.id)!, questionnaireId: "question-A", responseText: "yes" } }).status).toBe("accepted")
  await f.flush()
  expect(f.a.mailboxes.toolResult).toHaveLength(1)
  expect(f.a.mailboxes.toolResult[0]).toMatchObject({ questionnaireId: "question-A", toolCallId: "tool-A", content: "yes" })
  expect(f.b.mailboxes.toolResult).toEqual([])
  expect(ensureVmSessionState(f.vm).questionnaires["question-A"].status).toBe("answered")
  expect(f.commands.index.questions.get("question-A")!.record).toMatchObject({ state: "answered", canAnswer: false })
  expect(f.commands.index.questions.get("question-A")!.record.schema).toBeUndefined()
  expect(f.observations.state.projection.questions.get("question-A")).toMatchObject({ state: "answered", canAnswer: false, schema: { questions: [{ id: "q", prompt: "Continue?" }] } })
  expect(f.commands.index.questions.get("question-B")!.answerReserved).toBe(true)
  expect(f.observations.state.projection.questions.has("question-A")).toBe(true)
  expect(f.observations.state.projection.questions.has("question-B")).toBe(true)
})

test("owner cancellation is actor-specific and repeated release cannot underflow reservation counts", async () => {
  const f = fixture(); await f.invoke(f.a); await f.invoke(f.b)
  expect(cancelQuestionnaireRow({ vm: f.vm, actor: f.b, questionnaireId: "question-A" })).toBeNull()
  expect(cancelQuestionnaireRow({ vm: f.vm, actor: f.a, questionnaireId: "question-A" })?.status).toBe("cancelled")
  expect(f.a.pendingQuestionnaires).toEqual({})
  expect(f.a.mailboxes.control).toEqual([])
  expect(f.b.pendingQuestionnaires["question-B"]).toBeDefined()
  expect(f.b.mailboxes.control).toHaveLength(1)
  expect(f.commands.index.questions.get("question-A")!.record.schema).toBeUndefined()
  expect(f.commands.index.reserved).toBe(3)
  const record = f.commands.index.questions.get("question-A")!.record
  releaseHostQuestion(f.commands, record); releaseHostQuestion(f.commands, record)
  expect(f.commands.index.reserved).toBe(3)
})

test("publication failure releases its reservation and rolls back the core pending row", async () => {
  const f = fixture()
  const original = f.vm.effects.questionnaires!
  f.vm.effects.questionnaires = { admit: input => { const lease = original.admit(input); return { ...lease, publish: () => { throw new Error("publication_failure") } } } }
  await expect(f.invoke()).rejects.toThrow("publication_failure")
  expect(f.a.pendingQuestionnaires).toEqual({})
  expect(ensureVmSessionState(f.vm).questionnaires).toEqual({})
  expect(f.a.mailboxes.control).toEqual([])
  expect(f.commands.index.questions.size).toBe(0)
  expect(f.commands.index.reserved).toBe(2)
})

test("without the optional Web effect the existing TUI pause policy is unchanged", async () => {
  const f = fixture(); delete f.vm.effects.questionnaires
  await f.invoke()
  expect(f.a.pendingQuestionnaires["question-A"].suspendPolicy).toBe("pause_all")
  expect(f.a.mailboxes.control[0]).toMatchObject({ suspendPolicy: "pause_all" })
})

test("local permission approval uses the same pre-admission owner boundary", () => {
  configureLocalPermissionConfigStore(LocalFilePermissionConfigStore)
  const root = mkdtempSync(path.join(tmpdir(), "host-question-permission-"))
  const workDir = path.join(root, "workspace"), authorityRoot = path.join(root, "authority")
  mkdirSync(workDir); mkdirSync(authorityRoot)
  writeFileSync(path.join(authorityRoot, "permissions.json"), JSON.stringify({ permission: { "*": "deny", read: { "secret.txt": "ask" } } }))
  try {
    for (const full of [true, false]) {
      const f = fixture(full ? { receipts: 4, identities: 4, terminalTtlMs: 100 } : undefined)
      f.vm.outerCtx = { ...f.vm.outerCtx, workDir, metadata: { local_permissions: { authority_root: authorityRoot } } }
      const result = authorizeLocalToolCall({ vm: f.vm, actor: f.a, toolCallId: "read-secret" }, "read", { filePath: "secret.txt" })
      expect(result.ok).toBe(false)
      if (full) {
        expect((result as { output: string }).output).toContain("control_capacity")
        expect(f.a.pendingQuestionnaires).toEqual({})
        expect(f.a.mailboxes.control).toEqual([])
        expect(ensureVmSessionState(f.vm).questionnaires).toEqual({})
      } else {
        expect(f.a.pendingQuestionnaires["local-permission-read-secret"].suspendPolicy).toBe("continue_others")
        expect(f.commands.index.questions.get("local-permission-read-secret")!.answerReserved).toBe(true)
        expect(f.observations.state.projection.questions.has("local-permission-read-secret")).toBe(true)
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

for (const mode of ["streaming", "cooperative"] as const) test(`${mode} invalid Web answer creates a newly reserved clarification identity that can be answered`, async () => {
  const f = fixture()
  let valid = false
  f.a.modelConfig = { model: "mock" }
  f.a.llmClient = { type: "openai", async createStream() { return { stream: (async function* () {
    yield { choices: [{ delta: { content: JSON.stringify(valid ? { status: "ok", answers: { q: "yes" }, errors: [] } : { status: "invalid", answers: {}, errors: ["Choose yes or no"] }) } }] }
  })() } } } as any
  f.a.callbacks = { ...f.a.callbacks, processStream: async () => ({ role: "assistant", content: "done" }) }
  await f.invoke()
  const answer = (id: string, questionnaireId: string) => admitHostCommand(f.commands, f.request, {
    commandId: id, surfaceId: "test", expectedEpoch: "e", kind: "answer_question",
    payload: { actorId: f.a.id, turnId: f.turns.get(f.a.id)!, questionnaireId, responseText: "unstructured response" },
  })
  answer("answer-one", "question-A"); await f.flush()
  let state: any
  const step = async () => {
    if (mode === "streaming") return aiAgentLoopStreaming({ vm: f.vm, actor: f.a, messages: [] })
    return aiAgentCooperativeStep({ fiberId: `${f.a.key}:${f.a.id}`, vm: f.vm, actor: f.a, messages: [], state, setState: next => { state = next }, resumeFiber: () => {} })
  }
  for (let n = 0; n < 50 && !Object.keys(f.a.pendingQuestionnaires).some(id => id !== "question-A"); n++) { await step(); await Bun.sleep(1) }
  const [clarificationId] = Object.keys(f.a.pendingQuestionnaires)
  expect(clarificationId).not.toBe("question-A")
  expect(clarificationId).toStartWith("q-")
  expect(f.a.pendingQuestionnaires[clarificationId]).toMatchObject({ kind: "clarification", suspendPolicy: "continue_others" })
  expect(f.commands.index.questions.get("question-A")!.record.state).toBe("answered")
  expect(f.commands.index.questions.get(clarificationId)!.answerReserved).toBe(true)
  expect(f.observations.state.projection.questions.has(clarificationId)).toBe(true)
  valid = true
  expect(answer("answer-two", clarificationId).status).toBe("accepted")
  await f.flush()
  expect(ensureVmSessionState(f.vm).questionnaires[clarificationId].status).toBe("answered")
  expect(f.commands.index.questions.get(clarificationId)!.record.schema).toBeUndefined()
  expect(f.b.mailboxes.toolResult).toEqual([])
})

test("real cooperative executor with the actual Questionnaire logic leaves the other actor runnable", async () => {
  const f = fixture()
  const registry = new ToolFuncRegistry()
  const tool = {
    schema: { type: "function" as const, function: { name: "Questionnaire", description: "Ask", parameters: { type: "object", properties: {} } } },
    briefPromptXnl: '<tool name="Questionnaire" />',
    run: async (runtime: any, input: any) => questionnaireCoreLogic(runtime, input, {}),
  }
  registry.register(tool as any)
  f.vm.registries.toolRegistry = registry
  f.a.llmClient = { type: "openai", async createStream() { return { stream: (async function* () { yield { ok: true } })() } } } as any
  f.a.modelConfig = { model: "mock" }
  f.a.callbacks = { ...f.a.callbacks, buildToolset: () => [tool.schema], processStream: async () => ({ role: "assistant", tool_calls: [{ id: "tc", function: { name: "Questionnaire", arguments: JSON.stringify({ questionnaireId: "q-driver", suspendPolicy: "pause_all", questions: [{ id: "q", prompt: "Proceed?", type: "text" }] }) } }] }) }
  const aFiber = `${f.a.key}:${f.a.id}`, bFiber = `${f.b.key}:${f.b.id}`
  let workerRan = false
  const driver = createAiAgentOrchestratorDriver({
    fibers: [{ fiberId: aFiber, vm: f.vm, actor: f.a, messages: [], basePriority: 1 }, { fiberId: bFiber, vm: f.vm, actor: f.b, messages: [], basePriority: 2 }],
    runStep: async (context, helpers) => {
      if (context.fiberId === bFiber) { workerRan = true; return { kind: "complete" } }
      return aiAgentCooperativeStep({
        fiberId: context.fiberId, vm: context.vm, actor: context.actor, messages: context.messages,
        state: context.execState, setState: state => { context.execState = state }, resumeFiber: helpers.resume,
      })
    },
    options: { agingStep: 0, defaultSuspendPolicy: "pause_all" },
  })
  f.a.send("humanInput", "start")
  for (let i = 0; i < 100; i++) {
    const a = driver.getState().fibers[aFiber]
    if (a.status === "suspended" && a.waitingReason === "human_answer") break
    driver.tick(Date.now())
    for (let j = 0; j < 10; j++) await Bun.sleep(0)
  }
  const state = driver.getState()
  expect(state.fibers[aFiber]).toMatchObject({ status: "suspended", waitingReason: "human_answer", suspendPolicy: "continue_others" })
  expect(workerRan).toBe(false)
  for (let i = 0; i < 10 && !workerRan; i++) { driver.tick(Date.now()); await Bun.sleep(1) }
  expect(workerRan).toBe(true)
})
