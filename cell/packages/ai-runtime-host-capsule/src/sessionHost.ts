import { createHash } from "node:crypto"
import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor"
import { cancelQuestionnaireRow } from "@cell/ai-core-logic"
import { createInteractiveActor } from "@cell/ai-organ-logic/runtime/InteractiveActor"
import { ensureVmConversationDomainRuntime } from "@cell/ai-organ-logic/conversation/ConversationDomainRuntime"
import type { ActorSummary, ActorManagementCommand, ActorManagementResult, HostAuthorizationEffects, HostIdentityEffects, HostRequest, HostResourceEffects, RuntimeHostPort, SessionSummary, SessionManagementCommand, SessionManagementResult } from "@cell/ai-runtime-host-contract"
import {LocalFileRuntimeSnapshotRepository} from '@cell/ai-support'
import {join} from 'node:path'
import {realpathSync} from 'node:fs'
import {readActorRetirement} from '@cell/ai-organ-logic/runtime/ActorRetirementFacet'
import {createActorRetirementHost} from './actorRetirementHost'
import {
  admitHostCommand, captureObservation, closeObservations, createCommandIndex, createObservationState,
  HostProtocolFailure, preflightObservation, prepareObservationCommand, publishObservation, readHostCommand, recordHostTurn,
  resetObservationHistory, seedObservationHistory, recordHostCommandOutcome, type CommandRuntime, type ObservationRuntime,
  createHostAttachmentStore, AttachmentStoreFailure, prepareHostInput,
  createTurnObservationWindow, recordTurnObservation, projectTurnStatistics,
} from "@cell/ai-runtime-host-logic"
import { createObservationCursorEffects, createObservationQueueEffects, createAttachmentByteEffects, type StoredHostSession, type ConversationPublicationStore, type ExecutionOutputStore, type openHostSessionRegistry } from "@cell/ai-runtime-host-support"
import { createSessionRuntimeAssembly, type SessionRuntimeConfig, type SessionRuntimeReady } from "./session/SessionRuntimeAssembly"
import { createPublicHistoryReader } from "./publicHistory"
import { createQuestionnaireHostEffects } from "./questionnaireHost"
import { createSemanticObservation } from "./semanticObservation"
import { createHostActorLifecycle, hostActorExecutionKind } from "./actorLifecycle"
import { readHostModelCatalog } from "./modelCatalog"
import { setActorWorkMode } from "@cell/ai-organ-logic/runtime/ContextControlPlane"
import { createConversationHost } from "./conversationHost"
import { buildGoalContinuationPrompt, getThreadGoal } from "@cell/ai-organ-logic/goals/ThreadGoalManager"
import { createGoalHost } from "./goalHost"
import { createParticipantRuntime } from './participantRuntime'
import {createParticipantAttachments} from './participantAttachments'
import {createHostInteractions} from './hostInteractions'
import type { OpenedLocalHolonTaskRuntime } from './session/LocalHolonTaskRuntimeBootstrap'

export type RuntimeSession = {
  hostInteractions: (request:HostRequest,expectedEpoch:string)=>import('@cell/ai-runtime-host-contract').HostInteractionView
  participant?: ReturnType<typeof createParticipantRuntime>
  isBusy: () => boolean
  summary: SessionSummary
  manage: (request: HostRequest, command: SessionManagementCommand) => Promise<SessionManagementResult>
  manageActor: (request:HostRequest,actorId:string,command:ActorManagementCommand)=>Promise<ActorManagementResult>
  actorManagementResult: (request:HostRequest,actorId:string,commandId:string)=>Promise<ActorManagementResult>
  actorManagementCommit: (request:HostRequest,actorId:string,commandId:string)=>Promise<import('@cell/ai-organ-contract/runtime/ActorRetirement').ActorRetirementCommit|undefined>
  actors: (request: HostRequest) => Awaited<ReturnType<RuntimeHostPort["actors"]>>
  statistics: (request: HostRequest, input: { expectedEpoch: string }) => Awaited<ReturnType<NonNullable<RuntimeHostPort["statistics"]>>>
  conversationOperations: (request: HostRequest, input: Parameters<NonNullable<RuntimeHostPort["conversationOperations"]>>[2]) => Awaited<ReturnType<NonNullable<RuntimeHostPort["conversationOperations"]>>>
  conversationOperation: (request: HostRequest, input: Parameters<NonNullable<RuntimeHostPort["conversationOperation"]>>[2]) => Promise<Awaited<ReturnType<NonNullable<RuntimeHostPort["conversationOperation"]>>>>
  command: (request: HostRequest, input: Parameters<RuntimeHostPort["command"]>[2]) => Awaited<ReturnType<RuntimeHostPort["command"]>>
  commandStatus: (request: HostRequest, input: Parameters<RuntimeHostPort["commandStatus"]>[2]) => Awaited<ReturnType<RuntimeHostPort["commandStatus"]>>
  history: (request: HostRequest, actorId: string, input: Parameters<RuntimeHostPort["history"]>[2]) => Awaited<ReturnType<RuntimeHostPort["history"]>>
  content: (request: HostRequest, actorId: string, input: Parameters<RuntimeHostPort["content"]>[2]) => Awaited<ReturnType<RuntimeHostPort["content"]>>
  attachment: (request: HostRequest, actorId: string, input: Parameters<NonNullable<RuntimeHostPort["attachment"]>>[2]) => Awaited<ReturnType<NonNullable<RuntimeHostPort["attachment"]>>>
  subscribe: (request: HostRequest, input: Parameters<RuntimeHostPort["subscribe"]>[2]) => Awaited<ReturnType<RuntimeHostPort["subscribe"]>>
  close: () => Promise<void>
}

export async function createRuntimeSession(options: {
  stored: StoredHostSession; epoch: string; workDir: string; globalRoot?: string
  executionEnvironment?:import('@cell/ai-runtime-host-contract').ExecutionEnvironmentContext
  config?: Omit<SessionRuntimeConfig, "workDir" | "globalRoot" | "profileId">
  authorization: HostAuthorizationEffects; identity: HostIdentityEffects; resources: HostResourceEffects
  publications?: ConversationPublicationStore
  executionOutputs?: ExecutionOutputStore
  management: ReturnType<typeof openHostSessionRegistry>["management"]
}): Promise<RuntimeSession> {
  const { sessionId } = options.stored
  let ready!: SessionRuntimeReady
  let holon: OpenedLocalHolonTaskRuntime | undefined
  let participantRuntime: ReturnType<typeof createParticipantRuntime> | undefined
  let goals: ReturnType<typeof createGoalHost> | undefined
  const bridge = await createSessionRuntimeAssembly({
    sessionKey: options.stored.storageKey,
    preserveRecoveredModel: true,
    requireExplicitGoalActivation: true,
    goalContinuationAdmission: input => goals?.admitContinuation(input) ?? false,
    config: { ...options.config, workDir: options.executionEnvironment?.workspace.workDir??options.workDir, ...(options.executionEnvironment?{configurationWorkDir:options.workDir}:{}),globalRoot: options.globalRoot, profileId: options.stored.profileId },
    ...(options.executionEnvironment?{ownedSessionDir:join(options.workDir,'.eidolon','sessions',options.stored.storageKey)}:{}),
    toolResources: options.executionEnvironment?{acquire(input){if(realpathSync(input.workDir)!==options.executionEnvironment!.workspace.workspaceId)throw new Error('execution_environment_scope_mismatch');return options.resources.acquire({...input,executionEnvironment:options.executionEnvironment!.ref})}}:options.resources,
    onRuntimeReady(runtime) { ready = runtime },
    ...(options.stored.participantBinding ? { openExtension: async (context) => {
      const { openStandaloneHolonSessionExtension } = await import('./session/StandaloneHolonSessionExtension')
      holon = await openStandaloneHolonSessionExtension(context, { recoverPending: false,
        onActorAdmitted: (input, reference) => participantRuntime?.admitted(input,reference),
        allowHumanInput: Boolean(options.stored.participantBinding),
        executionConversation: input => {
          if (!participantRuntime) throw new Error('participant_runtime_not_ready')
          return participantRuntime.conversation(input)
        },
        async prepareRetainedActor(actorId){
          const model=ready.actor.modelConfig
          if(model.provider&&model.model)await bridge?.setActorActiveModel?.({actorId,requestedBy:'participant-context'}, {providerID:model.provider,modelID:model.model})
        },
        onExecutionCompleted: async input => { participantRuntime?.completed(input); ready.activateSessionMaterialization(); await ready.persistSnapshot() },
      })
      return holon
    } } : {}),
  })
  if (!bridge) throw new Error("runtime_unavailable")
  let lastObservedAt = options.identity.now()
  const observedNow = () => lastObservedAt = Math.max(lastObservedAt, options.identity.now())
  const turnObservations = createTurnObservationWindow(lastObservedAt)
  const cleanup: Array<() => void> = []
  try {
  const byteEffects = createAttachmentByteEffects()
  const attachments = createHostAttachmentStore({ sessionId, epoch: options.epoch, effects: { ...options.identity, ...byteEffects } })
  const inputLeases = new Map<string, ReturnType<typeof prepareHostInput>>()
  cleanup.push(() => { for (const lease of inputLeases.values()) lease.release(); inputLeases.clear(); attachments.close() })
  const attachmentBinding = (request: HostRequest, actorId: string) => ({ ...request.principal, sessionId, actorId, epoch: options.epoch })
  const observations: ObservationRuntime = {
    sessionId, epoch: options.epoch, state: createObservationState(), authorization: options.authorization,
    identity: options.identity, cursors: createObservationCursorEffects(), queues: createObservationQueueEffects(),
  }
  const actorViews = new Map<string, ActorSummary>()
  // Bots backings are addressed through admitted Holon capabilities, never generic Primary input.
  const readOnly = Boolean(options.stored.participantBinding) || Object.values(ready.vm.actors).some(actor => Boolean(actor.identity))
  const lifecycle = createHostActorLifecycle({ vm: ready.vm, observations, actorViews,
    permitsResourceHolonAdoption: candidate => options.stored.participantBinding?.recipient.kind === 'holon'
      && options.stored.participantBinding.recipient.ref === candidate.holonRef
      && options.stored.participantBinding.recipient.bindingRef === candidate.bindingRef
      && Boolean(holon?.permitsResourceHolonAdoption(candidate)),
  })
  ready.vm.effects.actorRegistration = { beforeRegister: lifecycle.beforeRegister }
  const tasks = new Set<Promise<void>>()
  const requests = new Map<string, HostRequest>()
  let closed = false
  let projectionFailed = false
  let closePromise: Promise<void> | undefined
  let persistence = Promise.resolve()
  const modelChanges = new Set<string>()
  let maintenance: string | undefined
  let conversation: ReturnType<typeof createConversationHost> | undefined
  const maintenancePending = () => Boolean(maintenance || conversation?.hasUnresolved())
  const modelBusy = (actorId: string) => ready.coordinator.readInteractiveTurns().some(turn => turn.actorId === actorId && ["queued", "running", "waiting_input"].includes(turn.state))
    || [...commands.index.turns.values()].some(item => item.turn.actorId === actorId && ["queued", "running", "waiting_input"].includes(item.turn.state))
  const actorFor = (actorId: string) => Object.values(ready.vm.actors).find(actor => actor.id === actorId)
  const fiberFor = (actorId: string) => Object.entries(ready.driver.inspectRuntime().fibers).find(([, fiber]) => fiber.actor.id === actorId)?.[0]
  const runtimeFiberBusy = (runtime:ReturnType<typeof ready.driver.inspectRuntime>,fiberId:string) => {
    const context=runtime.fibers[fiberId],fiber=runtime.state.fibers[fiberId]
    if(!context)return false
    if(context.execState?.inflight)return true
    if(fiber&&['completed','cancelled','failed'].includes(fiber.status))return false
    return fiber?.status==='running'||context.actor.execution?.status==='active'
      ||fiber?.status==='ready'&&Object.values(context.actor.mailboxes).some(mailbox=>mailbox.length>0)
  }
  const actorSummary = (actor: AiAgentActor): ActorSummary => {
    const kind = hostActorExecutionKind(actor)
    const retirement=readActorRetirement(actor)
    const controllable = !retirement && !readOnly && (kind === "primary" || kind === "interactive")
    const managementActions:ActorSummary['allowedActions']=readOnly||actor.key===ready.vm.controlActorKey||kind==='primary'||retirement?.phase==='tombstoned'?[]
      :retirement?['delete_actor']:['archive_actor','delete_actor']
    const turn = ready.coordinator.readInteractiveTurns().find(t => t.actorId === actor.id && ["running", "waiting_input"].includes(t.state))
    const runtime = ready.driver.inspectRuntime()
    const backgroundFiber = Object.values(runtime.fibers).find(context => context.actor.id === actor.id)
    const backgroundBusy = (kind === 'delegate' || kind === 'detached') && !!backgroundFiber && runtimeFiberBusy(runtime,backgroundFiber.fiberId)
    return { actorId: actor.id, ...(kind === "primary" || kind === "interactive" ? { memberId: kind === "primary" ? "primary" : actor.identity?.kind === "member" ? actor.identity.memberId : actor.id } : {}),
      displayName: actor.agentName || (kind === "primary" ? "Primary" : actor.key), executionKind: kind,
      runtimeState: retirement?'stopped':turn?.state === "waiting_input" ? "waiting_input" : turn || backgroundBusy ? "running" : "idle",
      lifecycle:retirement?{state:retirement.phase,revision:retirement.commits.at(-1)!.revision,changedAt:retirement.changedAt}:{state:'active',revision:0},
      ...(actor.modelConfig.provider && actor.modelConfig.model ? { modelRef: `${actor.modelConfig.provider}/${actor.modelConfig.model}` } : {}),
      ...(actor.workContext ? { workContext: { workMode: actor.workContext.workMode, taskPhase: actor.workContext.taskPhase,
        workModeUpdatedAt: actor.workContext.workModeUpdatedAt, taskPhaseUpdatedAt: actor.workContext.taskPhaseUpdatedAt } } : {}),
      ...(kind === "primary" && goals ? { threadGoal: goals.view() } : {}),
      allowedActions: [...(controllable ? ["host_interaction", "observe", "read_history", "send_text", "send_input", "upload_attachment", "cancel_turn", "answer_question", "set_model", "compact", "set_work_mode", ...(kind === "primary" ? ["set_goal", "continue_goal"] as const : []), ...(conversation ? ["fork_conversation", "rewind_conversation"] as const : [])] as ActorSummary['allowedActions'] : ["observe", "read_history"] as const),...managementActions],
      ...(maintenancePending() ? { disabledReasons: { compact: "session_maintenance_pending", set_work_mode: "session_maintenance_pending", send_text: "session_maintenance_pending", send_input: "session_maintenance_pending", upload_attachment: "session_maintenance_pending", set_model: "session_maintenance_pending", fork_conversation: "session_maintenance_pending", rewind_conversation: "session_maintenance_pending", set_goal: "session_maintenance_pending", continue_goal: "session_maintenance_pending" } } : {}),
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
  const requireCompactIdle = (request: HostRequest) => {
    if (modelChanges.size || [...actorViews.keys()].some(modelBusy)
      || [...commands.index.questions.values()].some(question => question.record.state === "pending")) return fail(request, 409, "session_busy")
  }
  const requireHistoryRevision = (request: HostRequest, actorId: string, expected: string) => {
    if (history.capture(actorId).historyRevision !== expected) return fail(request, 409, "history_revision_changed")
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
        if(command.kind==='host_interaction')interactions.preflight(request,command.payload.actorId,command.payload.operationJson)
        if('actorId' in command.payload){
          const target=actorFor(command.payload.actorId),retirement=target&&readActorRetirement(target)
          if(retirement)return fail(request,409,`actor_${retirement.phase}`)
        }
        if (projectionFailed && (command.kind === "send_text" || command.kind === "send_input" || command.kind === "create_actor" || command.kind === "compact" || command.kind === "set_work_mode" || command.kind === "fork_conversation" || command.kind === "rewind_conversation" || command.kind === "set_goal" || command.kind === "continue_goal")) return fail(request, 503, "observation_unavailable")
        if (maintenancePending() && command.kind !== "cancel_turn" && command.kind !== "answer_question") return fail(request, 409, "session_maintenance_pending")
        if (command.kind === "set_goal") {
          if (!goals) return fail(request, 503, "goal_control_unavailable")
          goals.validateControl(request, command.payload)
          if (command.payload.operation !== "pause") requireCompactIdle(request)
          const actor = actorFor(command.payload.actorId)!
          preflightObservation(observations, { kind: "actor.updated", payload: { ...actorSummary(actor), threadGoal: goals.previewControl(command.payload) } })
          const lease = prepareObservationCommand(observations, command, request.principal.principalId, status)
          return { commit() { lease.commit(); maintenance = command.commandId }, release() { lease.release(); if (maintenance === command.commandId) maintenance = undefined } }
        }
        if (command.kind === "continue_goal") {
          if (!goals) return fail(request, 503, "goal_control_unavailable")
          goals.validateContinuation(request, command.payload)
          requireCompactIdle(request)
        }
        if (command.kind === "fork_conversation" || command.kind === "rewind_conversation") {
          if (!conversation) return fail(request, 503, "conversation_operations_unavailable")
          const observationLease = prepareObservationCommand(observations, command, request.principal.principalId, status)
          let publicationLease: ReturnType<typeof conversation.reserve>
          try { publicationLease = conversation.reserve(request, command) }
          catch (error) { observationLease.release(); throw error }
          return {
            commit() { observationLease.commit(); publicationLease.commit(); maintenance = command.commandId },
            release() { observationLease.release(); publicationLease.release(); if (maintenance === command.commandId) maintenance = undefined },
          }
        }
        if (command.kind === "compact" || command.kind === "set_work_mode") {
          requireCompactIdle(request)
          if (command.kind === "compact") requireHistoryRevision(request, command.payload.actorId, command.payload.expectedHistoryRevision)
          const lease = prepareObservationCommand(observations, command, request.principal.principalId, status)
          return { commit() { lease.commit(); maintenance = command.commandId }, release() { lease.release(); if (maintenance === command.commandId) maintenance = undefined } }
        }
        if ((command.kind === "send_text" || command.kind === "send_input") && modelChanges.has(command.payload.actorId)) return fail(request, 409, "model_change_pending")
        if (command.kind === "send_input") {
          let inputLease: ReturnType<typeof prepareHostInput>
          try { inputLease = prepareHostInput(attachments, attachmentBinding(request, command.payload.actorId), command.payload.parts, byteEffects) }
          catch (error) { if (error instanceof AttachmentStoreFailure) return fail(request, error.status, error.code); throw error }
          const observationLease = prepareObservationCommand(observations, command, request.principal.principalId, status)
          return {
            commit() {
              try { inputLease.commit(); observationLease.commit(); inputLeases.set(status.turnId!, inputLease) }
              catch (error) { inputLease.release(); observationLease.release(); if (error instanceof AttachmentStoreFailure) return fail(request, error.status, error.code); throw error }
            },
            release() { inputLease.release(); observationLease.release(); inputLeases.delete(status.turnId!) },
          }
        }
        if (command.kind === "set_model") {
          if (modelChanges.has(command.payload.actorId) || modelBusy(command.payload.actorId)) return fail(request, 409, "actor_busy")
          const catalog = readHostModelCatalog(options.workDir, options.globalRoot)
          if (catalog.error) return fail(request, 503, catalog.error)
          if (!catalog.models.some(model => `${model.providerId}/${model.modelId}` === command.payload.modelRef)) return fail(request, 400, "invalid_model_ref")
          try { ready.resolveActorModelConfig(command.payload.modelRef) } catch { return fail(request, 400, "invalid_model_ref") }
          const lease = prepareObservationCommand(observations, command, request.principal.principalId, status)
          return { commit() { lease.commit(); modelChanges.add(command.payload.actorId) }, release() { lease.release(); modelChanges.delete(command.payload.actorId) } }
        }
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
        if (command.kind === "fork_conversation" || command.kind === "rewind_conversation") {
          if (!conversation) return fail(request, 503, "conversation_operations_unavailable")
          try { refreshActors(); return await conversation.execute(request, command) }
          finally { if (maintenance === command.commandId) maintenance = undefined; refreshActors() }
        }
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
        if(command.kind==='host_interaction'){
          await interactions.command(request,command.payload.actorId,command.payload.operationJson)
          return {actorId:command.payload.actorId}
        }
        if (command.kind === "set_goal") {
          try {
            return await ready.coordinator.enqueueWithoutSnapshot(async () => {
              if (closed) return fail(request, 409, "session_closing")
              requireAuthority()
              ready.activateSessionMaterialization()
              return goals!.manage(request, command.payload, command.commandId)
            })
          } finally { if (maintenance === command.commandId) maintenance = undefined; refreshActors() }
        }
        if (command.kind === "set_work_mode") {
          let checkpointStarted = false
          try {
            const result = await ready.coordinator.enqueue(async () => {
              if (closed) return fail(request, 409, "session_closing")
              requireAuthority()
              if (!actor || actorFor(actor.id) !== actor) return fail(request, 404, "actor_not_found")
              requireCompactIdle(request)
              publishObservation(observations, { kind: "checkpoint.updated", payload: { state: "pending" } })
              checkpointStarted = true
              const next = setActorWorkMode({ actor, workMode: command.payload.workMode, source: "web_command", occurredAt: new Date(options.identity.now()).toISOString() })
              ready.activateSessionMaterialization()
              await ready.persistSnapshot()
              return { actorId: actor.id, workMode: next.workMode }
            })
            publishObservation(observations, { kind: "checkpoint.updated", payload: { state: "saved" } })
            return result
          } catch (error) {
            if (checkpointStarted) publishObservation(observations, { kind: "checkpoint.updated", payload: { state: "failed", error: { code: "work_mode_checkpoint_failed", requestId: request.requestId, retryable: false } } })
            throw error
          } finally { if (maintenance === command.commandId) maintenance = undefined; refreshActors() }
        }
        if (command.kind === "compact") {
          let checkpointStarted = false
          try {
            refreshActors()
            const validate = () => {
              if (closed) return fail(request, 409, "session_closing")
              requireAuthority()
              if (!actor || actorFor(actor.id) !== actor) return fail(request, 404, "actor_not_found")
              requireCompactIdle(request)
              requireHistoryRevision(request, actor.id, command.payload.expectedHistoryRevision)
            }
            validate()
            publishObservation(observations, { kind: "checkpoint.updated", payload: { state: "pending" } })
            checkpointStarted = true
            const result = await bridge.compact({ actorId: actor!.id, beforeCompact: validate })
            if (!result.ok || !result.compaction) return fail(request, 409, "compact_failed")
            publishObservation(observations, { kind: "checkpoint.updated", payload: { state: "saved" } })
            return { actorId: actor!.id, compact: { ...result.compaction, historyRevision: history.capture(actor!.id).historyRevision } }
          } catch (error) {
            if (checkpointStarted) publishObservation(observations, { kind: "checkpoint.updated", payload: { state: "failed", error: { code: "compact_failed", requestId: request.requestId, retryable: false } } })
            throw error
          } finally { if (maintenance === command.commandId) maintenance = undefined; refreshActors() }
        }
        if (command.kind === "set_model") {
          try {
            if (!actor) return fail(request, 404, "actor_not_found")
            if (modelBusy(actor.id)) return fail(request, 409, "actor_busy")
            if (!bridge.setActorActiveModel) return fail(request, 503, "model_selection_unavailable")
            const separator = command.payload.modelRef.indexOf("/")
            await bridge.setActorActiveModel({ actorId: actor.id, requestedBy: "web-host" }, {
              providerID: command.payload.modelRef.slice(0, separator), modelID: command.payload.modelRef.slice(separator + 1),
            })
            refreshActors()
            return { actorId: actor.id }
          } finally { modelChanges.delete(command.payload.actorId); refreshActors() }
        }
        if (!actor || !turnId) return fail(request, 404, "actor_not_found")
        if (command.kind === "cancel_turn") {
          if (commands.index.turns.get(turnId)?.turn.source === "goal") goals?.suspend("cancelled")
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
        if (command.kind !== "send_text" && command.kind !== "send_input" && command.kind !== "continue_goal") return fail(request, 400, "unsupported_command")
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
              const mailbox = command.kind === "continue_goal"
                ? { kind: "heartbeat" as const, payload: { heartbeatKind: "runtime_internal_context" as const, source: "goal" as const,
                  text: buildGoalContinuationPrompt(goals!.validateContinuation(request, command.payload)) } }
                : { kind: "humanInput" as const, payload: command.kind === "send_input"
                  ? ready.validateActorInput(actor, inputLeases.get(turnId)!.read()) : command.payload.text }
              ready.driver.emitFiberSignal({ fiberId, signalKind: "mailbox_enqueue", executionOrigin,
                mailbox, idempotencyKey: `web:${options.epoch}:${command.commandId}` })
              delivered = true
              resolve()
            },
          })
          void handle.settled.then(() => { if (!delivered) reject(new Error("turn_not_delivered")) }, reject)
        })
      },
    },
  }
  const interactions=createHostInteractions({ready,sessionId,epoch:options.epoch,now:options.identity.now,newId:options.identity.newId,
    currentTurn(actorId){const turn=ready.coordinator.readInteractiveTurns().find(t=>t.actorId===actorId&&['running','waiting_input'].includes(t.state));const request=turn&&requests.get(turn.turnId);return turn&&request?{turnId:turn.turnId,request,attemptId:semantic.attemptId(actorId,turn.turnId)}:undefined},
    authorize(request,actorId){if(closed||readOnly||options.authorization.currentGrantsVersion(request.principal.principalId)!==request.principal.grantsVersion||!actorFor(actorId)||!options.authorization.permits(request.principal,{kind:'actor',sessionId,actorId,action:'host_interaction'}))fail(request,403,'host_interaction_forbidden')},
  })
  cleanup.push(()=>interactions.close())
  goals = createGoalHost({ ready, sessionId, epoch: options.epoch, authorization: options.authorization, identity: options.identity,
    requireIdle: requireCompactIdle, unavailable: () => closed || readOnly || projectionFailed, continuationBlocked: maintenancePending,
    refresh: refreshActors,
    checkpoint(state, request) { publishObservation(observations, { kind: "checkpoint.updated", payload: { state,
      ...(state === "failed" ? { error: { code: "goal_checkpoint_failed", requestId: request.requestId, retryable: false } } : {}) } }) },
    command(request, command) { refreshActors(); return admitHostCommand(commands, request, command) },
  })
  refreshActors()
  ensureVmConversationDomainRuntime(ready.vm)
  const history = createPublicHistoryReader({ vm: ready.vm, sessionId, epoch: options.epoch,
    authorization: options.authorization, identity: options.identity,
    onCommitted(payload) {
      const committed = semantic.onCommitted(payload)
      publishObservation(observations, { kind: "history.committed", payload: committed })
      semantic.closeCommitted(committed)
    },
    onCommittedRecord:(actorId,record)=>participantRuntime?.committed(actorId,record),
    onHistoryReset(_actorId, window) { resetObservationHistory(observations, window) },
    onError: observationFailed,
  })
  cleanup.push(() => history.close())
  if (options.publications && ready.conversationPersistence && bridge.forkConversationSession && bridge.rewindConversationSession) {
    const permits = (request: HostRequest, actorId: string, action: "fork_conversation" | "rewind_conversation") =>
      options.authorization.currentGrantsVersion(request.principal.principalId) === request.principal.grantsVersion
      && options.authorization.permits(request.principal, { kind: "session", sessionId, action: "open" })
      && options.authorization.permits(request.principal, { kind: "actor", sessionId, actorId, action })
      && options.authorization.permits(request.principal, { kind: "actor", sessionId, actorId, action: "read_history" })
    conversation = createConversationHost({ stored: options.stored, epoch: options.epoch, store: options.publications, bridge,
      persistence: ready.conversationPersistence, identity: options.identity, permits,
      requireIdle: requireCompactIdle, historyRevision: actorId => history.capture(actorId).historyRevision,
      validate(request, actorId, action) {
        if (closed) return fail(request, 409, "session_closing")
        if (readOnly) return fail(request, 403, "session_read_only")
        if (projectionFailed) return fail(request, 503, "observation_unavailable")
        if (!permits(request, actorId, action) || action === "fork_conversation" && !options.authorization.permits(request.principal, { kind: "server", action: "create_session" })) return fail(request, 403, "forbidden")
        const actor = actorFor(actorId)
        if (!actor) return fail(request, 404, "actor_not_found")
        const retirement=readActorRetirement(actor)
        if(retirement)return fail(request,409,`actor_${retirement.phase}`)
        if (!["primary", "interactive"].includes(hostActorExecutionKind(actor))) return fail(request, 403, "actor_read_only")
      },
    })
    refreshActors()
  }
  for (const actorId of actorViews.keys()) seedObservationHistory(observations, history.snapshot(actorId))
  const interactiveQuestionnaires = createQuestionnaireHostEffects({ commands, observations,
    actorId: ({ id, key }) => ready.vm.actors[key]?.id === id ? id : undefined,
    currentTurn(actorId) {
      const turn = ready.coordinator.readInteractiveTurns().find(t => t.actorId === actorId && ["running", "waiting_input"].includes(t.state))
      const request = turn ? requests.get(turn.turnId) : undefined
      return turn && request ? { turnId: turn.turnId, request } : undefined
    },
  })
  ready.vm.effects.questionnaires={
    admit(input){return participantRuntime?participantRuntime.questionnaires.admit(input):interactiveQuestionnaires.admit(input)},
    transitioned(row){if(participantRuntime)participantRuntime.questionnaires.transitioned?.(row);else interactiveQuestionnaires.transitioned?.(row)},
  }
  const turns = ready.coordinator.subscribeInteractiveTurns(turn => {
    recordTurnObservation(turnObservations, turn, observedNow())
    const terminal = ["succeeded", "failed", "cancelled", "interrupted"].includes(turn.state)
    if (terminal) {
      interactions.cancelActor(turn.actorId,turn.turnId)
      inputLeases.get(turn.turnId)?.release(); inputLeases.delete(turn.turnId)
      semantic.closeTurn(turn.actorId, turn.turnId)
      const actor = actorFor(turn.actorId)
      if (actor) for (const question of commands.index.questions.values()) {
        if (question.record.turnId === turn.turnId && question.record.state === "pending") {
          cancelQuestionnaireRow({ vm: ready.vm, actor, questionnaireId: question.record.questionnaireId })
        }
      }
    }
    const pendingQuestionIds = [...commands.index.questions.values()].filter(q => q.record.turnId === turn.turnId && q.record.state === "pending").map(q => q.record.questionnaireId)
    const original = commands.index.turns.get(turn.turnId)?.turn
    if (original?.source === "goal" && original.goalId === getThreadGoal(ready.vm)?.goalId && ["failed", "cancelled", "interrupted"].includes(turn.state)) goals?.suspend(turn.state === "cancelled" ? "cancelled" : "continuation_failed")
    const publicTurn = { actorId: turn.actorId, turnId: turn.turnId, state: turn.state, canCancel: !terminal, pendingQuestionIds,
      ...(original?.source === "goal" ? { source: "goal" as const, goalId: original.goalId } : {}) }
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
  const close = (reason: "shutdown" | "maintenance" = "shutdown") => {
    if (closePromise) return closePromise
    closed = true
    goals?.suspend("closed")
    commands.index.accepting = false
    closeObservations(observations, reason)
    closePromise = (async () => {
      try {
        try { await persistence; await participantRuntime?.shutdown(); await participantRuntime?.flush() }
        finally { await bridge.dispose(reason === "maintenance" ? { checkpoint: "already_saved" } : undefined); await Promise.allSettled(tasks) }
      }
      finally { for (const release of cleanup.reverse()) release(); requests.clear() }
    })()
    return closePromise
  }
  const requireManagementIdle = (request: HostRequest, input: SessionManagementCommand) => {
    if (closed) return fail(request, 409, "session_closing")
    if (readOnly) return fail(request, 403, "session_read_only")
    if (projectionFailed) return fail(request, 503, "observation_unavailable")
    if (options.authorization.currentGrantsVersion(request.principal.principalId) !== request.principal.grantsVersion
      || !options.authorization.permits(request.principal, { kind: "session", sessionId, action: "open" })
      || !options.authorization.permits(request.principal, { kind: "session", sessionId, action: input.kind })) return fail(request, 403, "forbidden")
    if (input.expectedEpoch !== options.epoch) return fail(request, 409, "epoch_mismatch")
    requireCompactIdle(request)
    if (input.kind === "archive" && getThreadGoal(ready.vm)?.status === "active") return fail(request, 409, "session_goal_active")
  }
  const executionBusy=()=>{
    if(holon?.support.isBusy()||modelChanges.size||[...actorViews.keys()].some(modelBusy)
      ||[...commands.index.questions.values()].some(question=>question.record.state==='pending'))return true
    const runtime=ready.driver.inspectRuntime()
    if(runtime.pendingResumes.length||runtime.pendingForegroundTasks?.length)return true
    return Object.keys(runtime.fibers).some(fiberId=>runtimeFiberBusy(runtime,fiberId))
  }
  const retirementHost=createActorRetirementHost({ready,sessionId,now:options.identity.now,
    validate(request,actor,input){
      if(closed)return fail(request,409,'session_closing')
      if(readOnly)return fail(request,403,'session_read_only')
      if(projectionFailed)return fail(request,503,'observation_unavailable')
      if(options.authorization.currentGrantsVersion(request.principal.principalId)!==request.principal.grantsVersion
        ||!options.authorization.permits(request.principal,{kind:'session',sessionId,action:'open'})
        ||!options.authorization.permits(request.principal,{kind:'actor',sessionId,actorId:actor.id,action:input.kind}))return fail(request,403,'forbidden')
      if(input.expectedEpoch!==options.epoch)return fail(request,409,'epoch_mismatch')
      if(actorFor(actor.id)!==actor)return fail(request,409,'actor_identity_changed')
      if(maintenance&&maintenance!==input.commandId||conversation?.hasUnresolved())return fail(request,409,'session_maintenance_pending')
      if(registryArchived())return fail(request,409,'session_archived')
    },
    requireIdle(request){if(executionBusy())return fail(request,409,'session_busy')},
    begin(commandId){maintenance=commandId;refreshActors()},
    end(commandId){if(maintenance===commandId)maintenance=undefined},
    flush:()=>persistence,refresh:refreshActors,
    async persisted(actorId){
      const repository=new LocalFileRuntimeSnapshotRepository(join(ready.sessionDir,'runtime_state'))
      await repository.preflightSnapshot()
      return (await repository.readActorDirectory())?.find(actor=>actor.id===actorId)
    },
  })
  function registryArchived(){return options.management.metadata(sessionId)?.lifecycle==='archived'}
  if (holon && options.stored.participantBinding) participantRuntime = createParticipantRuntime({ ready, holon, binding: options.stored.participantBinding,
    authorization: options.authorization, now: options.identity.now, isClosed: () => closed, outputs: options.executionOutputs,
    attachments:createParticipantAttachments({store:attachments,bytes:byteEffects,sessionId,actorId:ready.actor.id,epoch:options.epoch,schema:()=>holon!.inputSchema(options.stored.participantBinding!.recipient.admissionRef!)}),
    modelCatalog:()=>readHostModelCatalog(options.workDir,options.globalRoot),
    async setModel(modelRef){
      if(!bridge.setActorActiveModel)throw new Error('model_selection_unavailable')
      const separator=modelRef.indexOf('/')
      await bridge.setActorActiveModel({actorId:ready.actor.id,requestedBy:'participant-context'}, {providerID:modelRef.slice(0,separator),modelID:modelRef.slice(separator+1)})
    },
  })
  return {
    hostInteractions(request,expectedEpoch){if(expectedEpoch!==options.epoch)return fail(request,409,'epoch_mismatch');return interactions.view(request)},
    ...(participantRuntime ? {participant:participantRuntime} : {}),
    summary: { sessionId, epoch: options.epoch, displayName: options.stored.displayName, readOnly },
    manageActor(request,actorId,input){
      const actor=actorFor(actorId)
      if(!actor)return Promise.reject(new HostProtocolFailure(404,{code:'actor_not_found',requestId:request.requestId,retryable:false}))
      return retirementHost.manage(request,actor,input)
    },
    actorManagementResult:(request,actorId,commandId)=>retirementHost.result(request,actorId,commandId),
    actorManagementCommit:(request,actorId,commandId)=>retirementHost.existing(request,actorId,commandId),
    async manage(request, input) {
      requireManagementIdle(request, input)
      if (maintenancePending()) return fail(request, 409, "session_maintenance_pending")
      maintenance = input.commandId
      refreshActors()
      let closing: Promise<void> | undefined
      try {
        await persistence
        const result = await ready.coordinator.enqueueWithoutSnapshot(async () => {
          requireManagementIdle(request, input)
          const metadata = options.management.metadata(sessionId)
          if (!metadata || metadata.lifecycle === "archived") return fail(request, 409, "session_archived")
          if (input.expectedMetadataRevision !== metadata.metadataRevision) return fail(request, 409, "metadata_revision_changed")
          if (input.kind === "archive") {
            publishObservation(observations, { kind: "checkpoint.updated", payload: { state: "pending" } })
            try {
              const checkpoint = await ready.checkpointWithoutExecution()
              if (checkpoint.status !== "saved") return fail(request, 409, "checkpoint_not_saved")
              publishObservation(observations, { kind: "checkpoint.updated", payload: { state: "saved" } })
            } catch (error) {
              publishObservation(observations, { kind: "checkpoint.updated", payload: { state: "failed", error: { code: "checkpoint_failed", requestId: request.requestId, retryable: false } } })
              if (error instanceof HostProtocolFailure) throw error
              return fail(request, 503, "checkpoint_failed")
            }
            // Check grants and all guards again after checkpoint I/O, before durable commit.
            requireManagementIdle(request, input)
          }
          const result = options.management.commit({ principalId: request.principal.principalId, sessionId }, input, options.identity.now())
          if (input.kind === "archive") { closing = close("maintenance"); void closing.catch(() => {}) }
          return result
        })
        // dispose drains this coordinator: await outside its exclusive lane.
        if (closing) {
          try { await closing }
          catch { throw new HostProtocolFailure(503, { code: "session_archive_cleanup_failed", requestId: request.requestId, retryable: false, state: "unknown" }) }
        }
        return result
      } finally {
        if (maintenance === input.commandId) maintenance = undefined
        if (!closed) refreshActors()
      }
    },
    actors(request) {
      refreshActors()
      return { epoch: options.epoch, actors: [...actorViews.values()].filter(a => ["observe", "read_history"].some(action => options.authorization.permits(request.principal, { kind: "actor", sessionId, actorId: a.actorId, action: action as "observe" | "read_history" })))
        .map(a => ({ ...a, allowedActions: a.allowedActions.filter(action => options.authorization.permits(request.principal, { kind: "actor", sessionId, actorId: a.actorId, action })) })) }
    },
    command(request, input) { refreshActors(); return admitHostCommand(commands, request, input) },
    statistics(request, input) {
      if (closed) return fail(request, 409, "session_closing")
      if (options.authorization.currentGrantsVersion(request.principal.principalId) !== request.principal.grantsVersion
        || !options.authorization.permits(request.principal, { kind: "session", sessionId, action: "open" })
        || !options.authorization.permits(request.principal, { kind: "session", sessionId, action: "read_statistics" })) return fail(request, 403, "forbidden")
      if (input.expectedEpoch !== options.epoch) return fail(request, 409, "epoch_mismatch")
      if (!bridge.readUsageProjection || !bridge.readTimingProjection) return fail(request, 503, "statistics_unavailable")
      const observedAt = observedNow()
      const timing = bridge.readTimingProjection({ startedAt: turnObservations.startedAt, endedAt: observedAt, callEntryLimit: 0 })
      return { sessionId, epoch: options.epoch, scope: "session", lifetime: "runtime_epoch", startedAt: turnObservations.startedAt, observedAt,
        usage: bridge.readUsageProjection(), turns: projectTurnStatistics(turnObservations, observedAt),
        timing: { intervalMode: "exclusive_union", wallMs: timing.window.wallMs, ...timing.components } }
    },
    commandStatus: (request, input) => readHostCommand(commands, request, input),
    conversationOperations(request, input) {
      if (!conversation) return fail(request, 503, "conversation_operations_unavailable")
      if (closed) return fail(request, 409, "session_closing")
      if (options.authorization.currentGrantsVersion(request.principal.principalId) !== request.principal.grantsVersion
        || !options.authorization.permits(request.principal, { kind: "session", sessionId, action: "open" })) return fail(request, 403, "forbidden")
      return conversation.list(request, input)
    },
    async conversationOperation(request, input) {
      if (!conversation) return fail(request, 503, "conversation_operations_unavailable")
      if (closed) return fail(request, 409, "session_closing")
      if (input.reconcile && maintenance) return fail(request, 409, "session_maintenance_pending")
      if (input.reconcile) maintenance = input.operationId
      try {
        const operation = await conversation.read(request, input)
        if (input.reconcile && (operation.state === "applied" || operation.state === "rejected")) recordHostCommandOutcome(commands, request.principal.principalId, {
          commandId: operation.commandId, epoch: operation.submittedEpoch, state: operation.state,
          result: { actorId: operation.actorId, conversation: operation },
          ...(operation.state === "rejected" ? { error: { code: operation.errorCode!, requestId: request.requestId, retryable: false } } : {}),
        })
        return operation
      }
      finally { if (maintenance === input.operationId) maintenance = undefined; refreshActors() }
    },
    history: (request, actorId, input) => history.history(request, actorId, input),
    content: (request, actorId, input) => history.content(request, actorId, input),
    attachment(request, actorId, input) {
      if (closed) return fail(request, 409, "session_closing")
      if (readOnly) return fail(request, 403, "session_read_only")
      if (options.authorization.currentGrantsVersion(request.principal.principalId) !== request.principal.grantsVersion
        || !options.authorization.permits(request.principal, { kind: "session", sessionId, action: "open" })
        || !options.authorization.permits(request.principal, { kind: "actor", sessionId, actorId, action: "upload_attachment" })) return fail(request, 403, "forbidden")
      if (input.expectedEpoch !== options.epoch) return fail(request, 409, "epoch_mismatch")
      const actor = actorFor(actorId)
      if (!actor) return fail(request, 404, "actor_not_found")
      const retirement=readActorRetirement(actor)
      if(retirement&&input.kind!=='release')return fail(request,409,`actor_${retirement.phase}`)
      if (!["primary", "interactive"].includes(hostActorExecutionKind(actor))) return fail(request, 403, "actor_read_only")
      if (maintenancePending() && input.kind !== "release") return fail(request, 409, "session_maintenance_pending")
      const binding = attachmentBinding(request, actorId)
      try {
        if (input.kind === "begin") return attachments.begin(binding, input)
        if (input.kind === "append") return attachments.append(binding, input.attachmentId, input.offsetBytes, input.data)
        return attachments.release(binding, input.attachmentId)
      } catch (error) { if (error instanceof AttachmentStoreFailure) return fail(request, error.status, error.code); throw error }
    },
    subscribe(request, input) {
      if (projectionFailed) return fail(request, 503, "observation_unavailable")
      refreshActors()
      return captureObservation(observations, request, input)
    },
    isBusy: () => {
      return maintenancePending()||retirementHost.unresolved()||executionBusy()
    },
    close: () => close(),
  }
  } catch (error) {
    for (const release of cleanup.reverse()) release()
    await bridge.dispose()
    throw error
  }
}
