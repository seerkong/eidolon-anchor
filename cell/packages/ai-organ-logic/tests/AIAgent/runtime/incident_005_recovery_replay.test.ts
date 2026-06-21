import { describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent/ToolFuncComposer"
import { createActor, createVM } from "@cell/ai-core-logic"
import {
  configureRuntimePersistenceSupport,
  createAiAgentOrchestratorDriverWithCooperative,
} from "@cell/ai-organ-logic"
import { buildProviderPromptForActorTurn } from "@cell/ai-organ-logic/exec/AiAgentExecutor"
import { materializeConversationRuntimeMessagesFromVm } from "@cell/ai-organ-logic/conversation/ConversationDomainRuntime"
import {
  ensureVmToolCallDomain,
} from "@cell/ai-organ-logic/runtime/ToolCallDomainRuntime"
import {
  buildPendingAiGeneratedFromCompletedEffect,
  recoverAiAgentRuntime,
  saveAiAgentRuntimeSnapshot,
} from "@cell/ai-organ-logic/persistence/RuntimeSnapshots"
import { createRecoveryReadPort } from "@cell/ai-organ-logic/persistence/RecoveryReadPort"
import { createToolCallDomainRuntime } from "@cell/ai-organ-logic/runtime/ToolCallDomainRuntime"
import {
  LocalFileConversationPersistenceRepositoryFactory,
  LocalFileRuntimeDerivedIndexesStore,
  LocalFileRuntimeSnapshotRepositoryFactory,
} from "@cell/ai-support"
import {
  appendRuntimeControlEffectEvidence,
  readRealSessionDurableHeads,
  readRuntimeControlCohortCommitFile,
  readRuntimeControlEffectEvidenceSequence,
  readRuntimeControlSessionUpgradeFile,
  writeRuntimeControlCohortCommitFile,
  writeRuntimeControlSessionUpgradeFile,
} from "@cell/ai-file-store-logic"
import { applyFileStoreAiRuntimeSessionUpgrade } from "@cell/ai-runtime-control-composer"
import { createMockProcessStream } from "../__test_support__/mockProcessStream"

/**
 * 005 INCIDENT RECOVERY REPLAY HARNESS
 * ====================================
 * Track refactor-persistent-session-backplane, P4 / T4.1. Executable coverage
 * for behavior-delta `recovery-single-source-replay` case
 * `incident-replay-no-repeat-read` and the root-cause documented in
 * `.theater/runtime-evolution-mission/005-revised-runtime-data-graph-model.md`
 * ("重复读文件").
 *
 * THE 005 ROOT CAUSE (fixture spec)
 * --------------------------------
 * An interrupted turn left a COMPLETED tool effect whose result landed only in
 * the effect-evidence journal (link-only: it carries the tool_call_id link, NOT
 * the output text) — it was never paired into the Conversation Domain / formal
 * committed history. On recovery, the model's next-turn provider context was
 * missing the paired tool result, so the model re-issued the SAME tool call
 * (the repeat-read symptom).
 *
 * 005 line 501-502: "tool lifecycle 可以有 runtime-control operation evidence，
 * 但 AI tool result truth 必须进入 ToolCallDomain 和 Conversation Domain；只写
 * effect evidence 不代表主干 tool result 完成。"
 * 005 line 1032: "Conversation Domain 证明模型可见 tool result。"
 *
 * THE FIX (verified here)
 * -----------------------
 * Recovery reconstructs the paired tool result from its SINGLE OWNER SOURCE
 * (ToolCallDomain — the AI tool-result truth), using the link-only effect
 * evidence ONLY as the sequential presence signal. The reconstructed
 * `tool_done` is re-emitted on the bus, the MessageHistoryGraph commits it into
 * the Conversation Domain, and the NEXT provider context (materialized LLM
 * messages) then contains the COMPLETE, PAIRED tool result — so the model does
 * NOT repeat-read.
 *
 * The fixture is a MINIMIZED equivalent of the real 005 session: it is
 * constructed so a pre-fix recovery (domain missing the paired result, no
 * single-source reconstruction) would FAIL — see the "guards the root cause"
 * negative assertions, which prove the paired result genuinely comes from the
 * single-owner reconstruction path and not from the (link-only) evidence.
 */

configureRuntimePersistenceSupport({
  snapshotRepositoryFactory: LocalFileRuntimeSnapshotRepositoryFactory,
  derivedIndexesStore: LocalFileRuntimeDerivedIndexesStore,
  conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
})

function makeTempSessionDir(): string {
  const dir = path.join(os.tmpdir(), `eidolon-incident-005-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

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

async function rewriteRuntimeControlCheckpointForCurrentSessionFiles(sessionDir: string): Promise<void> {
  const heads = await readRealSessionDurableHeads(sessionDir)
  const current = await readRuntimeControlCohortCommitFile({ sessionDir, cohortId: "checkpoint" })
  const checkpointHeadIds = current ? Object.keys(current.headSequences) : Object.keys(heads)
  await writeRuntimeControlCohortCommitFile({
    sessionDir,
    cohortId: "checkpoint",
    headSequences: Object.fromEntries(
      checkpointHeadIds.map((headId) => [headId, heads[headId]?.committedSequence ?? 0]),
    ),
    effectEvidenceSequence: await readRuntimeControlEffectEvidenceSequence(sessionDir),
  })
  const checkpoint = await readRuntimeControlCohortCommitFile({ sessionDir, cohortId: "checkpoint" })
  const upgrade = await readRuntimeControlSessionUpgradeFile({ sessionDir })
  if (checkpoint && upgrade) {
    await writeRuntimeControlSessionUpgradeFile({
      sessionDir,
      checkpointCohortId: checkpoint.cohortId,
      checkpointMarker: checkpoint.marker,
      previousCheckpointMarker: upgrade.checkpointMarker,
      headSequences: checkpoint.headSequences,
      effectEvidenceSequence: checkpoint.effectEvidenceSequence,
    })
  }
}

async function upgradeRuntimeControlCheckpointForCurrentSessionFiles(sessionDir: string): Promise<void> {
  const result = await applyFileStoreAiRuntimeSessionUpgrade({ sessionDir })
  expect(result.status === "applied" || result.status === "already_upgraded").toBe(true)
}

// The interrupted read-file tool call. The file path is the "重复读文件" target:
// the regression symptom is the model re-issuing exactly this call.
const READ_FILE_PATH = "src/incident/INCIDENT_005.ts"
const READ_FILE_OUTPUT = "FILE-BODY: the incident-005 file contents, read exactly once"

function buildInterruptedReadFiber(params: {
  sessionDir: string
  sessionId: string
  adapter: ReturnType<typeof makeMockAdapter>
  /** When true, seed the completed ToolCallDomain record (the single owner). */
  seedDomainResult: boolean
}) {
  const toolCall = {
    id: "call_incident_005_read",
    type: "function",
    function: { name: "read_file", arguments: JSON.stringify({ path: READ_FILE_PATH }) },
  }
  const root = createActor({
    key: "main",
    llmClient: params.adapter,
    modelConfig: { model: "mock" },
    recovery: { restoredFromSnapshot: true },
    messages: [
      { role: "system", content: "system" } as any,
      { role: "user", content: "read the incident file" } as any,
      // The model already issued the read_file tool call before the interrupt.
      { role: "assistant", content: "", tool_calls: [toolCall] } as any,
    ],
    callbacks: {
      buildToolset: () => [],
      // If the next turn ever re-issues a tool call, this would surface a NEW
      // assistant tool_call; the mock instead returns a plain assistant reply,
      // so a repeat-read is detected structurally (see the assertions).
      processStream: createMockProcessStream(async () => ({ role: "assistant", content: "done, the file said hello" })),
    },
  })
  const vm = createVM({
    controlActorKey: root.key,
    actors: { [root.key]: root },
    registries: { toolRegistry: composeToolRegistry({ includeInternalOnly: true }) } as any,
    callbacks: {
      buildSystemMessages: (prompts) => prompts.map((content) => ({ role: "system", content })),
    },
  })

  if (params.seedDomainResult) {
    // SINGLE OWNER: the ToolCallDomain holds the completed tool result truth.
    // This is the only place the OUTPUT TEXT lives; the effect evidence below
    // is link-only (no output).
    const domain = ensureVmToolCallDomain(vm)
    domain.planTool({
      toolCallId: toolCall.id,
      actorKey: root.key,
      turnId: 1,
      funcName: "read_file",
      args: { path: READ_FILE_PATH },
      at: 1,
    })
    domain.recordGateDecision({ toolCallId: toolCall.id, gateOutcome: "allow", at: 2 })
    domain.markExecuting({ toolCallId: toolCall.id, at: 3 })
    domain.recordResult({ toolCallId: toolCall.id, outputText: READ_FILE_OUTPUT, at: 4 })
  }

  const fiberId = `${root.key}:${root.id}`
  const driver = createAiAgentOrchestratorDriverWithCooperative({
    fibers: [{ fiberId, vm, actor: root, messages: root.messages, basePriority: 1 }],
    options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
  })
  return { root, vm, driver, fiberId, toolCall }
}

/**
 * Persist the interrupted-turn fixture: a suspended wait_tool fiber whose
 * completed tool result lives ONLY in (a) the completed ToolCallDomain record
 * (single owner, persisted in the snapshot) and (b) a LINK-ONLY effect-evidence
 * result event (no output text) — and is NOT paired into the Conversation
 * Domain and NOT present in the asyncCompletion mailbox.
 */
async function persistInterruptedReadFixture(params: {
  sessionDir: string
  sessionId: string
  adapter: ReturnType<typeof makeMockAdapter>
  seedDomainResult: boolean
}): Promise<{ fiberId: string; opId: string; toolCallId: string }> {
  const { vm, driver, fiberId, toolCall } = buildInterruptedReadFiber(params)
  await saveAiAgentRuntimeSnapshot({ sessionDir: params.sessionDir, sessionId: params.sessionId, vm, driver })

  const manifestPath = path.join(params.sessionDir, "runtime_state", "manifest.json")
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"))
  const fiberPath = path.join(params.sessionDir, "runtime_state", manifest.fiberFiles[fiberId])
  const fiberSnapshot = JSON.parse(fs.readFileSync(fiberPath, "utf-8"))
  const opId = `tool:${fiberId}:1`
  fiberSnapshot.status = "suspended"
  fiberSnapshot.waitingReason = "wait_tool_result"
  fiberSnapshot.lastYieldAt = Date.now()
  fiberSnapshot.metadata = {
    ...(fiberSnapshot.metadata ?? {}),
    waitingReason: "wait_tool_result",
    cooperativeExecState: {
      phase: "wait_tool",
      turn: 1,
      tools: [],
      toolCalls: [toolCall],
      toolIndex: 0,
      nextOpSeq: 2,
      pendingToolResults: [],
      // CRITICAL: the result is NOT yet paired (pendingAiGenerated empty) and is
      // NOT in the asyncCompletion mailbox — recovery MUST reconstruct it from
      // the single owner source, exactly the 005 interrupted-turn shape.
      pendingAiGenerated: [],
      inflight: {
        kind: "tool",
        opId,
        funcName: "read_file",
        toolCallId: toolCall.id,
        args: { path: READ_FILE_PATH },
      },
      messageHistoryAttached: false,
    },
  }
  fs.writeFileSync(fiberPath, `${JSON.stringify(fiberSnapshot, null, 2)}\n`)

  // Effect evidence: request + waiting + a LINK-ONLY result (carries the
  // tool_call_id link, NO output text). This is the audit/journal trail; it is
  // explicitly NOT the source of the output text (005 line 501-502).
  await appendRuntimeControlEffectEvidence({
    sessionDir: params.sessionDir,
    event: {
      kind: "request",
      effectKind: "tool_call",
      effectId: opId,
      handlerKey: "read_file",
      idempotencyKey: `${fiberId}:${opId}:tool`,
      sourceCommandId: opId,
      payload: { toolCallId: toolCall.id },
    },
  })
  await appendRuntimeControlEffectEvidence({
    sessionDir: params.sessionDir,
    event: {
      kind: "result",
      effectKind: "tool_call",
      effectId: opId,
      handlerKey: "read_file",
      idempotencyKey: `${fiberId}:${opId}:tool`,
      resultId: `${opId}:tool_done`,
      // LINK ONLY: no outputText / output in the payload.
      payload: { toolCallId: toolCall.id },
    },
  })

  await rewriteRuntimeControlCheckpointForCurrentSessionFiles(params.sessionDir)
  await upgradeRuntimeControlCheckpointForCurrentSessionFiles(params.sessionDir)
  return { fiberId, opId, toolCallId: toolCall.id }
}

async function recoverSession(params: { sessionDir: string; sessionId: string }) {
  return await recoverAiAgentRuntime({
    sessionDir: params.sessionDir,
    sessionId: params.sessionId,
    llmClient: makeMockAdapter() as any,
    registries: { toolRegistry: composeToolRegistry({ includeInternalOnly: true }) } as any,
    recoveryReadPort: createRecoveryReadPort(),
    callbacks: {
      buildSystemMessages: (prompts) => prompts.map((content) => ({ role: "system", content })),
    },
    actorCallbacks: {
      buildToolset: () => [],
      processStream: createMockProcessStream(async () => ({ role: "assistant", content: "done, the file said hello" })),
    },
  })
}

/**
 * The NEXT-turn provider context = the materialized LLM messages the provider
 * request is built from. 005 line 379: "tool result 进入下一轮 LLM 之前，必须
 * 进入 formal committed history 或 LLM Context materialization 的正式路径." The
 * `executionMessages` are exactly that LLM-Context materialization (built from
 * the Conversation Domain), the model-visible truth — as opposed to the
 * adapter-specific OpenAI wire normalization in `providerMessages`.
 */
function providerContextForNextTurn(recovered: NonNullable<Awaited<ReturnType<typeof recoverSession>>>): {
  executionMessages: any[]
  providerMessages: any[]
} {
  const prompt = buildProviderPromptForActorTurn({
    vm: recovered.vm,
    actor: recovered.controlActor,
    tools: [],
    llmAdapter: makeMockAdapter() as any,
    model: "mock",
    recordPromptPlan: false,
  })
  expect(prompt.promptSource).toBe("domain_materialization")
  return { executionMessages: prompt.executionMessages, providerMessages: prompt.providerMessages }
}

function countReadFileToolCalls(messages: any[]): number {
  let count = 0
  for (const message of messages) {
    if (message?.role !== "assistant") continue
    const toolCalls = (message.tool_calls ?? message.toolCalls ?? []) as any[]
    for (const call of toolCalls) {
      const name = call?.function?.name ?? call?.name
      if (name === "read_file") count += 1
    }
  }
  return count
}

describe("005 incident replay: recovered context has the paired tool result, no repeat-read", () => {
  it("recovers the interrupted read, continues one turn, and the NEXT provider context contains the complete paired tool result", async () => {
    const sessionDir = makeTempSessionDir()
    const sessionId = "incident-005-no-repeat-read"
    try {
      const { toolCallId } = await persistInterruptedReadFixture({
        sessionDir,
        sessionId,
        adapter: makeMockAdapter(),
        seedDomainResult: true,
      })

      const recovered = await recoverSession({ sessionDir, sessionId })
      expect(recovered).toBeTruthy()

      // Continue exactly ONE turn from the recovered state. The recovered
      // tool_done is re-emitted on the bus and committed into the Conversation
      // Domain during this drain.
      await recovered!.driver.tickUntilForegroundSettled({ now: Date.now(), maxTicks: 20, maxWallMs: 2000 })

      // (1) The recovered next-turn provider context contains the COMPLETE,
      //     PAIRED tool result (delta then: "含完整配对的工具结果"). Assert on
      //     the LLM-Context materialization (the model-visible provider context,
      //     005 line 379 / 1032), which is the truth surface the root cause was
      //     about — the missing paired result there was what drove the re-read.
      const { executionMessages } = providerContextForNextTurn(recovered!)
      const toolMessages = executionMessages.filter(
        (message: any) => message?.role === "tool" && message?.tool_call_id === toolCallId,
      )
      expect(toolMessages.length).toBe(1)
      expect(String(toolMessages[0]?.content ?? "")).toContain(READ_FILE_OUTPUT)

      // The conversation-domain materialization (the model-visible truth, 005
      // line 1032 "Conversation Domain 证明模型可见 tool result") carries the
      // tool result paired by its tool_call_id.
      const domainMessages = materializeConversationRuntimeMessagesFromVm({
        vm: recovered!.vm,
        actorKey: "main",
      })
      const pairedToolResult = domainMessages.find(
        (message: any) => message?.role === "tool" && message?.tool_call_id === toolCallId,
      )
      expect(pairedToolResult).toBeTruthy()
      expect(String(pairedToolResult?.content ?? "")).toContain(READ_FILE_OUTPUT)

      // (2) The next turn does NOT re-issue the same read (root-cause symptom
      //     does not recur). Two independent signals:
      //   (2a) There is exactly ONE tool result for the read across the whole
      //        recovered actor message log — the paired one — never a second.
      const readToolResults = recovered!.controlActor.messages.filter(
        (message: any) => message?.role === "tool" && message?.tool_call_id === toolCallId,
      )
      expect(readToolResults.length).toBe(1)
      //   (2b) The continuation settled into a plain assistant reply; it did NOT
      //        emit a NEW read_file tool call (a repeat-read would surface as an
      //        extra assistant tool_calls entry for read_file).
      expect(countReadFileToolCalls(recovered!.controlActor.messages)).toBe(0)
      expect(
        recovered!.controlActor.messages.some(
          (message: any) => message?.role === "assistant" && message?.content === "done, the file said hello",
        ),
      ).toBe(true)
      // The async completion mailbox has been fully drained (the recovered
      // result was consumed, not left dangling to trigger a re-read).
      expect(recovered!.controlActor.peekMailbox("asyncCompletion")).toEqual([])
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })

  it("the paired result's output text comes from the single-owner ToolCallDomain, not the link-only evidence (guards the root cause)", () => {
    // This is the load-bearing root-cause guard. It isolates the reconstruction
    // step that the end-to-end replay exercises, and proves the paired output
    // text is sourced from the SINGLE OWNER (ToolCallDomain) — NOT from the
    // link-only effect evidence.
    const toolInflightExecState = {
      inflight: { kind: "tool", opId: "tool:main:1", funcName: "read_file", toolCallId: "call_incident_005_read", args: { path: READ_FILE_PATH } },
    }
    // Link-only result evidence: it confirms the result EXISTS but carries no
    // output text — exactly the 005 effect-evidence-only state.
    const linkOnlyEvidence = [
      {
        kind: "result",
        effectKind: "tool_call",
        effectId: "tool:main:1",
        handlerKey: "read_file",
        resultId: "tool:main:1:tool_done",
        payload: { toolCallId: "call_incident_005_read" },
      },
    ] as any

    // WITH the single-owner domain: the reconstruction recovers the full paired
    // output text from the domain record.
    const domain = createToolCallDomainRuntime()
    domain.planTool({ toolCallId: "call_incident_005_read", actorKey: "main", turnId: 1, funcName: "read_file", args: { path: READ_FILE_PATH }, at: 1 })
    domain.recordGateDecision({ toolCallId: "call_incident_005_read", gateOutcome: "allow", at: 2 })
    domain.markExecuting({ toolCallId: "call_incident_005_read", at: 3 })
    domain.recordResult({ toolCallId: "call_incident_005_read", outputText: READ_FILE_OUTPUT, at: 4 })

    const fromDomain = buildPendingAiGeneratedFromCompletedEffect(toolInflightExecState, linkOnlyEvidence, domain)
    expect(fromDomain).toMatchObject({
      kind: "tool_done",
      toolCallId: "call_incident_005_read",
      outputText: READ_FILE_OUTPUT,
    })

    // PRE-FIX SHAPE (the regression): if recovery had NO single-source domain
    // reconstruction and leaned only on the LINK-ONLY evidence, the recovered
    // result would carry an EMPTY output text — an unpaired / hollow tool result
    // that the next turn would treat as missing, triggering the repeat-read.
    // This proves the harness is NOT a tautology: remove the single owner and
    // the paired output text vanishes.
    const withoutDomain = buildPendingAiGeneratedFromCompletedEffect(toolInflightExecState, linkOnlyEvidence, null)
    expect(withoutDomain).toMatchObject({ kind: "tool_done", toolCallId: "call_incident_005_read" })
    expect(String((withoutDomain as any)?.outputText ?? "")).toBe("")
    // The fix sources the truth from the domain; the regression shape does not.
    expect((fromDomain as any)?.outputText).not.toBe((withoutDomain as any)?.outputText)
  })

  it("END-TO-END contrast: the pre-fix shape (link-only evidence, NO single-owner record) recovers a HOLLOW unpaired result", async () => {
    // Same recovery-replay as the first test, but WITHOUT seeding the
    // single-owner ToolCallDomain record (`seedDomainResult: false`) — the
    // literal 005 failure shape: the completed effect's result existed ONLY as
    // link-only evidence, never paired into the tool-result truth. This proves
    // the end-to-end harness is sensitive to the root cause: with no single
    // owner, the recovered next-turn provider context carries a HOLLOW
    // (empty-content) tool result for the read — exactly the missing-paired-
    // result state that drove the model to re-read the file.
    const sessionDir = makeTempSessionDir()
    const sessionId = "incident-005-prefix-hollow"
    try {
      const { toolCallId } = await persistInterruptedReadFixture({
        sessionDir,
        sessionId,
        adapter: makeMockAdapter(),
        seedDomainResult: false,
      })

      const recovered = await recoverSession({ sessionDir, sessionId })
      expect(recovered).toBeTruthy()
      await recovered!.driver.tickUntilForegroundSettled({ now: Date.now(), maxTicks: 20, maxWallMs: 2000 })

      const domainMessages = materializeConversationRuntimeMessagesFromVm({
        vm: recovered!.vm,
        actorKey: "main",
      })
      const recoveredToolResult = domainMessages.find(
        (message: any) => message?.role === "tool" && message?.tool_call_id === toolCallId,
      )
      // A tool message exists, but its content is HOLLOW (the output text was
      // never recovered) — the pre-fix missing-paired-result symptom. The FIX
      // path (first test, seedDomainResult:true) instead carries READ_FILE_OUTPUT.
      expect(recoveredToolResult).toBeTruthy()
      expect(String(recoveredToolResult?.content ?? "")).toBe("")
      expect(String(recoveredToolResult?.content ?? "")).not.toContain(READ_FILE_OUTPUT)
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true })
    }
  })
})
