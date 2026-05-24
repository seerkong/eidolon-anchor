import { describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent/ToolFuncComposer"
import { AgentEventGraph, AgentRegistry, createActor, createVM } from "@cell/ai-core-logic"
import { ensureVmRuntimeContext } from "@cell/ai-core-logic/runtime/runtime"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import type { ToolDef } from "@cell/ai-core-contract/types"
import { TASK_PHASES, WORK_MODES } from "@cell/ai-core-contract/runtime/ContextControl"
import {
  createShellRuntimeFacade,
  configureRuntimePersistenceSupport,
  createAiAgentOrchestratorDriverWithCooperative,
  getMemberManager,
} from "@cell/ai-organ-logic"
import { aiAgentLoopStreaming } from "@cell/ai-organ-logic/exec/AiAgentExecutor"
import { createAutonomousHolonController } from "@cell/ai-organ-logic/organization/AutonomousHolonController"
import { getDetachedActorRegistry } from "@cell/ai-organ-logic/detached/DetachedActorRegistry"
import { getCoordinationEngine } from "@cell/ai-organ-logic/coordination/CoordinationEngine"
import { recoverAiAgentRuntime, saveAiAgentRuntimeSnapshot } from "@cell/ai-organ-logic/persistence/RuntimeSnapshots"
import {
  applyConversationCompaction,
  LocalFileActorTranscriptStore,
  LocalFileConversationPersistenceRepositoryFactory,
  LocalFileRuntimeDerivedIndexesStore,
  LocalFileRuntimeSnapshotRepositoryFactory,
} from "@cell/ai-support"

function makeTempSessionDir(): string {
  const dir = path.join(os.tmpdir(), `eidolon-runtime-recovery-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

configureRuntimePersistenceSupport({
  actorTranscriptStore: LocalFileActorTranscriptStore,
  snapshotRepositoryFactory: LocalFileRuntimeSnapshotRepositoryFactory,
  derivedIndexesStore: LocalFileRuntimeDerivedIndexesStore,
  conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
})

function makeMockAdapter() {
  return {
    type: "openai" as const,
    async createStream() {
      async function* stream() {
        yield { ok: true }
      }
      return { stream: stream() }
    },
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((r) => setTimeout(r, 0))
  }
}

describe("runtime recovery bootstrap", () => {
  it("restores session state and projects recovered status to tools", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = "session-recovery"
    const adapter = makeMockAdapter()
    const eventBus = new AgentEventGraph()
    const toolRegistry = composeToolRegistry({ includeInternalOnly: true })

    const root = createActor({
      key: "main",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      messages: [{ role: "system", content: "system" } as any],
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "ok" }),
      },
    })
    root.send("humanInput", "persist me")
    root.send("toolResult", { toolCallId: "tc-main", content: "tool result" })

    const vm = createVM({
      controlActorKey: root.key,
      actors: { [root.key]: root },
      eventBus,
      registries: {
        toolRegistry,
        agentRegistry: new AgentRegistry({ code: { name: "code", description: "test", tools: "*", prompt: ["you are code"] } } as any),
      },
      callbacks: {
        buildSystemMessages: (prompts) => prompts.map((content) => ({ role: "system", content })),
      },
    })

    const mainFiberId = `${root.key}:${root.id}`
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: mainFiberId, vm, actor: root, messages: root.messages, basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })

    const members = getMemberManager()
    members.__resetForTest?.()
    const protocolEngine = getCoordinationEngine()
    protocolEngine.__resetForTest?.()

    const worker = members.createMember({
      vm,
      driver,
      controlActor: root,
      name: "Alice",
      role: "worker",
      agentType: "code",
      systemPrompt: ["you are alice"],
    })
    const collectiveWorker = members.createMember({
      vm,
      driver,
      controlActor: root,
      name: "Auto",
      role: "worker",
      agentType: "code",
      systemPrompt: ["you are auto"],
      lane: "autonomous_holon",
    })

    members.sendMessage({ vm, to: worker.memberId, from: "main", text: "queued ping" })

    const detachedActor = createActor({
      key: "detached:child",
      type: "detached" as any,
      parentKey: root.key,
      llmClient: adapter,
      modelConfig: { model: "mock" },
      messages: [{ role: "user", content: "run detached" } as any],
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "ok" }),
      },
    })
    vm.actors[detachedActor.key] = detachedActor
    if (!vm.actorRuntime.has(detachedActor.key)) {
      vm.actorRuntime.register(detachedActor.key, detachedActor)
    }

    const detachedFiberId = `${detachedActor.key}:${detachedActor.id}`
    driver.spawnFiber({
      fiberId: detachedFiberId,
      vm,
      actor: detachedActor,
      messages: detachedActor.messages,
      basePriority: 1,
      parentFiberId: mainFiberId,
      kind: "delegate" as any,
      lane: "detached",
      workload: "detached_delegate_task" as any,
      onDone: { parentFiberId: mainFiberId, mode: "detached", taskId: "task-detached-1", taskKind: "delegate" as any },
    })
    driver.suspendFiber(detachedFiberId, Date.now(), "external")
    getDetachedActorRegistry(vm).create({
      taskId: "task-detached-1",
      kind: "delegate",
      status: "suspended",
      parentFiberId: mainFiberId,
      childFiberId: detachedFiberId,
      childActorKey: detachedActor.key,
      childActorId: detachedActor.id,
      toolCallId: "tc-detached-1",
    })

    const outbound = protocolEngine.makeOutbound({ coordination: "shutdown", kind: "shutdown_request", payload: { reason: "persist" } })
    protocolEngine.ingestMemberInbox(vm, { from: "main", text: outbound.text, ts: Date.now() })
    worker.actor.shutdownCoordination = {
      requestId: outbound.request_id,
      status: "pending",
      kind: "shutdown_request",
      updatedAt: Date.now(),
    }

    const collectiveController = createAutonomousHolonController({ driver, vm, controlActor: root, members: members })
    collectiveController.start({ idleTimeoutMs: 999, tickIntervalMs: 77 })
    const runtimeContext = ensureVmRuntimeContext(vm)
    runtimeContext.driver = driver
    await saveAiAgentRuntimeSnapshot({ sessionDir, sessionId, vm, driver })

    expect(fs.existsSync(path.join(sessionDir, "runtime_state", "indexes", "memberRoster.json"))).toBe(true)
    expect(fs.existsSync(path.join(sessionDir, "runtime_state", "indexes", "detachedActors.json"))).toBe(true)
    expect(fs.existsSync(path.join(sessionDir, "runtime_state", "indexes", "coordinationRecords.json"))).toBe(true)

    members.__resetForTest?.()
    protocolEngine.__resetForTest?.()

    const recoveredToolRegistry = composeToolRegistry({ includeInternalOnly: true })
    const recovered = await recoverAiAgentRuntime({
      sessionDir,
      sessionId,
      llmClient: adapter,
      eventBus: new AgentEventGraph(),
      registries: {
        toolRegistry: recoveredToolRegistry,
        agentRegistry: new AgentRegistry({ code: { name: "code", description: "test", tools: "*", prompt: ["you are code"] } } as any),
      },
      callbacks: {
        buildSystemMessages: (prompts) => prompts.map((content) => ({ role: "system", content })),
      },
      actorCallbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "ok" }),
      },
    })

    expect(recovered).toBeTruthy()
    expect(recovered?.vm.controlActorKey).toBe("main")
    expect(recovered?.controlActor.peekMailbox("humanInput")).toEqual(["persist me"])
    expect(recovered?.controlActor.peekMailbox("toolResult")).toEqual([{ toolCallId: "tc-main", content: "tool result" }])
    expect(recovered?.vm.runtimeContext.driver).toBe(recovered?.driver)
    expect(getCoordinationEngine().get(recovered!.vm, outbound.request_id)?.status).toBe("pending")
    expect(recovered?.vm.sessionState.detachedActors["task-detached-1"]?.status).toBe("interrupted")
    expect(((recovered?.vm.outerCtx.metadata ?? {}) as any).__ai_driver).toBeUndefined()
    expect(((recovered?.vm.outerCtx.metadata ?? {}) as any)["__auto" + "nomy_controller"]).toBeUndefined()
    expect(recovered?.recoveryReport.sessionId).toBe(sessionId)
    expect(Array.isArray(recovered?.recoveryReport.corruptions)).toBe(true)
    expect(recovered?.vm.recovery?.report?.sessionId).toBe(sessionId)
    expect(recovered?.vm.recovery?.report?.actorTranscriptSources?.main?.source).toBe("transcript")

    const recoveredWorker = recovered?.vm.actors[worker.actorKey]
    expect(recoveredWorker?.type).toBe("delegate")
    expect(recoveredWorker?.identity?.kind).toBe("member")
    expect(recoveredWorker?.peekMailbox("memberInbox")).toEqual([{ from: "main", text: "queued ping", ts: expect.any(Number) } as any])

    const preRunView = getMemberManager().getMemberView({ vm: recovered!.vm, query: worker.memberId })
    expect(preRunView?.lastAssistantText).toBeNull()
    getMemberManager().sendMessage({ vm: recovered!.vm, to: worker.memberId, from: "main", text: "ping after recovery" })
    await recovered!.driver.tickUntilForegroundSettled({ now: Date.now(), maxTicks: 80, maxWallMs: 2000 })
    await flushMicrotasks()
    const syncedView = getMemberManager().getMemberView({ vm: recovered!.vm, query: worker.memberId })
    expect(syncedView?.lastAssistantText).toBe("ok")
    expect(typeof syncedView?.lastCompletedAt).toBe("number")
    expect((syncedView?.lastActiveAt ?? 0) >= (preRunView?.lastActiveAt ?? 0)).toBe(true)

    const teamList = JSON.parse(String(await ToolFuncRegistry.call(recoveredToolRegistry, "MemberList", recovered!.vm, recovered!.controlActor, {})))
    expect(teamList.ok).toBe(true)
    expect(Array.isArray(teamList.members)).toBe(true)
    expect(teamList.members.some((entry: any) => entry.member_id === worker.memberId)).toBe(true)
    expect(teamList.members.some((entry: any) => entry.member_id === collectiveWorker.memberId)).toBe(true)

    const detachedStatus = JSON.parse(
      String(await ToolFuncRegistry.call(recoveredToolRegistry, "DetachedActorStatus", recovered!.vm, recovered!.controlActor, { task_id: "task-detached-1" })),
    )
    expect(detachedStatus.ok).toBe(true)
    expect(detachedStatus.status).toBe("interrupted")

    const protocolStatus = JSON.parse(
      String(await ToolFuncRegistry.call(recoveredToolRegistry, "CoordinationStatus", recovered!.vm, recovered!.controlActor, { request_id: outbound.request_id })),
    )
    expect(protocolStatus.ok).toBe(true)
    expect(protocolStatus.status).toBe("pending")
    expect(protocolStatus.coordination).toBe("shutdown")
    expect(getMemberManager().listMembers({ vm: recovered!.vm }).some((entry) => entry.memberId === collectiveWorker.memberId)).toBe(true)
  })

  it("bootstraps conversation persistence from transcript-backed recovery when conversation files are absent", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = "session-conversation-bootstrap"
    const adapter = makeMockAdapter()
    const root = createActor({
      key: "main",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      messages: [
        { role: "system", content: "system" } as any,
        { role: "user", content: "persist me" } as any,
        { role: "assistant", content: "done" } as any,
      ],
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "ok" }),
      },
    })

    const vm = createVM({
      controlActorKey: root.key,
      actors: { [root.key]: root },
      callbacks: {
        buildSystemMessages: (prompts) => prompts.map((content) => ({ role: "system", content })),
      },
    })

    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: `${root.key}:${root.id}`, vm, actor: root, messages: root.messages, basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })

    await saveAiAgentRuntimeSnapshot({ sessionDir, sessionId, vm, driver })

    expect(fs.existsSync(path.join(sessionDir, "conversation", "history.index.json"))).toBe(false)

    const recovered = await recoverAiAgentRuntime({
      sessionDir,
      sessionId,
      llmClient: adapter as any,
      registries: {
        toolRegistry: composeToolRegistry({ includeInternalOnly: true }),
        agentRegistry: new AgentRegistry({ code: { name: "code", description: "test", tools: "*", prompt: ["you are code"] } } as any),
      },
      callbacks: {
        buildSystemMessages: (prompts) => prompts.map((content) => ({ role: "system", content })),
      },
    })

    expect(recovered).toBeTruthy()
    const historyIndexPath = path.join(sessionDir, "conversation", "history.index.json")
    const sessionIndexPath = path.join(sessionDir, "conversation", "session.index.json")
    const generationPath = path.join(sessionDir, "conversation", "history-generations", "main__active.json")
    expect(fs.existsSync(historyIndexPath)).toBe(true)
    expect(fs.existsSync(sessionIndexPath)).toBe(true)
    expect(fs.existsSync(generationPath)).toBe(true)

    const historyIndex = JSON.parse(fs.readFileSync(historyIndexPath, "utf-8"))
    const generation = JSON.parse(fs.readFileSync(generationPath, "utf-8"))
    expect(historyIndex.heads.main.activeGenerationId).toBe("main__active")
    expect(generation.messageCount).toBeGreaterThan(0)
    expect(Array.isArray(generation.messages)).toBe(true)
  })

  it("prefers conversation heads over stale transcript content during recovery", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = "session-conversation-first"
    const adapter = makeMockAdapter()
    const root = createActor({
      key: "main",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      messages: [
        { role: "system", content: "system" } as any,
        { role: "user", content: "old transcript input" } as any,
        { role: "assistant", content: "old transcript output" } as any,
      ],
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "ok" }),
      },
    })

    const vm = createVM({
      controlActorKey: root.key,
      actors: { [root.key]: root },
      callbacks: {
        buildSystemMessages: (prompts) => prompts.map((content) => ({ role: "system", content })),
      },
    })

    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: `${root.key}:${root.id}`, vm, actor: root, messages: root.messages, basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })

    await saveAiAgentRuntimeSnapshot({ sessionDir, sessionId, vm, driver })

    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)
    const summary = "<state_snapshot><overall_goal>conversation truth</overall_goal></state_snapshot>"
    await applyConversationCompaction({
      sessionDir,
      actorKey: "main",
      actorId: root.id,
      compressedMessages: [
        { role: "user", content: summary } as any,
        { role: "assistant", content: "Understood." } as any,
        { role: "assistant", content: "fresh tail" } as any,
      ],
      summary,
      acknowledgedSummary: "Understood.",
      repository,
    })

    const recovered = await recoverAiAgentRuntime({
      sessionDir,
      sessionId,
      llmClient: adapter as any,
      callbacks: {
        buildSystemMessages: (prompts) => prompts.map((content) => ({ role: "system", content })),
      },
    })

    expect(recovered).toBeTruthy()
    expect(recovered?.controlActor.messages.some((message: any) => String(message?.content ?? "").includes("conversation truth"))).toBe(true)
    expect(recovered?.controlActor.messages.some((message: any) => String(message?.content ?? "").includes("old transcript output"))).toBe(false)
    expect(recovered?.vm.recovery?.report?.actorTranscriptSources?.main?.source).toBe("conversation")
  })

  it("restores context-control state and keeps continue flow runtime-first after compaction-backed recovery", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = "session-context-control-recovery"
    const adapter = makeMockAdapter()
    const root = createActor({
      key: "main",
      llmClient: adapter,
      modelConfig: { model: "mock", inputLimit: 1000 },
      messages: [
        { role: "system", content: "system" } as any,
        { role: "user", content: "fix the failing test" } as any,
        { role: "assistant", content: "starting" } as any,
      ],
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "ok" }),
      },
    })
    root.workContext = {
      ...root.workContext,
      workMode: "localized_repair",
      taskPhase: "verification",
      workModeSource: "derived",
      taskPhaseSource: "tool_verification",
      workModeUpdatedAt: new Date(100).toISOString(),
      taskPhaseUpdatedAt: new Date(200).toISOString(),
      sessionId,
      lastTrigger: "tool_round",
    }
    root.continuationBaseline = {
      baselineEpoch: 2,
      lastResetReason: "manual_seed",
      latestResponseId: "resp-seeded",
      updatedAt: new Date(300).toISOString(),
    }

    const vm = createVM({
      controlActorKey: root.key,
      actors: { [root.key]: root },
      callbacks: {
        buildSystemMessages: (prompts) => prompts.map((content) => ({ role: "system", content })),
      },
    })

    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: `${root.key}:${root.id}`, vm, actor: root, messages: root.messages, basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })

    await saveAiAgentRuntimeSnapshot({ sessionDir, sessionId, vm, driver })

    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)
    const summary = "<state_snapshot><overall_goal>context control summary</overall_goal></state_snapshot>"
    await applyConversationCompaction({
      sessionDir,
      actorKey: "main",
      actorId: root.id,
      compressedMessages: [
        { role: "user", content: summary } as any,
        { role: "assistant", content: "Understood." } as any,
        { role: "assistant", content: "fresh recovered tail" } as any,
      ],
      summary,
      acknowledgedSummary: "Understood.",
      metadata: {
        workContext: root.workContext,
        policyContext: {
          workMode: "localized_repair",
          taskPhase: "verification",
          trigger: "auto_threshold",
          mode: "auto",
          tokensBefore: 900,
          tokenThreshold: 1000,
          tokenPressure: 0.9,
          baselineEpoch: 2,
          messageCount: 3,
          recentToolEvidenceCount: 1,
          hasRecentPatchRationale: true,
          hasRecentVerificationTarget: true,
        },
        policyDecision: {
          policy: "work_context_gate",
          decision: "rewrite",
          reason: "verification",
          workMode: "localized_repair",
          taskPhase: "verification",
          protectedCategories: ["verification_evidence", "patch_rationale", "coordination_state"],
          rewrittenCategories: ["low_signal_chatter", "discovery_evidence"],
          skipReason: null,
        },
        continuationBaselineBefore: root.continuationBaseline,
        continuationBaselineAfter: {
          baselineEpoch: 3,
          lastResetReason: "compaction:auto:verification",
          latestResponseId: null,
          updatedAt: new Date(400).toISOString(),
        },
      },
      repository,
    })

    const recovered = await recoverAiAgentRuntime({
      sessionDir,
      sessionId,
      llmClient: adapter as any,
      callbacks: {
        buildSystemMessages: (prompts) => prompts.map((content) => ({ role: "system", content })),
      },
      actorCallbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "ok" }),
      },
    })

    expect(recovered).toBeTruthy()
    const facade = createShellRuntimeFacade()
    const contextControl = facade.getActorContextControl({
      vm: recovered!.vm,
      actorKey: "main",
    })
    expect(contextControl.workContext?.workMode).toBe(WORK_MODES.localized_repair)
    expect(contextControl.workContext?.taskPhase).toBe(TASK_PHASES.verification)
    expect(contextControl.continuationBaseline?.baselineEpoch).toBe(3)
    expect(contextControl.continuationBaseline?.lastResetReason).toBe("compaction:auto:verification")
    expect(recovered?.controlActor.messages.some((message: any) => String(message?.content ?? "").includes("context control summary"))).toBe(true)
    expect(recovered?.controlActor.messages.some((message: any) => String(message?.content ?? "").includes("old transcript output"))).toBe(false)

    ;(recovered!.vm.registries as any).toolRegistry = composeToolRegistry({ includeInternalOnly: true })
    recovered!.controlActor.send("humanInput", "continue")
    const result = await aiAgentLoopStreaming({
      vm: recovered!.vm as any,
      actor: recovered!.controlActor as any,
      messages: recovered!.controlActor.messages as any,
    })

    expect(result.stopReason).toBe("no_tool_calls")
    expect(recovered!.controlActor.workContext.workMode).toBe(WORK_MODES.localized_repair)
    expect(recovered!.controlActor.workContext.workModeSource).toBe("inherited")
    expect(recovered!.controlActor.workContext.taskPhase).toBe(TASK_PHASES.verification)

    const runtimePromptState = (recovered!.vm.runtimeContext.conversationDomainRuntime as any)
      ?.promptStateSignal.get()?.["session-context-control-recovery::main"]
    expect(runtimePromptState?.activePromptGenerationId).toBeTruthy()
    expect(runtimePromptState?.generations.at(-1)?.metadata?.workContext?.workMode).toBe(WORK_MODES.localized_repair)
    expect(runtimePromptState?.generations.at(-1)?.metadata?.promptPlan?.workContext?.taskPhase).toBe(TASK_PHASES.verification)
  })

  it("routes recovered plan reviews back to the original member owner instead of the current control actor", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = "session-recovery-plan-review-route"
    const adapter = makeMockAdapter()
    const toolRegistry = composeToolRegistry({ includeInternalOnly: true })

    const root = createActor({
      key: "main",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      messages: [{ role: "system", content: "system" } as any],
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "ok" }),
      },
    })

    const vm = createVM({
      controlActorKey: root.key,
      actors: { [root.key]: root },
      registries: {
        toolRegistry,
        agentRegistry: new AgentRegistry({ code: { name: "code", description: "test", tools: "*", prompt: ["you are code"] } } as any),
      },
      callbacks: {
        buildSystemMessages: (prompts) => prompts.map((content) => ({ role: "system", content })),
      },
    })

    const mainFiberId = `${root.key}:${root.id}`
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: mainFiberId, vm, actor: root, messages: root.messages, basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })
    ensureVmRuntimeContext(vm).driver = driver

    const members = getMemberManager()
    members.__resetForTest?.()
    const coordinationEngine = getCoordinationEngine()
    coordinationEngine.__resetForTest?.()

    const worker = members.createMember({
      vm,
      driver,
      controlActor: root,
      name: "Alice",
      role: "worker",
      agentType: "code",
      systemPrompt: ["you are alice"],
    })

    const request = coordinationEngine.makeOutbound({
      coordination: "plan_approval",
      kind: "plan_request",
      payload: { plan: "review recovered plan" },
    })
    members.sendMessage({ vm, to: worker.memberId, from: "main", text: request.text })
    await driver.tickUntilForegroundSettled({ now: Date.now(), maxTicks: 80, maxWallMs: 2000 })
    await flushMicrotasks()
    expect(worker.actor.planApproval?.requestId).toBe(request.request_id)
    expect(worker.actor.planApproval?.status).toBe("pending")

    await saveAiAgentRuntimeSnapshot({ sessionDir, sessionId, vm, driver })

    members.__resetForTest?.()
    coordinationEngine.__resetForTest?.()

    const recoveredToolRegistry = composeToolRegistry({ includeInternalOnly: true })
    const recovered = await recoverAiAgentRuntime({
      sessionDir,
      sessionId,
      llmClient: adapter,
      eventBus: new AgentEventGraph(),
      registries: {
        toolRegistry: recoveredToolRegistry,
        agentRegistry: new AgentRegistry({ code: { name: "code", description: "test", tools: "*", prompt: ["you are code"] } } as any),
      },
      callbacks: {
        buildSystemMessages: (prompts) => prompts.map((content) => ({ role: "system", content })),
      },
      actorCallbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "ok" }),
      },
    })

    expect(recovered).toBeTruthy()

    const review = JSON.parse(
      String(await ToolFuncRegistry.call(recoveredToolRegistry, "PlanReview", recovered!.vm, recovered!.controlActor, {
        request_id: request.request_id,
        approve: true,
        feedback: "looks good after recovery",
      })),
    )
    expect(review.ok).toBe(true)
    expect(review.target_member_id).toBe(worker.memberId)

    await recovered!.driver.tickUntilForegroundSettled({ now: Date.now(), maxTicks: 80, maxWallMs: 2000 })
    await flushMicrotasks()

    const recoveredWorker = recovered!.vm.actors[worker.actorKey]
    expect(recoveredWorker?.planApproval?.requestId).toBe(request.request_id)
    expect(recoveredWorker?.planApproval?.status).toBe("approved")

    const coordinationStatus = JSON.parse(
      String(await ToolFuncRegistry.call(recoveredToolRegistry, "CoordinationStatus", recovered!.vm, recovered!.controlActor, { request_id: request.request_id })),
    )
    expect(coordinationStatus.ok).toBe(true)
    expect(coordinationStatus.status).toBe("approved")
    expect(coordinationStatus.actor_key).toBe(worker.actorKey)
  })

  it("fails fast when a recovered coordination request is visible but no owner actor can be resolved", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = "session-recovery-orphaned-plan-review"
    const adapter = makeMockAdapter()
    const toolRegistry = composeToolRegistry({ includeInternalOnly: true })

    const root = createActor({
      key: "main",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      messages: [{ role: "system", content: "system" } as any],
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "ok" }),
      },
    })

    const vm = createVM({
      controlActorKey: root.key,
      actors: { [root.key]: root },
      registries: {
        toolRegistry,
        agentRegistry: new AgentRegistry({ code: { name: "code", description: "test", tools: "*", prompt: ["you are code"] } } as any),
      },
      callbacks: {
        buildSystemMessages: (prompts) => prompts.map((content) => ({ role: "system", content })),
      },
    })

    const mainFiberId = `${root.key}:${root.id}`
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: mainFiberId, vm, actor: root, messages: root.messages, basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })
    ensureVmRuntimeContext(vm).driver = driver

    const coordinationEngine = getCoordinationEngine()
    coordinationEngine.__resetForTest?.()

    const request = coordinationEngine.makeOutbound({
      coordination: "plan_approval",
      kind: "plan_request",
      payload: { plan: "orphaned request" },
    })
    coordinationEngine.ingestMemberInbox(vm, { from: "ghost-worker", text: request.text, ts: Date.now() })

    await saveAiAgentRuntimeSnapshot({ sessionDir, sessionId, vm, driver })

    coordinationEngine.__resetForTest?.()

    const recoveredToolRegistry = composeToolRegistry({ includeInternalOnly: true })
    const recovered = await recoverAiAgentRuntime({
      sessionDir,
      sessionId,
      llmClient: adapter,
      eventBus: new AgentEventGraph(),
      registries: {
        toolRegistry: recoveredToolRegistry,
        agentRegistry: new AgentRegistry({ code: { name: "code", description: "test", tools: "*", prompt: ["you are code"] } } as any),
      },
      callbacks: {
        buildSystemMessages: (prompts) => prompts.map((content) => ({ role: "system", content })),
      },
      actorCallbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "ok" }),
      },
    })

    const before = JSON.parse(
      String(await ToolFuncRegistry.call(recoveredToolRegistry, "CoordinationStatus", recovered!.vm, recovered!.controlActor, { request_id: request.request_id })),
    )
    expect(before.ok).toBe(true)
    expect(before.status).toBe("pending")
    expect(before.actor_key).toBeNull()
    expect(before.truth_source).toBe("legacy_cache")
    expect(before.degraded).toBe(true)
    expect(before.owner_state).toBe("unowned")

    const review = JSON.parse(
      String(await ToolFuncRegistry.call(recoveredToolRegistry, "PlanReview", recovered!.vm, recovered!.controlActor, {
        request_id: request.request_id,
        approve: true,
        feedback: "should fail without owner",
      })),
    )
    expect(review.ok).toBe(false)
    expect(review.error).toBe("coordination_owner_not_found")
    expect(review.request_id).toBe(request.request_id)

    const after = JSON.parse(
      String(await ToolFuncRegistry.call(recoveredToolRegistry, "CoordinationStatus", recovered!.vm, recovered!.controlActor, { request_id: request.request_id })),
    )
    expect(after.ok).toBe(true)
    expect(after.status).toBe("pending")
    expect(after.actor_key).toBeNull()
    expect(after.truth_source).toBe("legacy_cache")
    expect(after.degraded).toBe(true)
    expect(after.owner_state).toBe("unowned")
  })

  it("rebuilds recovered member/detached/coordination/collective state even when derived indexes are missing", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = "session-recovery-no-indexes"
    const adapter = makeMockAdapter()
    const eventBus = new AgentEventGraph()
    const toolRegistry = composeToolRegistry({ includeInternalOnly: true })

    const root = createActor({
      key: "main",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      messages: [{ role: "system", content: "system" } as any],
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "ok" }),
      },
    })

    const vm = createVM({
      controlActorKey: root.key,
      actors: { [root.key]: root },
      eventBus,
      registries: {
        toolRegistry,
        agentRegistry: new AgentRegistry({ code: { name: "code", description: "test", tools: "*", prompt: ["you are code"] } } as any),
      },
      callbacks: {
        buildSystemMessages: (prompts) => prompts.map((content) => ({ role: "system", content })),
      },
    })

    const mainFiberId = `${root.key}:${root.id}`
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: mainFiberId, vm, actor: root, messages: root.messages, basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })

    const members = getMemberManager()
    members.__resetForTest?.()
    const protocolEngine = getCoordinationEngine()
    protocolEngine.__resetForTest?.()

    const worker = members.createMember({
      vm,
      driver,
      controlActor: root,
      name: "Alice",
      role: "worker",
      agentType: "code",
      systemPrompt: ["you are alice"],
    })

    const detachedActor = createActor({
      key: "detached:child",
      type: "detached" as any,
      parentKey: root.key,
      llmClient: adapter,
      modelConfig: { model: "mock" },
      messages: [{ role: "user", content: "run detached" } as any],
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "ok" }),
      },
    })
    vm.actors[detachedActor.key] = detachedActor
    if (!vm.actorRuntime.has(detachedActor.key)) {
      vm.actorRuntime.register(detachedActor.key, detachedActor)
    }

    const detachedFiberId = `${detachedActor.key}:${detachedActor.id}`
    driver.spawnFiber({
      fiberId: detachedFiberId,
      vm,
      actor: detachedActor,
      messages: detachedActor.messages,
      basePriority: 1,
      parentFiberId: mainFiberId,
      kind: "delegate",
      lane: "detached",
      workload: "detached_delegate_task" as any,
      onDone: { parentFiberId: mainFiberId, mode: "detached", taskId: "task-detached-2", taskKind: "delegate" },
    })
    driver.suspendFiber(detachedFiberId, Date.now(), "external")
    getDetachedActorRegistry(vm).create({
      taskId: "task-detached-2",
      kind: "delegate",
      status: "suspended",
      parentFiberId: mainFiberId,
      childFiberId: detachedFiberId,
      childActorKey: detachedActor.key,
      childActorId: detachedActor.id,
      toolCallId: "tc-detached-2",
    })

    const outbound = protocolEngine.makeOutbound({ coordination: "shutdown", kind: "shutdown_request", payload: { reason: "persist" } })
    protocolEngine.ingestMemberInbox(vm, { from: "main", text: outbound.text, ts: Date.now() })
    worker.actor.shutdownCoordination = {
      requestId: outbound.request_id,
      status: "pending",
      kind: "shutdown_request",
      updatedAt: Date.now(),
    }

    const collectiveController = createAutonomousHolonController({ driver, vm, controlActor: root, members: members })
    collectiveController.start({ idleTimeoutMs: 500, tickIntervalMs: 55 })
    const runtimeContext2 = ensureVmRuntimeContext(vm)
    runtimeContext2.driver = driver

    await saveAiAgentRuntimeSnapshot({ sessionDir, sessionId, vm, driver })
    fs.rmSync(path.join(sessionDir, "runtime_state", "indexes"), { recursive: true, force: true })

    members.__resetForTest?.()
    protocolEngine.__resetForTest?.()

    const recoveredToolRegistry = composeToolRegistry({ includeInternalOnly: true })
    const recovered = await recoverAiAgentRuntime({
      sessionDir,
      sessionId,
      llmClient: adapter,
      eventBus: new AgentEventGraph(),
      registries: {
        toolRegistry: recoveredToolRegistry,
        agentRegistry: new AgentRegistry({ code: { name: "code", description: "test", tools: "*", prompt: ["you are code"] } } as any),
      },
      callbacks: {
        buildSystemMessages: (prompts) => prompts.map((content) => ({ role: "system", content })),
      },
      actorCallbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "ok" }),
      },
    })

    expect(recovered).toBeTruthy()

    const teamList = JSON.parse(String(await ToolFuncRegistry.call(recoveredToolRegistry, "MemberList", recovered!.vm, recovered!.controlActor, {})))
    expect(teamList.ok).toBe(true)
    expect(teamList.members.some((entry: any) => entry.member_id === worker.memberId)).toBe(true)

    const detachedStatus = JSON.parse(
      String(await ToolFuncRegistry.call(recoveredToolRegistry, "DetachedActorStatus", recovered!.vm, recovered!.controlActor, { task_id: "task-detached-2" })),
    )
    expect(detachedStatus.ok).toBe(true)
    expect(detachedStatus.status).toBe("interrupted")

    const protocolStatus = JSON.parse(
      String(await ToolFuncRegistry.call(recoveredToolRegistry, "CoordinationStatus", recovered!.vm, recovered!.controlActor, { request_id: outbound.request_id })),
    )
    expect(protocolStatus.ok).toBe(true)
    expect(protocolStatus.status).toBe("pending")
  })

  it("keeps recovered member/coordination/collective state isolated per session", async () => {
    const adapter = makeMockAdapter()

    const setupSession = async (params: {
      sessionDir: string
      sessionId: string
      primaryKey: string
      workerName: string
      collectiveWorkerName: string
      tickIntervalMs: number
    }) => {
      const root = createActor({
        key: params.primaryKey,
        llmClient: adapter,
        modelConfig: { model: "mock" },
        messages: [{ role: "system", content: "system" } as any],
        callbacks: {
          buildToolset: () => [],
          processStream: async () => ({ role: "assistant", content: "ok" }),
        },
      })

      const vm = createVM({
        controlActorKey: root.key,
        actors: { [root.key]: root },
        eventBus: new AgentEventGraph(),
        registries: {
          toolRegistry: composeToolRegistry({ includeInternalOnly: true }),
          agentRegistry: new AgentRegistry({ code: { name: "code", description: "test", tools: "*", prompt: ["you are code"] } } as any),
        },
        callbacks: {
          buildSystemMessages: (prompts) => prompts.map((content) => ({ role: "system", content })),
        },
      })

      const driver = createAiAgentOrchestratorDriverWithCooperative({
        fibers: [{ fiberId: `${root.key}:${root.id}`, vm, actor: root, messages: root.messages, basePriority: 1 }],
        options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
      })

      const members = getMemberManager()
      const worker = members.createMember({
        vm,
        driver,
        controlActor: root,
        name: params.workerName,
        role: "worker",
        agentType: "code",
        systemPrompt: [`you are ${params.workerName}`],
      })
      const collectiveWorker = members.createMember({
        vm,
        driver,
        controlActor: root,
        name: params.collectiveWorkerName,
        role: "worker",
        agentType: "code",
        systemPrompt: [`you are ${params.collectiveWorkerName}`],
        lane: "autonomous_holon",
      })

      const protocolEngine = getCoordinationEngine()
      const outbound = protocolEngine.makeOutbound({ coordination: "shutdown", kind: "shutdown_request", payload: { reason: params.sessionId } })
      protocolEngine.ingestMemberInbox(vm, { from: params.primaryKey, text: outbound.text, ts: Date.now() })
      worker.actor.shutdownCoordination = {
        requestId: outbound.request_id,
        status: "pending",
        kind: "shutdown_request",
        updatedAt: Date.now(),
      }

      const collectiveController = createAutonomousHolonController({ driver, vm, controlActor: root, members: members })
      collectiveController.start({ idleTimeoutMs: 999, tickIntervalMs: params.tickIntervalMs })
      const runtimeContext = ensureVmRuntimeContext(vm)
      runtimeContext.driver = driver

      await saveAiAgentRuntimeSnapshot({ sessionDir: params.sessionDir, sessionId: params.sessionId, vm, driver })
      return { requestId: outbound.request_id, worker, collectiveWorker }
    }

    const sessionADir = makeTempSessionDir()
    const sessionBDir = makeTempSessionDir()
    const savedA = await setupSession({
      sessionDir: sessionADir,
      sessionId: "session-A",
      primaryKey: "main-A",
      workerName: "Alice-A",
      collectiveWorkerName: "Collective-A",
      tickIntervalMs: 31,
    })
    const savedB = await setupSession({
      sessionDir: sessionBDir,
      sessionId: "session-B",
      primaryKey: "main-B",
      workerName: "Alice-B",
      collectiveWorkerName: "Collective-B",
      tickIntervalMs: 47,
    })

    const recoverSession = async (sessionDir: string, sessionId: string) => {
      const toolRegistry = composeToolRegistry({ includeInternalOnly: true })
      return await recoverAiAgentRuntime({
        sessionDir,
        sessionId,
        llmClient: adapter,
        eventBus: new AgentEventGraph(),
        registries: {
          toolRegistry,
          agentRegistry: new AgentRegistry({ code: { name: "code", description: "test", tools: "*", prompt: ["you are code"] } } as any),
        },
        callbacks: {
          buildSystemMessages: (prompts) => prompts.map((content) => ({ role: "system", content })),
        },
        actorCallbacks: {
          buildToolset: () => [],
          processStream: async () => ({ role: "assistant", content: "ok" }),
        },
      })
    }

    const recoveredA = await recoverSession(sessionADir, "session-A")
    const recoveredB = await recoverSession(sessionBDir, "session-B")

    expect(recoveredA).toBeTruthy()
    expect(recoveredB).toBeTruthy()

    const teamListA = JSON.parse(String(await ToolFuncRegistry.call(recoveredA!.vm.registries.toolRegistry!, "MemberList", recoveredA!.vm, recoveredA!.controlActor, {})))
    const teamListB = JSON.parse(String(await ToolFuncRegistry.call(recoveredB!.vm.registries.toolRegistry!, "MemberList", recoveredB!.vm, recoveredB!.controlActor, {})))
    expect(teamListA.members.map((entry: any) => entry.name)).toContain(savedA.worker.name)
    expect(teamListA.members.map((entry: any) => entry.name)).toContain(savedA.collectiveWorker.name)
    expect(teamListA.members.map((entry: any) => entry.name)).not.toContain(savedB.worker.name)
    expect(teamListB.members.map((entry: any) => entry.name)).toContain(savedB.worker.name)
    expect(teamListB.members.map((entry: any) => entry.name)).toContain(savedB.collectiveWorker.name)
    expect(teamListB.members.map((entry: any) => entry.name)).not.toContain(savedA.worker.name)

    const protocolAOnA = JSON.parse(
      String(await ToolFuncRegistry.call(recoveredA!.vm.registries.toolRegistry!, "CoordinationStatus", recoveredA!.vm, recoveredA!.controlActor, { request_id: savedA.requestId })),
    )
    const protocolAOnB = JSON.parse(
      String(await ToolFuncRegistry.call(recoveredB!.vm.registries.toolRegistry!, "CoordinationStatus", recoveredB!.vm, recoveredB!.controlActor, { request_id: savedA.requestId })),
    )
    expect(protocolAOnA.ok).toBe(true)
    expect(protocolAOnA.status).toBe("pending")
    expect(protocolAOnB.ok).toBe(false)

    expect(getMemberManager().listMembers({ vm: recoveredA!.vm }).filter((entry) => entry.lane === "autonomous_holon").map((entry) => entry.name)).toEqual([savedA.collectiveWorker.name])
    expect(getMemberManager().listMembers({ vm: recoveredB!.vm }).filter((entry) => entry.lane === "autonomous_holon").map((entry) => entry.name)).toEqual([savedB.collectiveWorker.name])
  })

  it("restores terminal detached work from VM snapshot even when indexes are missing", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = "session-terminal-detached"
    const adapter = makeMockAdapter()
    const root = createActor({
      key: "main",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "ok" }),
      },
    })

    const vm = createVM({
      controlActorKey: root.key,
      actors: { [root.key]: root },
      eventBus: new AgentEventGraph(),
      registries: {
        toolRegistry: composeToolRegistry({ includeInternalOnly: true }),
        agentRegistry: new AgentRegistry({ code: { name: "code", description: "test", tools: "*", prompt: ["you are code"] } } as any),
      },
    })
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: `${root.key}:${root.id}`, vm, actor: root, messages: root.messages, basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })
    const members = getMemberManager()
    const collectiveController = createAutonomousHolonController({ driver, vm, controlActor: root, members })
    const runtimeContext = ensureVmRuntimeContext(vm)
    runtimeContext.driver = driver

    getDetachedActorRegistry(vm).restoreAll([
      { taskId: "task-completed", kind: "delegate", status: "completed", createdAt: 1, updatedAt: 2, outputText: "done" },
      { taskId: "task-failed", kind: "bash", status: "failed", createdAt: 3, updatedAt: 4, error: "boom" },
      { taskId: "task-cancelled", kind: "tool_call", status: "cancelled", createdAt: 5, updatedAt: 6 },
    ])

    await saveAiAgentRuntimeSnapshot({ sessionDir, sessionId, vm, driver })
    fs.rmSync(path.join(sessionDir, "runtime_state", "indexes"), { recursive: true, force: true })

    const recoveredToolRegistry = composeToolRegistry({ includeInternalOnly: true })
    const recovered = await recoverAiAgentRuntime({
      sessionDir,
      sessionId,
      llmClient: adapter,
      eventBus: new AgentEventGraph(),
      registries: {
        toolRegistry: recoveredToolRegistry,
        agentRegistry: new AgentRegistry({ code: { name: "code", description: "test", tools: "*", prompt: ["you are code"] } } as any),
      },
      actorCallbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "ok" }),
      },
    })

    expect(recovered).toBeTruthy()
    const completed = JSON.parse(String(await ToolFuncRegistry.call(recoveredToolRegistry, "DetachedActorStatus", recovered!.vm, recovered!.controlActor, { task_id: "task-completed" })))
    const failed = JSON.parse(String(await ToolFuncRegistry.call(recoveredToolRegistry, "DetachedActorStatus", recovered!.vm, recovered!.controlActor, { task_id: "task-failed" })))
    const cancelled = JSON.parse(String(await ToolFuncRegistry.call(recoveredToolRegistry, "DetachedActorStatus", recovered!.vm, recovered!.controlActor, { task_id: "task-cancelled" })))

    expect(completed).toMatchObject({ ok: true, status: "completed", output_text: "done" })
    expect(failed).toMatchObject({ ok: true, status: "failed", error: "boom" })
    expect(cancelled).toMatchObject({ ok: true, status: "cancelled" })
  })

  it("does not revive terminal detached work from stale indexes when VM snapshot is authoritative", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = "session-stale-detached-index"
    const adapter = makeMockAdapter()
    const root = createActor({
      key: "main",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "ok" }),
      },
    })

    const toolRegistry = composeToolRegistry({ includeInternalOnly: true })
    const vm = createVM({
      controlActorKey: root.key,
      actors: { [root.key]: root },
      eventBus: new AgentEventGraph(),
      registries: {
        toolRegistry,
        agentRegistry: new AgentRegistry({ code: { name: "code", description: "test", tools: "*", prompt: ["you are code"] } } as any),
      },
    })
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: `${root.key}:${root.id}`, vm, actor: root, messages: root.messages, basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })
    const members = getMemberManager()
    const collectiveController = createAutonomousHolonController({ driver, vm, controlActor: root, members })
    const runtimeContext = ensureVmRuntimeContext(vm)
    runtimeContext.driver = driver

    getDetachedActorRegistry(vm).restoreAll([
      { taskId: "task-authoritative", kind: "delegate", status: "completed", createdAt: 10, updatedAt: 11, outputText: "fresh" },
    ])

    await saveAiAgentRuntimeSnapshot({ sessionDir, sessionId, vm, driver })

    const staleIndexPath = path.join(sessionDir, "runtime_state", "indexes", "detachedActors.json")
    const staleIndex = JSON.parse(fs.readFileSync(staleIndexPath, "utf8"))
    staleIndex.tasks.push({
      taskId: "task-stale-only",
      workloadKind: "delegate",
      status: "completed",
      summary: "stale only",
      startedAt: 1,
      endedAt: 2,
    })
    fs.writeFileSync(staleIndexPath, `${JSON.stringify(staleIndex, null, 2)}\n`, "utf8")

    const recoveredToolRegistry = composeToolRegistry({ includeInternalOnly: true })
    const recovered = await recoverAiAgentRuntime({
      sessionDir,
      sessionId,
      llmClient: adapter,
      eventBus: new AgentEventGraph(),
      registries: {
        toolRegistry: recoveredToolRegistry,
        agentRegistry: new AgentRegistry({ code: { name: "code", description: "test", tools: "*", prompt: ["you are code"] } } as any),
      },
      actorCallbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "ok" }),
      },
    })

    expect(recovered).toBeTruthy()
    const authoritative = JSON.parse(String(await ToolFuncRegistry.call(recoveredToolRegistry, "DetachedActorStatus", recovered!.vm, recovered!.controlActor, { task_id: "task-authoritative" })))
    const stale = JSON.parse(String(await ToolFuncRegistry.call(recoveredToolRegistry, "DetachedActorStatus", recovered!.vm, recovered!.controlActor, { task_id: "task-stale-only" })))

    expect(authoritative).toMatchObject({ ok: true, status: "completed", output_text: "fresh" })
    expect(stale.ok).toBe(false)
    expect(recovered!.vm.sessionState.detachedActors["task-stale-only"]).toBeUndefined()
  })

  it("prefers actor-owned autonomous holon task ownership over stale vm and index mirrors during recovery", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = "session-collective-ownership-authoritative"
    const adapter = makeMockAdapter()
    const toolRegistry = composeToolRegistry({ includeInternalOnly: true })

    const root = createActor({
      key: "main",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async (_vm, actor) => (
          actor.identity?.kind === "member"
            ? { role: "assistant", content: `${actor.identity.name} done` }
            : { role: "assistant", content: "ok" }
        ),
      },
    })

    const vm = createVM({
      controlActorKey: root.key,
      actors: { [root.key]: root },
      eventBus: new AgentEventGraph(),
      registries: {
        toolRegistry,
        agentRegistry: new AgentRegistry({ code: { name: "code", description: "test", tools: "*", prompt: ["you are code"] } } as any),
      },
    })
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: `${root.key}:${root.id}`, vm, actor: root, messages: root.messages, basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })
    const members = getMemberManager()
    const collectiveController = createAutonomousHolonController({ driver, vm, controlActor: root, members })
    const runtimeContext = ensureVmRuntimeContext(vm)
    runtimeContext.driver = driver

    const member = JSON.parse(String(await ToolFuncRegistry.call(toolRegistry, "MemberCreate", vm, root, {
      name: "alice",
      agent_type: "code",
      prompt: "",
    })))
    const holon = JSON.parse(String(await ToolFuncRegistry.call(toolRegistry, "HolonCreate", vm, root, {
      governance: "autonomous",
      name: "research",
    })))
    await ToolFuncRegistry.call(toolRegistry, "HolonAdd", vm, root, { holon: "research", member: "alice" })
    const dispatched = JSON.parse(String(await ToolFuncRegistry.call(toolRegistry, "HolonAssign", vm, root, {
      target: "research",
      mode: "final",
      content: "scan the current project",
    })))

    expect(dispatched.ok).toBe(true)
    await saveAiAgentRuntimeSnapshot({ sessionDir, sessionId, vm, driver })

    const vmPath = path.join(sessionDir, "runtime_state", "vm.json")
    const vmSnapshot = JSON.parse(fs.readFileSync(vmPath, "utf8"))
    vmSnapshot.collective = {
      taskOwnership: [{ taskId: dispatched.task_id, ownerActorKey: "member:stale-owner" }],
    }
    fs.writeFileSync(vmPath, `${JSON.stringify(vmSnapshot, null, 2)}\n`, "utf8")

    const recoveredToolRegistry = composeToolRegistry({ includeInternalOnly: true })
    const recovered = await recoverAiAgentRuntime({
      sessionDir,
      sessionId,
      llmClient: adapter,
      eventBus: new AgentEventGraph(),
      registries: {
        toolRegistry: recoveredToolRegistry,
        agentRegistry: new AgentRegistry({ code: { name: "code", description: "test", tools: "*", prompt: ["you are code"] } } as any),
      },
      actorCallbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "ok" }),
      },
    })

    expect(recovered).toBeTruthy()
    expect(recovered!.vm.actors[`holon:${holon.holon_id}`]?.holonState?.governance === "autonomous"
      ? recovered!.vm.actors[`holon:${holon.holon_id}`]?.holonState.taskOwnership?.[dispatched.task_id]
      : undefined).toBe(member.actor_key)
  })

  it("resumes questionnaire flow after snapshot recovery", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = "session-questionnaire-recovery"

    const llmAdapter = {
      type: "openai" as const,
      async createStream(params: any) {
        const isParser = Array.isArray(params?.messages) && params.messages[0]?.role === "system"
        async function* stream() {
          if (isParser) {
            yield {
              choices: [
                {
                  delta: {
                    content: JSON.stringify({ status: "ok", answers: { q1: "hello" }, errors: [] }),
                  },
                },
              ],
            } as any
            return
          }
          yield { ok: true } as any
        }
        return { stream: stream() }
      },
    }

    const toolRegistry = new ToolFuncRegistry()
    const questionnaireTool: ToolDef<any, string, Record<string, unknown>> = {
      schema: {
        type: "function",
        function: { name: "Questionnaire", description: "test", parameters: { type: "object" } },
      },
      briefPromptXnl: `<tool name="Questionnaire" />`,
      run: async (runtime: any, input: any) => {
        const toolCallId = String(runtime?.toolCallId ?? "")
        const questionnaireId = typeof input?.questionnaireId === "string" ? input.questionnaireId : toolCallId ? `q-${toolCallId}` : `q-${Date.now()}`
        const payload: any = {
          questionnaireId,
          toolCallId: toolCallId || questionnaireId,
          kind: input?.kind ?? "freeform",
          title: input?.title,
          intro: input?.intro,
          suspendPolicy: input?.suspendPolicy === "continue_others" ? "continue_others" : "pause_all",
          questions: Array.isArray(input?.questions) && input.questions.length ? input.questions : [{ id: "q1", prompt: "User input required", type: "text" }],
        }
        runtime.actor.pendingQuestionnaires[questionnaireId] = payload
        runtime.actor.send("control", {
          kind: "questionnaire_pending",
          toolCallId: payload.toolCallId,
          questionnaireId: payload.questionnaireId,
          suspendPolicy: payload.suspendPolicy,
        })
        runtime.vm.eventBus?.emitQuestionnaireRequest?.({ key: runtime.actor.key, id: runtime.actor.id }, payload)
        return ""
      },
    }
    ToolFuncRegistry.register(toolRegistry, questionnaireTool as any)

    const actor = createActor({
      key: "main",
      llmClient: llmAdapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [questionnaireTool.schema],
        processStream: async () => ({
          role: "assistant",
          tool_calls: [
            {
              id: "tc-1",
              function: {
                name: "Questionnaire",
                arguments: JSON.stringify({
                  questionnaireId: "q-tc-1",
                  kind: "freeform",
                  suspendPolicy: "continue_others",
                  questions: [{ id: "q1", prompt: "Answer", type: "text", required: true }],
                }),
              },
            },
          ],
        }),
      },
    })

    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      eventBus: new AgentEventGraph(),
      registries: { toolRegistry },
    })
    const fiberId = `${actor.key}:${actor.id}`
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId, vm, actor, messages: [], basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })
    const members = getMemberManager()
    const collectiveController = createAutonomousHolonController({ driver, vm, controlActor: actor, members })
    const runtimeContext = ensureVmRuntimeContext(vm)
    runtimeContext.driver = driver

    actor.send("humanInput", "start")
    driver.resumeFiber(fiberId, Date.now())
    await driver.tickUntilForegroundSettled({ now: Date.now(), maxTicks: 80, maxWallMs: 2000 })
    await flushMicrotasks()

    const waitingBeforeSave = driver.getState().fibers[fiberId]
    expect(waitingBeforeSave?.waitingReason).toBe("human_answer")
    expect(actor.pendingQuestionnaires["q-tc-1"]).toBeTruthy()

    await saveAiAgentRuntimeSnapshot({ sessionDir, sessionId, vm, driver })

    const recovered = await recoverAiAgentRuntime({
      sessionDir,
      sessionId,
      llmClient: llmAdapter,
      eventBus: new AgentEventGraph(),
      registries: { toolRegistry },
      actorCallbacks: {
        buildToolset: () => [questionnaireTool.schema],
        processStream: async () => ({
          role: "assistant",
          tool_calls: [
            {
              id: "tc-1",
              function: {
                name: "Questionnaire",
                arguments: JSON.stringify({ questionnaireId: "q-tc-1" }),
              },
            },
          ],
        }),
      },
    })

    expect(recovered).toBeTruthy()
    expect(recovered!.controlActor.pendingQuestionnaires["q-tc-1"]).toBeTruthy()

    recovered!.controlActor.send("toolResult", { toolCallId: "tc-1", questionnaireId: "q-tc-1", content: "hello" })
    recovered!.driver.resumeFiber(fiberId, Date.now())
    await recovered!.driver.tickUntilForegroundSettled({ now: Date.now(), maxTicks: 80, maxWallMs: 2000 })
    await flushMicrotasks()

    const toolMsg = recovered!.controlActor.messages.find((message: any) => message?.role === "tool" && message?.tool_call_id === "tc-1")
    expect(toolMsg).toBeTruthy()
    expect(String(toolMsg!.content)).toContain("\"status\":\"ok\"")
  })

  it("persists autonomous and leader-led holons through snapshot recovery", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = "session-recovery-organizations"
    const adapter = makeMockAdapter()
    const toolRegistry = composeToolRegistry({ includeInternalOnly: true })
    const root = createActor({
      key: "main",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "ok" }),
      },
    })

    const vm = createVM({
      controlActorKey: root.key,
      actors: { [root.key]: root },
      eventBus: new AgentEventGraph(),
      registries: {
        toolRegistry,
        agentRegistry: new AgentRegistry({ code: { name: "code", description: "test", tools: "*", prompt: ["you are code"] } } as any),
      },
    })

    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: `${root.key}:${root.id}`, vm, actor: root, messages: [{ role: "user", content: "hi" }], basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })
    const members = getMemberManager()
    members.__resetForTest?.()
    const controller = createAutonomousHolonController({ driver, vm, controlActor: root, members })
    const runtimeContext = ensureVmRuntimeContext(vm)
    runtimeContext.driver = driver

    const member = members.createMember({
      vm,
      driver,
      controlActor: root,
      name: "alice",
      role: "worker",
      agentType: "code",
      systemPrompt: ["you are alice"],
    })

    const autonomousHolon = JSON.parse(String(await ToolFuncRegistry.call(toolRegistry, "HolonCreate", vm, root, {
      governance: "autonomous",
      name: "research",
    })))
    await ToolFuncRegistry.call(toolRegistry, "HolonAdd", vm, root, { holon: "research", member: "alice" })
    await ToolFuncRegistry.call(toolRegistry, "ActorWatch", vm, root, { target: "holon:research" })

    const leaderLedHolon = JSON.parse(String(await ToolFuncRegistry.call(toolRegistry, "HolonCreate", vm, root, {
      governance: "leader_led",
      name: "alpha",
    })))
    await ToolFuncRegistry.call(toolRegistry, "HolonAdd", vm, root, { holon: "alpha", member: "alice" })
    await ToolFuncRegistry.call(toolRegistry, "HolonAppoint", vm, root, { holon: "alpha", member: "alice" })
    await ToolFuncRegistry.call(toolRegistry, "ActorWatch", vm, root, { target: "holon:alpha" })

    await saveAiAgentRuntimeSnapshot({
      sessionDir,
      sessionId,
      vm,
      driver,
    })

    const recoveredToolRegistry = composeToolRegistry({ includeInternalOnly: true })
    const recovered = await recoverAiAgentRuntime({
      sessionDir,
      sessionId,
      llmClient: adapter as any,
      registries: {
        toolRegistry: recoveredToolRegistry,
        agentRegistry: new AgentRegistry({ code: { name: "code", description: "test", tools: "*", prompt: ["you are code"] } } as any),
      },
      actorCallbacks: {
        buildToolset: () => [],
        processStream: async () => ({ role: "assistant", content: "ok" }),
      },
    })

    expect(recovered).toBeTruthy()

    const collectiveStatus = JSON.parse(String(await ToolFuncRegistry.call(recoveredToolRegistry, "HolonStatus", recovered!.vm, recovered!.controlActor, { target: "research" })))
    expect(collectiveStatus.ok).toBe(true)
    expect(collectiveStatus.governance).toBe("autonomous")
    expect(collectiveStatus.member_ids).toContain(member.memberId)
    const collectiveActorStatus = JSON.parse(String(await ToolFuncRegistry.call(recoveredToolRegistry, "ActorStatus", recovered!.vm, recovered!.controlActor, { target: `holon:${autonomousHolon.holon_id}` })))
    expect(collectiveActorStatus.watch_state).toBe("watched")

    const formationStatus = JSON.parse(String(await ToolFuncRegistry.call(recoveredToolRegistry, "HolonStatus", recovered!.vm, recovered!.controlActor, { target: "alpha" })))
    expect(formationStatus.ok).toBe(true)
    expect(formationStatus.governance).toBe("leader_led")
    expect(formationStatus.member_ids).toContain(member.memberId)
    expect(formationStatus.leader_member_id).toBe(member.memberId)
    const formationActorStatus = JSON.parse(String(await ToolFuncRegistry.call(recoveredToolRegistry, "ActorStatus", recovered!.vm, recovered!.controlActor, { target: `holon:${leaderLedHolon.holon_id}` })))
    expect(formationActorStatus.watch_state).toBe("watched")
  })

})
