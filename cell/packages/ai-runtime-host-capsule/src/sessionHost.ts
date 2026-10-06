import { createHash } from "node:crypto"
import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor"
import { cancelQuestionnaireRow } from "@cell/ai-core-logic"
import { createInteractiveActor } from "@cell/ai-organ-logic/runtime/InteractiveActor"
import { ensureVmConversationDomainRuntime } from "@cell/ai-organ-logic/conversation/ConversationDomainRuntime"
import type { ActorSummary, HostAuthorizationEffects, HostIdentityEffects, HostRequest, HostResourceEffects, RuntimeHostPort, SessionSummary } from "@cell/ai-runtime-host-contract"
import {
  admitHostCommand, captureObservation, closeObservations, createCommandIndex, createObservationState,
  HostProtocolFailure, preflightObservation, prepareObservationCommand, publishObservation, readHostCommand, recordHostTurn,
  resetObservationHistory, seedObservationHistory, type CommandRuntime, type ObservationRuntime,
} from "@cell/ai-runtime-host-logic"
import { createObservationCursorEffects, createObservationQueueEffects, type StoredHostSession } from "@cell/ai-runtime-host-support"
import { createSessionRuntimeAssembly, type SessionRuntimeConfig, type SessionRuntimeReady } from "./session/SessionRuntimeAssembly"
import { createPublicHistoryReader } from "./publicHistory"
import { createQuestionnaireHostEffects } from "./questionnaireHost"
import { createSemanticObservation } from "./semanticObservation"
import { createHostActorLifecycle, hostActorExecutionKind } from "./actorLifecycle"

export type RuntimeSession = {
  summary: SessionSummary
  actors: (request: HostRequest) => Awaited<ReturnType<RuntimeHostPort["actors"]>>
  command: (request: HostRequest, input: Parameters<RuntimeHostPort["command"]>[2]) => Awaited<ReturnType<RuntimeHostPort["command"]>>
  commandStatus: (request: HostRequest, input: Parameters<RuntimeHostPort["commandStatus"]>[2]) => Awaited<ReturnType<RuntimeHostPort["commandStatus"]>>
  history: (request: HostRequest, actorId: string, input: Parameters<RuntimeHostPort["history"]>[2]) => Awaited<ReturnType<RuntimeHostPort["history"]>>
  content: (request: HostRequest, actorId: string, input: Parameters<RuntimeHostPort["content"]>[2]) => Awaited<ReturnType<RuntimeHostPort["content"]>>
  subscribe: (request: HostRequest, input: Parameters<RuntimeHostPort["subscribe"]>[2]) => Awaited<ReturnType<RuntimeHostPort["subscribe"]>>
  close: () => Promise<void>
}

export async function createRuntimeSession(options: {
  stored: StoredHostSession; epoch: string; workDir: string; globalRoot?: string
  config?: Omit<SessionRuntimeConfig, "workDir" | "globalRoot" | "profileId">
  authorization: HostAuthorizationEffects; identity: HostIdentityEffects; resources: HostResourceEffects
}): Promise<RuntimeSession> {
  const { sessionId } = options.stored
  let ready!: SessionRuntimeReady
  const bridge = await createSessionRuntimeAssembly({
    sessionKey: options.stored.storageKey,
    config: { ...options.config, workDir: options.workDir, globalRoot: options.globalRoot, profileId: options.stored.profileId },
    toolResources: options.resources,
    onRuntimeReady(runtime) { ready = runtime },
  })
  if (!bridge) throw new Error("runtime_unavailable")
  const cleanup: Array<() => void> = []
  try {
  const observations: ObservationRuntime = {
    sessionId, epoch: options.epoch, state: createObservationState(), authorization: options.authorization,
    identity: options.identity, cursors: createObservationCursorEffects(), queues: createObservationQueueEffects(),
  }
  const actorViews = new Map<string, ActorSummary>()
  const readOnly = Object.values(ready.vm.actors).some(actor => Boolean(actor.identity))
  const lifecycle = createHostActorLifecycle({ vm: ready.vm, observations, actorViews })
  ready.vm.effects.actorRegistration = { beforeRegister: lifecycle.beforeRegister }
  const tasks = new Set<Promise<void>>()
  const requests = new Map<string, HostRequest>()
  let closed = false
  let projectionFailed = false
  let closePromise: Promise<void> | undefined
  let persistence = Promise.resolve()
  const actorFor = (actorId: string) => Object.values(ready.vm.actors).find(actor => actor.id === actorId)
  const fiberFor = (actorId: string) => Object.entries(ready.driver.inspectRuntime().fibers).find(([, fiber]) => fiber.actor.id === actorId)?.[0]
  const actorSummary = (actor: AiAgentActor): ActorSummary => {
    const kind = hostActorExecutionKind(actor)
    const controllable = !readOnly && (kind === "primary" || kind === "interactive")
    const turn = ready.coordinator.readInteractiveTurns().find(t => t.actorId === actor.id && ["running", "waiting_input"].includes(t.state))
    return { actorId: actor.id, displayName: actor.agentName || (kind === "primary" ? "Primary" : actor.key), executionKind: kind,
      runtimeState: turn?.state === "waiting_input" ? "waiting_input" : turn ? "running" : "idle",
      allowedActions: controllable ? ["observe", "read_history", "send_text", "cancel_turn", "answer_question"] : ["observe", "read_history"],
      capabilities: { textInput: controllable, cancelTurn: controllable, questionnaireAnswer: controllable } }
  }
  const refreshActors = () => {
    lifecycle.reconcile()
    for (const actor of Object.values(ready.vm.actors)) {
      const view = actorSummary(actor)
      const old = actorViews.get(actor.id)
      if (JSON.stringify(old) === JSON.stringify(view)) continue
      publishObservation(observations, { kind: old ? "actor.updated" : "actor.created", payload: view })
      actorViews.set(actor.id, view)
    }
  }
  const save = () => {
    persistence = persistence.then(async () => {
      publishObservation(observations, { kind: "checkpoint.updated", payload: { state: "pending" } })
      try {
        await ready.persistSnapshot()
        publishObservation(observations, { kind: "checkpoint.updated", payload: { state: "saved" } })
      } catch {
        publishObservation(observations, { kind: "checkpoint.updated", payload: { state: "failed", error: { code: "checkpoint_failed", requestId: "checkpoint", retryable: false } } })
      }
    })
    return persistence
  }
  const fail = (request: HostRequest, status: number, code: string): never => {
    throw new HostProtocolFailure(status, { code, requestId: request.requestId, retryable: false })
  }
  const semantic = createSemanticObservation({ publish: publication => publishObservation(observations, publication) })
  cleanup.push(() => semantic.dispose())
  const observationFailed = () => { projectionFailed = true; closeObservations(observations) }
  const commands: CommandRuntime = {
    sessionId, epoch: options.epoch, index: createCommandIndex(), authorization: options.authorization, identity: options.identity,
    effects: {
      digest: value => createHash("sha256").update(value).digest("hex"),
      actor: id => actorViews.get(id),
      preflight(command, { request, status }) {
        if (closed) return fail(request, 409, "session_closing")
        if (readOnly) return fail(request, 403, "session_read_only")
        if (projectionFailed && (command.kind === "send_text" || command.kind === "create_actor")) return fail(request, 503, "observation_unavailable")
        if (command.kind !== "create_actor") return projectionFailed ? undefined : prepareObservationCommand(observations, command, request.principal.principalId, status)
        if (command.payload.profileId !== options.stored.profileId) return fail(request, 403, "profile_not_allowed")
        if (actorViews.size + [...commands.index.entries.values()].filter(e => e.status?.state === "accepted" && !e.status.turnId).length >= 64) return fail(request, 429, "actor_capacity")
        try { ready.resolveActorModelConfig(command.payload.modelRef) } catch { return fail(request, 400, "invalid_model_ref") }
        // Reserve the worst allowed actor record before committing a new owner identity.
        preflightObservation(observations, { kind: "actor.created", payload: { actorId: "preflight-actor", displayName: command.payload.displayName ?? "Interactive",
          executionKind: "interactive", runtimeState: "idle", allowedActions: ["observe", "read_history", "send_text", "cancel_turn", "answer_question"],
          capabilities: { textInput: true, cancelTurn: true, questionnaireAnswer: true } } })
        return prepareObservationCommand(observations, command, request.principal.principalId, status)
      },
      defer(run) {
        const task = Promise.resolve().then(run)
        tasks.add(task)
        void task.finally(() => tasks.delete(task)).catch(() => {})
      },
      publishCommand(principalId, status) { publishObservation(observations, { kind: "command.updated", payload: status, principalId }) },
      async execute(command, turnId, request) {
        if (closed) return fail(request, 409, "session_closing")
        if (readOnly) return fail(request, 403, "session_read_only")
        const requireAuthority = () => {
          const target = command.kind === "create_actor"
            ? { kind: "session" as const, sessionId, action: "create_actor" as const }
            : { kind: "actor" as const, sessionId, actorId: command.payload.actorId, action: command.kind }
          if (options.authorization.currentGrantsVersion(request.principal.principalId) !== request.principal.grantsVersion
            || !options.authorization.permits(request.principal, { kind: "session", sessionId, action: "open" })
            || !options.authorization.permits(request.principal, target)) return fail(request, 403, "forbidden")
        }
        requireAuthority()
        if (command.kind === "create_actor") {
          const { actor } = createInteractiveActor({ vm: ready.vm, driver: ready.driver, ...options.identity }, {
            displayName: command.payload.displayName, modelConfig: ready.resolveActorModelConfig(command.payload.modelRef),
            llmClient: ready.actor.llmClient, callbacks: ready.actor.callbacks, systemPrompts: [...ready.actor.systemPrompts],
            toolPolicy: ready.actor.toolPolicy, contextPolicy: ready.actor.contextPolicy,
          })
          ready.activateSessionMaterialization()
          refreshActors()
          await save()
          return { actorId: actor.id }
        }
        const actor = actorFor(command.payload.actorId)
        if (!actor || !turnId) return fail(request, 404, "actor_not_found")
        if (command.kind === "cancel_turn") {
          for (const question of commands.index.questions.values()) {
            if (question.record.actorId === actor.id && question.record.turnId === turnId && question.record.state === "pending") {
              cancelQuestionnaireRow({ vm: ready.vm, actor, questionnaireId: question.record.questionnaireId })
            }
          }
          const result = ready.coordinator.cancelInteractiveTurn({ actorId: actor.id, turnId })
          if (result.status === "not_found") return fail(request, 404, "turn_not_found")
          return
        }
        if (command.kind === "answer_question") {
          const question = commands.index.questions.get(command.payload.questionnaireId)?.record
          const turn = ready.coordinator.readInteractiveTurns().find(item => item.actorId === actor.id && item.turnId === turnId)
          if (!question || question.actorId !== actor.id || question.turnId !== turnId || question.state !== "pending") return fail(request, 409, "question_not_pending")
          if (!turn || !["running", "waiting_input"].includes(turn.state)) return fail(request, 409, "turn_not_waiting")
          const answer = await bridge.submitQuestionnaireResponse?.(command.payload.questionnaireId, command.payload.responseText)
          if (!answer || answer.status !== "submitted") return fail(request, 409, "question_not_pending")
          // Submission wakes the durable mailbox. The coordinator may already have
          // resumed or completed this exact turn before the async facade returns.
          // Its wake-up result cannot negate the owner's successful submission.
          ready.coordinator.resumeInteractiveTurn({ actorId: actor.id, turnId })
          return
        }
        const fiberId = fiberFor(actor.id)
        if (!fiberId) return fail(request, 409, "actor_not_runnable")
        requests.set(turnId, request)
        let delivered = false
        await new Promise<void>((resolve, reject) => {
          const executionOrigin = { source: "web" as const, sessionId, actorId: actor.id, epoch: options.epoch,
            commandId: command.commandId, turnId, principalId: request.principal.principalId }
          const handle = ready.coordinator.admitInteractiveTurn({ actorId: actor.id, turnId, mainFiberId: fiberId, executionOrigin,
            deliver: async signal => {
              await ready.prepareActor(actor)
              signal.throwIfAborted()
              requireAuthority()
              ready.activateSessionMaterialization()
              ready.driver.emitFiberSignal({ fiberId, signalKind: "mailbox_enqueue", executionOrigin,
                mailbox: { kind: "humanInput", payload: command.payload.text }, idempotencyKey: `web:${options.epoch}:${command.commandId}` })
              delivered = true
              resolve()
            },
          })
          void handle.settled.then(() => { if (!delivered) reject(new Error("turn_not_delivered")) }, reject)
        })
      },
    },
  }
  refreshActors()
  ensureVmConversationDomainRuntime(ready.vm)
  const history = createPublicHistoryReader({ vm: ready.vm, sessionId, epoch: options.epoch,
    authorization: options.authorization, identity: options.identity,
    onCommitted(payload) {
      const committed = semantic.onCommitted(payload)
      publishObservation(observations, { kind: "history.committed", payload: committed })
      semantic.closeCommitted(committed)
    },
    onHistoryReset(_actorId, window) { resetObservationHistory(observations, window) },
    onError: observationFailed,
  })
  cleanup.push(() => history.close())
  for (const actorId of actorViews.keys()) seedObservationHistory(observations, history.snapshot(actorId))
  ready.vm.effects.questionnaires = createQuestionnaireHostEffects({ commands, observations,
    actorId: ({ id, key }) => ready.vm.actors[key]?.id === id ? id : undefined,
    currentTurn(actorId) {
      const turn = ready.coordinator.readInteractiveTurns().find(t => t.actorId === actorId && ["running", "waiting_input"].includes(t.state))
      const request = turn ? requests.get(turn.turnId) : undefined
      return turn && request ? { turnId: turn.turnId, request } : undefined
    },
  })
  const turns = ready.coordinator.subscribeInteractiveTurns(turn => {
    const terminal = ["succeeded", "failed", "cancelled", "interrupted"].includes(turn.state)
    if (terminal) {
      semantic.closeTurn(turn.actorId, turn.turnId)
      const actor = actorFor(turn.actorId)
      if (actor) for (const question of commands.index.questions.values()) {
        if (question.record.turnId === turn.turnId && question.record.state === "pending") {
          cancelQuestionnaireRow({ vm: ready.vm, actor, questionnaireId: question.record.questionnaireId })
        }
      }
    }
    const pendingQuestionIds = [...commands.index.questions.values()].filter(q => q.record.turnId === turn.turnId && q.record.state === "pending").map(q => q.record.questionnaireId)
    const publicTurn = { actorId: turn.actorId, turnId: turn.turnId, state: turn.state, canCancel: !terminal, pendingQuestionIds }
    recordHostTurn(commands, publicTurn)
    publishObservation(observations, { kind: "turn.updated", payload: publicTurn })
    refreshActors()
    if (terminal) { requests.delete(turn.turnId); if (!closed) void save() }
  })
  cleanup.push(() => turns.unsubscribe())
  const events = ready.eventBus.addConsumer(event => {
    try { refreshActors(); semantic.onSemantic(event) } catch { observationFailed() }
  }, observationFailed)
  cleanup.push(() => events.unsubscribe())
  return {
    summary: { sessionId, epoch: options.epoch, displayName: options.stored.displayName, readOnly },
    actors(request) {
      refreshActors()
      return { epoch: options.epoch, actors: [...actorViews.values()].filter(a => ["observe", "read_history"].some(action => options.authorization.permits(request.principal, { kind: "actor", sessionId, actorId: a.actorId, action: action as "observe" | "read_history" })))
        .map(a => ({ ...a, allowedActions: a.allowedActions.filter(action => options.authorization.permits(request.principal, { kind: "actor", sessionId, actorId: a.actorId, action })) })) }
    },
    command(request, input) { refreshActors(); return admitHostCommand(commands, request, input) },
    commandStatus: (request, input) => readHostCommand(commands, request, input),
    history: (request, actorId, input) => history.history(request, actorId, input),
    content: (request, actorId, input) => history.content(request, actorId, input),
    subscribe(request, input) {
      if (projectionFailed) return fail(request, 503, "observation_unavailable")
      refreshActors()
      return captureObservation(observations, request, input)
    },
    close() {
      if (closePromise) return closePromise
      closed = true
      commands.index.accepting = false
      publishObservation(observations, { kind: "session.closing", payload: { reason: "shutdown" } })
      closeObservations(observations)
      closePromise = (async () => {
        try { await persistence; await bridge.dispose(); await Promise.allSettled(tasks) }
        finally { for (const release of cleanup.reverse()) release(); requests.clear() }
      })()
      return closePromise
    },
  }
  } catch (error) {
    for (const release of cleanup.reverse()) release()
    await bridge.dispose()
    throw error
  }
}
