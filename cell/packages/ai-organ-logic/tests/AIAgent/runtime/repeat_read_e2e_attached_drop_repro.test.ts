import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { AgentEventGraph, DomainRuntimeHistoryGraph } from "@cell/ai-core-logic"
import type { AnyToolDef } from "@cell/ai-core-contract/types"
import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent/ToolFuncComposer"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import {
  getConversationActorRawStateFromVm,
  materializeConversationRuntimeMessagesFromVm,
} from "@cell/ai-organ-logic/conversation/ConversationDomainRuntime"
import { ensureVmToolCallDomain, getVmToolCallDomain } from "@cell/ai-organ-logic/runtime/ToolCallDomainRuntime"
import { processRuntimeIngressStream } from "@cell/ai-organ-logic/runtime/ShellRuntimeSupport"
import { recoverOrCreateShellRuntime } from "@cell/ai-organ-logic/runtime/ShellRuntimeBootstrap"
import { createShellRuntimeFacade } from "@cell/ai-organ-logic"
import { createKernelRuntimeSupportDescriptor } from "@cell/mod-ai-kernel"

/**
 * FAITHFUL END-TO-END "within-turn repeat-read non-convergence" PROBE
 * ===================================================================
 * This drives the REAL production turn machinery — `recoverOrCreateShellRuntime`
 * (same single-`eventBus` shape as TerminalRuntime.ts:744-801), the real
 * `processRuntimeIngressStream` semantic stream pipeline
 * (ShellRuntimeSupport.ts:206-251), the real cooperative driver, and the real
 * `AiAgentRuntimeCoordinator.runInteractiveTurn` turn loop — with a fake LLM
 * that issues `read_file` tool calls through the LIVE OpenAI stream path,
 * looping N sequential tool ops in ONE turn. This is the shape of the real
 * 75-tool-call frozen turn (mirrored: recover from a real snapshot,
 * `restoredFromSnapshot:true`, then a mandatory-continuation tool loop).
 *
 * It is a CHARACTERIZATION test that PASSES on current code by asserting the
 * MEASURED behavior. The instrumentation per op (graph attached? bus done?
 * main__active messageCount before/after? where each writer emits?) is the
 * load-bearing output: it pins the EXACT trigger by elimination.
 *
 * ======================= THE MEASURED DETERMINATION =======================
 * Driving the real recover + cooperative tool loop through ONE shared bus, with
 * a per-op sample taken AT each live `semantic_tool_call_result` (plus a fresh
 * SIBLING MessageHistoryGraph on the same bus as the T2 probe). MEASURED on
 * current code (N=3 read_file ops, base messageCount=4):
 *
 *   stage                          attached(consumers)  busDone  messageCount
 *   post-recovery (instant)        0                    false    4   (line 317)
 *   op#1 (at tool_call_result)     >0                   false    5   sibling+ ✓
 *   op#2 (at tool_call_result)     >0                   false    7   sibling+ ✓
 *   op#3 (at tool_call_result)     >0                   false    9   sibling+ ✓
 *   after the whole turn           >0                   false    12  (=4 + 2*3 + 2)
 *
 * The resident `MessageHistoryGraph` ATTACHES during the cooperative loop
 * (ensureVmMessageHistoryGraphAttached, AiAgentExecutor.ts:4159) AND the live
 * commits LAND at EVERY op: messageCount is already > base by op#1 and grows
 * monotonically; every assistant message AND every tool result is committed into
 * the conversation domain. The fresh sibling on the same bus ALSO commits every
 * op (so the bus events are well-formed and a fresh attached graph commits them).
 * So through this faithful harness:
 *
 *  - T1 (emit-before-attach: events emitted while consumers.size===0) is the
 *    prior repro's hole, NOT the real path — here the graph IS a consumer.
 *  - T2 (the attached graph's projection is completed/disposed post-recovery, so
 *    commits drop even though attached) is REFUTED. If the projection were
 *    completed/disposed, `MessageHistoryGraph.consumeSemanticEvent`
 *    (cell/packages/ai-core-logic/src/stream/MessageHistoryGraph.ts:338-341:
 *    `if (this.disposed || this.projection.getState().completed) return`) would
 *    early-return and NOTHING would commit — but commits DO land. Moreover the
 *    resident graph's `dispose()`/`complete()` is reachable ONLY via the detach
 *    returned by `attachMessageHistory` (AiAgentExecutor.ts:2694-2700), invoked
 *    exclusively at vm teardown — never inside a live turn — and the recovered
 *    `runtimeContext` is a FRESH in-memory facet (createEmptyVmRuntimeContext,
 *    runtime.ts:114) so it carries NO stale `persistentMessageHistoryGraphDetach`
 *    (proof: consumers===0 immediately post-recovery). T2 is mechanically
 *    impossible on a single coherent recovered vm during a turn.
 *
 * ===================== THE REAL DIFFERENTIATOR (measured) =====================
 * Because the faithful single-bus recover+drive harness COMMITS, the real
 * session's freeze is NOT reproduced by T1, T2, nor a snapshot-carried stale
 * graph. The harness threads ONE bus into BOTH the emit path
 * (`processRuntimeIngressStream`'s `eventBus`) and the consume path (the vm's
 * resident graph) — exactly the TerminalRuntime wiring — and that single-bus
 * invariant is what makes commits land.
 *
 * The CONTROL test below isolates a STRUCTURAL ASYMMETRY between the two live
 * emit sources, which is the real lever on the freeze:
 *   (A) ASSISTANT CONTENT is emitted by the LLM stream pipeline
 *       (`processRuntimeIngressStream` -> `eventBus.emit`) on whatever bus that
 *       pipeline was handed.
 *   (B) TOOL RESULTS are emitted by the cooperative loop itself via
 *       `vm.eventBus.emitToolCallResult` (AiAgentExecutor.ts:5164;
 *       eventBus === vm.eventBus, AiAgentExecutor.ts:4314).
 * If the bus handed to `processRuntimeIngressStream` DIVERGES from `vm.eventBus`,
 * then (A) is lost but (B) still lands: the conversation commits HOLLOW
 * (empty-content) assistant messages while tool results still commit. So a
 * bus divergence does NOT freeze messageCount outright — it specifically drops
 * assistant CONTENT. The real-session full freeze (`messageCount:1` while 75
 * tool results filled the ToolCallDomain) is therefore NOT a single emit-bus
 * divergence either; it requires the resident graph to also miss the tool-result
 * emits on `vm.eventBus` — i.e. a divergence of `vm.eventBus` ITSELF (the
 * resident-consume bus) from the bus both live emit sources use, which this
 * faithful harness (one bus everywhere) cannot construct. That bus-instance
 * divergence inside the real recovery+driver wiring is the remaining suspect to
 * pursue; see RETURN notes.
 *
 * ===================== FIX-TRACK MUST INVERT / GUARANTEE =====================
 *  (1) The emit path and the resident-graph consume path MUST be guaranteed to
 *      use the SAME bus instance for the actor's whole session — and `vm.eventBus`
 *      (the resident-consume bus) must be that same instance — so neither
 *      assistant content (A) nor tool results (B) can ever be dropped.
 *  (2) A faithful turn must GROW messageCount and commit NON-HOLLOW assistant
 *      messages (content present), which the single-bus harness already does;
 *      the fix must make the real wiring match this single-bus invariant
 *      unconditionally so the divergence in the CONTROL test is impossible.
 */

const READ_TOOL_NAME = "read_file"
const READ_FILE_OUTPUT_PREFIX = "FILE-BODY-"
const TOOL_TURNS = 3

function makeTempWorkDir(): string {
  const dir = path.join(os.tmpdir(), `eidolon-repeat-read-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * A real ToolDef for `read_file`. Returns deterministic content so the live
 * tool-result semantic event carries a real body — the commit boundary the
 * resident graph consumes (MessageHistoryGraph.ts:611-628).
 */
function buildReadFileToolDef(): AnyToolDef {
  return {
    schema: {
      type: "function" as const,
      function: {
        name: READ_TOOL_NAME,
        description: "Read a file's contents (test tool).",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "file path" } },
          required: ["path"],
        },
      },
    },
    briefPromptXnl: "",
    detailPromptXnl: "",
    run: async (_runtime: unknown, input: any) => `${READ_FILE_OUTPUT_PREFIX}${String(input?.path ?? "unknown")}`,
  } as unknown as AnyToolDef
}

function makeToolRegistry(): ToolFuncRegistry {
  const registry = composeToolRegistry({ includeInternalOnly: true }) as ToolFuncRegistry
  ToolFuncRegistry.register(registry, buildReadFileToolDef())
  return registry
}

/**
 * A fake OpenAI-shaped streaming LLM. `createStream` is invoked once per
 * provider turn by the real cooperative loop (AiAgentExecutor.ts start_llm ->
 * streamProviderCompletion -> llmAdapter.createStream). It yields raw OpenAI
 * completion chunks so the REAL `processRuntimeIngressStream` /
 * OpenAICompletionsNodejsFetchStreamAdapter consumes them and emits the
 * production semantic event sequence on the bus it was handed.
 *
 * Turn schedule: the first `toolTurns` provider turns each issue ONE `read_file`
 * tool call (mandatory_continuation: after each tool result the loop returns to
 * start_llm and calls createStream again). The next turn returns a plain
 * assistant message (no tool call) to terminate the turn.
 */
function makeFakeStreamingLlm(toolTurns: number) {
  let turnIndex = 0
  return {
    type: "openai" as const,
    async createStream(_options: any) {
      const thisTurn = turnIndex
      turnIndex += 1
      async function* chunks() {
        if (thisTurn < toolTurns) {
          const callId = `call_read_${thisTurn + 1}`
          const argsText = JSON.stringify({ path: `src/file_${thisTurn + 1}.ts` })
          yield { choices: [{ delta: { role: "assistant", content: `reading ${thisTurn + 1}` } }] }
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, id: callId, type: "function", function: { name: READ_TOOL_NAME, arguments: argsText } },
                  ],
                },
              },
            ],
          }
          yield { choices: [{ delta: {}, finish_reason: "tool_calls" }] }
        } else {
          yield { choices: [{ delta: { role: "assistant", content: "all files read, done" } }] }
          yield { choices: [{ delta: {}, finish_reason: "stop" }] }
        }
      }
      return { stream: chunks() }
    },
  }
}

/** main__active conversation messageCount (sum across visible generations). */
function actorMessageCount(vm: any): number {
  const raw = getConversationActorRawStateFromVm({ vm, actorKey: "main" })
  return (raw?.visibleHistoryGenerations ?? []).reduce(
    (total: number, generation: any) => total + (generation.messages?.length ?? 0),
    0,
  )
}

function busConsumerCount(vm: any): number {
  return ((vm.eventBus as any)?.consumers?.size ?? 0) as number
}

function busDone(vm: any): boolean {
  return Boolean((vm.eventBus as any)?.done)
}

function toolMessages(vm: any): any[] {
  return materializeConversationRuntimeMessagesFromVm({ vm, actorKey: "main" }).filter((m: any) => m?.role === "tool")
}

function assistantMessages(vm: any): any[] {
  return materializeConversationRuntimeMessagesFromVm({ vm, actorKey: "main" }).filter(
    (m: any) => m?.role === "assistant",
  )
}

/** Deliver a user turn the production way (TerminalRuntime.ts:1184 humanInput). */
function injectUserTurn(result: { driver: any; mainFiberId: string }, text: string): void {
  result.driver.emitFiberSignal({
    fiberId: result.mainFiberId,
    signalKind: "mailbox_enqueue",
    mailbox: { kind: "humanInput", payload: text },
    idempotencyKey: `${result.mainFiberId}:humanInput:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    createdAt: Date.now(),
  })
}

/**
 * Wire a runtime in the EXACT production shape (TerminalRuntime.ts:744-801):
 * a single `eventBus`, an `actorCallbacks.processStream` that calls the REAL
 * `processRuntimeIngressStream({ stream, eventBus, ... })`, then
 * `recoverOrCreateShellRuntime({ ..., eventBus, actorCallbacks, ... })`.
 *
 * `emitBusOverride` (CONTROL only) diverges the bus handed to the live LLM
 * stream pipeline from the vm/resident-consume bus.
 */
async function wireRuntime(params: {
  workDir: string
  sessionKey: string
  toolTurns: number
  emitBusOverride?: AgentEventGraph
}) {
  const sessionDir = path.join(params.workDir, ".eidolon", "sessions", params.sessionKey)
  fs.mkdirSync(sessionDir, { recursive: true })

  const eventBus = new AgentEventGraph()
  const registries = { toolRegistry: makeToolRegistry() } as any
  const runtimeSupport = createKernelRuntimeSupportDescriptor()

  const actorCallbacks = {
    buildToolset: () => registries.toolRegistry.list(),
    processStream: (_currentVm: any, streamActor: any, stream: any, options?: { signal?: AbortSignal }) =>
      processRuntimeIngressStream({
        stream,
        adapterType: "openai",
        eventBus: params.emitBusOverride ?? eventBus,
        actorMeta: { agentKey: streamActor.key, agentActorId: streamActor.id },
        sessionDir,
        sessionId: params.sessionKey,
        storageLogsEnabled: false,
        signal: options?.signal,
      }),
  }

  const result = await recoverOrCreateShellRuntime({
    workDir: params.workDir,
    sessionDir,
    sessionKey: params.sessionKey,
    llmClient: makeFakeStreamingLlm(params.toolTurns),
    systemPrompt: "you are a test agent",
    modelConfig: { model: "mock" } as any,
    eventBus,
    registries,
    runtimeSupport,
    actorCallbacks: actorCallbacks as any,
    buildSystemMessages: (prompts) => prompts.map((content) => ({ role: "system", content })),
    storage: { logs: false, files: true },
  })

  return { ...result, eventBus, sessionDir }
}

/** Settle a base turn (one read + done) so a real snapshot exists on disk. */
async function persistBaseTurn(workDir: string, sessionKey: string): Promise<void> {
  const base = await wireRuntime({ workDir, sessionKey, toolTurns: 1 })
  injectUserTurn(base, "please read a file")
  const coordinator = createShellRuntimeFacade().createRuntimeCoordinator({
    vm: base.vm as any,
    driver: base.driver as any,
    saveSnapshot: base.saveSnapshot,
  })
  const result = await coordinator.runInteractiveTurn({ mainFiberId: base.mainFiberId, timeoutMs: 6000 })
  expect(result.status).toBe("settled")
  coordinator.dispose()
}

describe("repeat-read e2e (real recover + cooperative driver + real stream pipeline)", () => {
  it("PRIMARY: recovered N-read_file turn through the REAL pipeline — graph attaches AND commits land (T1 & T2 refuted)", async () => {
    const workDir = makeTempWorkDir()
    const sessionKey = "repeat-read-e2e-attached"
    try {
      // --- Phase 1: settle a base turn so a real snapshot exists ----------
      await persistBaseTurn(workDir, sessionKey)

      // --- Phase 2: recover from the real snapshot (restoredFromSnapshot) -
      const recovered = await wireRuntime({ workDir, sessionKey, toolTurns: TOOL_TURNS })
      const vm = recovered.vm
      expect(vm.recovery?.restoredFromSnapshot).toBe(true)
      // The real scenario: the ToolCallDomain is present and holds tool results.
      ensureVmToolCallDomain(vm)

      // Immediately post-recovery, before any cooperative step: the resident
      // graph is NOT yet a bus consumer (lazy attach) and there is no stale
      // detach carried across recovery (so T2-via-stale-detach is impossible).
      expect(busDone(vm)).toBe(false)
      expect(busConsumerCount(vm)).toBe(0)

      const baseCount = actorMessageCount(vm)
      const baseToolCount = toolMessages(vm).length

      // --- PER-OP INSTRUMENTATION (the discriminating table the task asks for) ---
      // (1) FRESH SIBLING graph as a second consumer on the SAME vm.eventBus. It
      //     starts non-completed/non-disposed (MessageHistoryGraph ctor ->
      //     INITIAL_HISTORY_PROJECTION_STATE) and commits IFF the bus carries
      //     well-formed live events to its consumers. The resident graph's own
      //     projection.completed/disposed are private (only its detach closure is
      //     stored: AiAgentExecutor.ts:2716), so the sibling is our observable
      //     proxy for "would a fresh attached graph drop here?" — it discriminates
      //     T2 (resident-state drop) from an upstream emit/bus problem.
      const siblingGraph = new DomainRuntimeHistoryGraph()
      let siblingCommittedSoFar = 0
      siblingGraph.onCommittedMessage(() => {
        siblingCommittedSoFar += 1
      })
      const siblingSub = vm.eventBus.addConsumer((event: any) => {
        siblingGraph.consumeSemanticEvent(event)
      })
      // (2) Per-op bus tap: on each live `semantic_tool_call_result` (the op
      //     commit boundary, MessageHistoryGraph.ts:611-628) sample the state
      //     EXACTLY at the moment the op's tool result is emitted.
      type PerOp = {
        op: number
        attached: number
        busDone: boolean
        residentMessageCount: number
        siblingCommittedSoFar: number
      }
      const perOp: PerOp[] = []
      const tapSub = vm.eventBus.addConsumer((event: any) => {
        if (event?.event_type !== "semantic_tool_call_result") return
        perOp.push({
          op: perOp.length + 1,
          attached: busConsumerCount(vm),
          busDone: busDone(vm),
          residentMessageCount: actorMessageCount(vm),
          siblingCommittedSoFar,
        })
      })

      // --- Phase 3: drive ONE turn with N sequential read_file ops --------
      injectUserTurn(recovered, "read all the files now")
      const coordinator = createShellRuntimeFacade().createRuntimeCoordinator({
        vm: vm as any,
        driver: recovered.driver as any,
        saveSnapshot: recovered.saveSnapshot,
      })

      // The 2 probe consumers (sibling + tap) are ours; subtract them so the
      // table reports the RESIDENT/production consumer count, not the harness.
      const PROBE_CONSUMERS = 2
      const preTurn = {
        label: "post-recovery (pre-turn)",
        attached: Math.max(0, busConsumerCount(vm) - PROBE_CONSUMERS),
        busDone: busDone(vm),
        messageCount: baseCount,
      }

      const turnResult = await coordinator.runInteractiveTurn({
        mainFiberId: recovered.mainFiberId,
        timeoutMs: 10000,
      })
      expect(turnResult.status).toBe("settled")

      const afterCount = actorMessageCount(vm)
      const afterTool = toolMessages(vm)
      const afterAssistant = assistantMessages(vm)
      const postTurn = {
        label: "after N read_file ops (one turn)",
        attached: Math.max(0, busConsumerCount(vm) - PROBE_CONSUMERS),
        busDone: busDone(vm),
        messageCount: afterCount,
      }

      tapSub.unsubscribe()
      siblingSub.unsubscribe()
      siblingGraph.dispose()

      // eslint-disable-next-line no-console
      console.log(
        "[repeat-read-e2e] PER-OP TRIGGER TABLE\n" +
          [preTurn, postTurn]
            .map(
              (p) =>
                `  ${p.label.padEnd(34)} attached(consumers)=${p.attached} busDone=${p.busDone} messageCount=${p.messageCount}`,
            )
            .join("\n") +
          "\n  --- per-op (sampled at each live semantic_tool_call_result) ---\n" +
          perOp
            .map(
              (p) =>
                `  op#${p.op} attached(consumers)=${p.attached} busDone=${p.busDone} ` +
                `residentMessageCount=${p.residentMessageCount} siblingCommittedSoFar=${p.siblingCommittedSoFar}`,
            )
            .join("\n") +
          `\n  baseCount=${baseCount} -> afterCount=${afterCount} (delta=${afterCount - baseCount}; expectedIfCommitting=${2 * TOOL_TURNS} tool + assistant)` +
          `\n  toolMessagesCommitted(new)=${afterTool.length - baseToolCount}` +
          `\n  siblingCommittedTotal=${siblingCommittedSoFar}` +
          `\n  ToolCallDomain records=${getVmToolCallDomain(vm)?.getAllRecords?.()?.length ?? "n/a"}`,
      )

      // ===== MEASURED TRIGGER DETERMINATION =====
      // (a) The resident graph IS attached as a bus consumer during/after the
      //     cooperative loop (NOT the T1 emit-before-attach hole).
      expect(postTurn.attached).toBeGreaterThan(0)
      // (b) The bus is live (not done) the whole turn.
      expect(busDone(vm)).toBe(false)
      // (c) THE COMMITS LAND. messageCount GREW. The attached graph is NOT
      //     completed/disposed (MessageHistoryGraph.ts:339 would early-return
      //     otherwise and nothing would commit). This REFUTES T2.
      expect(afterCount).toBeGreaterThan(baseCount)
      // (d) Every read_file tool result committed into the conversation domain
      //     (not just the ToolCallDomain) — N new tool messages, never frozen.
      expect(afterTool.length - baseToolCount).toBeGreaterThanOrEqual(TOOL_TURNS)
      // (e) The committed assistant messages carry REAL content (non-hollow):
      //     the single-bus path commits both content (A) and tool results (B).
      const liveAssistantContents = afterAssistant.map((m: any) => String(m?.content ?? ""))
      expect(liveAssistantContents.some((c) => c.includes("reading 1"))).toBe(true)
      expect(liveAssistantContents.some((c) => c.includes("all files read"))).toBe(true)

      // ===== PER-OP DISCRIMINATION (T2 directly probed at each op boundary) =====
      // One sample per live tool op was captured AT the moment its
      // semantic_tool_call_result was emitted.
      expect(perOp.length).toBe(TOOL_TURNS)
      // At EVERY op: the resident graph + sibling were attached (consumers>0) AND
      // the resident committed-history messageCount was already GROWING (it never
      // froze at baseCount). This is the inverse of the T2/real-session symptom:
      // attached AND committing every op, not attached-but-frozen.
      perOp.forEach((p) => {
        expect(p.attached).toBeGreaterThan(0)
        expect(p.busDone).toBe(false)
        expect(p.residentMessageCount).toBeGreaterThan(baseCount)
      })
      // residentMessageCount is monotonically non-decreasing across ops (history
      // accrues, never resets) — the convergence shape a healthy turn has.
      for (let i = 1; i < perOp.length; i += 1) {
        expect(perOp[i].residentMessageCount).toBeGreaterThanOrEqual(perOp[i - 1].residentMessageCount)
      }
      // The FRESH SIBLING on the same bus also committed every op (it commits a
      // pair at each tool-result boundary). resident-commits AND sibling-commits
      // => the bus events are well-formed AND a fresh attached graph commits them.
      // Therefore, if the resident had frozen here, ONLY a completed/disposed
      // resident projection (T2) could explain it — but the resident did NOT
      // freeze. CONCLUSION: through the real driver from a clean recovered base,
      // neither T1 nor T2 fires; the real freeze needs an additional real-world
      // condition (see CONTROL test for the bus-divergence lever).
      expect(siblingCommittedSoFar).toBeGreaterThan(0)

      coordinator.dispose()
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true })
    }
  })

  it("CONTROL (structural asymmetry): a divergent EMIT bus drops assistant CONTENT (hollow assistants) but tool results STILL commit", async () => {
    // Isolates the two live emit sources:
    //   (A) assistant content -> processRuntimeIngressStream -> emit bus (DIVERGENT here)
    //   (B) tool results       -> vm.eventBus.emitToolCallResult (AiAgentExecutor.ts:5164)
    // With a divergent emit bus, (A) is lost (assistant messages commit HOLLOW)
    // while (B) still lands on vm.eventBus -> tool results still commit. This is
    // the precise mechanical asymmetry; it proves the real full-freeze is NOT a
    // simple emit-bus divergence (which would still grow messageCount with
    // hollow assistants), and that messageCount does NOT freeze here.
    const workDir = makeTempWorkDir()
    const sessionKey = "repeat-read-e2e-divergent-bus"
    try {
      await persistBaseTurn(workDir, sessionKey)

      const divergentEmitBus = new AgentEventGraph()
      const recovered = await wireRuntime({
        workDir,
        sessionKey,
        toolTurns: TOOL_TURNS,
        emitBusOverride: divergentEmitBus,
      })
      const vm = recovered.vm
      expect(vm.recovery?.restoredFromSnapshot).toBe(true)
      ensureVmToolCallDomain(vm)

      const baseCount = actorMessageCount(vm)
      const baseToolCount = toolMessages(vm).length
      // Scope assertions to messages ADDED by THIS turn (the recovered base
      // already carries committed assistants from the base turn).
      const baseAssistantCount = assistantMessages(vm).length

      injectUserTurn(recovered, "read all the files now")
      const coordinator = createShellRuntimeFacade().createRuntimeCoordinator({
        vm: vm as any,
        driver: recovered.driver as any,
        saveSnapshot: recovered.saveSnapshot,
      })
      const turnResult = await coordinator.runInteractiveTurn({
        mainFiberId: recovered.mainFiberId,
        timeoutMs: 10000,
      })
      expect(turnResult.status).toBe("settled")

      const afterCount = actorMessageCount(vm)
      const newTool = toolMessages(vm).slice(baseToolCount)
      const newAssistants = assistantMessages(vm)
        .slice(baseAssistantCount)
        .map((m: any) => String(m?.content ?? ""))

      // The resident graph attaches to the vm (recovery) bus...
      expect(busConsumerCount(vm)).toBeGreaterThan(0)
      // (B) Tool results STILL commit (emitted on vm.eventBus, not the divergent
      //     bus): the conversation is NOT frozen — messageCount GREW.
      expect(afterCount).toBeGreaterThan(baseCount)
      expect(newTool.length).toBeGreaterThanOrEqual(TOOL_TURNS)
      newTool.forEach((m: any) => expect(String(m?.content ?? "")).toContain(READ_FILE_OUTPUT_PREFIX))

      // (A) ...but the NEW assistant messages from THIS turn are HOLLOW (content
      //     was emitted on the divergent bus and never reached the resident
      //     graph). This is the measured asymmetry. FIX-TRACK MUST INVERT: with
      //     the bus-divergence made impossible, these assistants must carry
      //     content (e.g. "reading 1" / "all files read").
      expect(newAssistants.length).toBeGreaterThan(0)
      expect(newAssistants.some((c) => c.includes("reading 1"))).toBe(false)
      expect(newAssistants.some((c) => c.includes("all files read"))).toBe(false)
      // The new assistants landed HOLLOW (empty content) for this turn.
      expect(newAssistants.every((c) => c === "")).toBe(true)

      coordinator.dispose()
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true })
    }
  })
})
