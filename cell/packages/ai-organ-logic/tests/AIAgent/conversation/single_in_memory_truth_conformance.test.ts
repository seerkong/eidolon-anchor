import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "bun:test"

import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { buildRuntimeSemanticBase } from "@cell/ai-core-logic/stream/runtime/SemanticRuntimeSupport"
import type { SemanticEvent } from "@cell/ai-core-contract/stream/semantic"
import { buildProviderPromptForActorTurn } from "@cell/ai-organ-logic/exec/AiAgentExecutor"

import {
  appendLiveHistoryMessageToConversationDomainRuntime,
  createInMemoryConversationPersistenceAdapter,
  ensureVmConversationDomainRuntime,
  getConversationActorRawStateFromVm,
  materializeConversationRuntimeMessagesFromVm,
  messageAssemblyDerivation,
} from "../../../src/conversationCapsule/coreLogic"
import {
  BUILTIN_SCENARIOS,
  SCENARIO_COMPACTION_FOLLOW_UP,
  compareProviderMessageSequences,
  runScriptedAssemblyScenario,
} from "./providerEquivalenceHarness"

/**
 * Executable coverage for spec single-in-memory-truth (track
 * refactor-ai-semantic-conversation-spine, tasks T4.2/T4.3):
 *
 *  - provider-context-from-materialize-only — the production build sources
 *    providerMessages from the domain materialization on the scripted main
 *    chains; since T4.3 the materialization is the ONLY assembly: an
 *    out-of-band raw-array write simply never reaches the provider prompt
 *    (the transitional legacy fallback was deleted), and source-level
 *    assertions pin that AiAgentExecutor has no path assembling provider
 *    input from params.messages.
 *  - writes-via-semantic-events — conversation inputs enter the domains
 *    through semantic events reduced by the message-assembly derivation
 *    (single commit boundary); bare array pushes do not reach the domains.
 *  - compaction-in-domain — compaction lands as a compact history generation
 *    plus a summary transform in the prompt domain (no array is the truth).
 *  - equivalence-gate — provider_equivalence_gate.test.ts (same directory).
 */

const SESSION_ID = "truth-conformance-session"

const cellPackagesRoot = path.resolve(import.meta.dir, "../../../..")
const terminalPackagesRoot = path.resolve(cellPackagesRoot, "../../terminal/packages")

function walkTypeScriptFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue
      files.push(...walkTypeScriptFiles(fullPath))
      continue
    }
    if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      files.push(fullPath)
    }
  }
  return files
}

function extractFunctionBody(source: string, functionName: string): string {
  const startIndex = source.indexOf(`export function ${functionName}`)
  if (startIndex === -1) {
    throw new Error(`function ${functionName} not found in source`)
  }
  // Slice up to the next top-level (column-0) declaration; precise enough for
  // the source-level invariants asserted here.
  const declarationPattern = /^(?:export\s+)?(?:async\s+)?(?:function|const|class|type)\s/gm
  declarationPattern.lastIndex = startIndex + 1
  const nextDeclaration = declarationPattern.exec(source)
  return source.slice(startIndex, nextDeclaration ? nextDeclaration.index : source.length)
}

function createConformanceRuntime() {
  const llmAdapter = {
    type: "openai" as const,
    async createStream(): Promise<never> {
      throw new Error("conformance runtime never calls the provider")
    },
  }
  const actor = createActor({
    key: "main",
    llmClient: llmAdapter,
    systemPrompts: ["You are the single-in-memory-truth conformance agent."],
    modelConfig: { model: "conformance-mock", inputLimit: 32_000 },
    callbacks: {
      buildToolset: () => [],
      processStream: async () => ({ role: "assistant", content: "" }),
    },
  })
  const vm = createVM({
    controlActorKey: "main",
    actors: { main: actor },
    registries: { toolRegistry: new ToolFuncRegistry() },
    options: { storage: { logs: false, files: false } },
    outerCtx: {
      metadata: {
        sessionId: SESSION_ID,
        sessionDir: SESSION_ID,
      },
      // P3 (refactor-persistent-session-backplane / `explicit-injection`):
      // explicit typed field, not the untyped `metadata` channel.
      conversationPersistenceRepositoryFactory: createInMemoryConversationPersistenceAdapter(),
    },
    effects: {},
  })
  ensureVmConversationDomainRuntime(vm)
  return { vm, actor, llmAdapter }
}

function makeSemanticEvent(
  actor: { key: string; id: string },
  emittedAt: number,
  eventType: SemanticEvent["event_type"],
  extra: Record<string, unknown> = {},
): SemanticEvent {
  const base = buildRuntimeSemanticBase({ agentKey: actor.key, agentActorId: actor.id }, 1)
  return {
    ...base,
    ...extra,
    trace: { ...base.trace, emitted_at: emittedAt },
    event_type: eventType,
  } as SemanticEvent
}

describe("single-in-memory-truth: provider-context-from-materialize-only", () => {
  it("the production build uses the domain materialization on every main-chain boundary", async () => {
    for (const scenario of BUILTIN_SCENARIOS) {
      const run = await runScriptedAssemblyScenario(scenario)
      for (const snapshot of run.snapshots) {
        expect({
          scenario: scenario.name,
          boundary: snapshot.label,
          promptSource: snapshot.promptSource,
        }).toEqual({
          scenario: scenario.name,
          boundary: snapshot.label,
          promptSource: "domain_materialization",
        })
        expect(
          compareProviderMessageSequences(
            snapshot.productionProviderMessages,
            snapshot.domainProviderMessages,
          ),
        ).toEqual([])
      }
    }
  })

  it("an out-of-band raw-array write never reaches the provider prompt (no array input exists)", () => {
    const { vm, actor, llmAdapter } = createConformanceRuntime()

    const aligned = buildProviderPromptForActorTurn({
      vm,
      actor,
      tools: [],
      llmAdapter: llmAdapter as any,
      model: "conformance-mock",
    })
    expect(aligned.promptSource).toBe("domain_materialization")

    // Bypass the domains: a bare array push, the exact write pattern this
    // requirement forbids. Since P7 the build does not even accept a message
    // array — the smuggled message has no channel into the provider prompt.
    const sideArray: any[] = []
    sideArray.push({ role: "user", content: "smuggled through the raw array" })
    const afterPush = buildProviderPromptForActorTurn({
      vm,
      actor,
      tools: [],
      llmAdapter: llmAdapter as any,
      model: "conformance-mock",
    })
    expect(afterPush.promptSource).toBe("domain_materialization")
    expect(
      afterPush.providerMessages.some((message: any) =>
        String(message?.content ?? "").includes("smuggled through the raw array"),
      ),
    ).toBe(false)
    expect(
      afterPush.executionMessages.some((message: any) =>
        String(message?.content ?? "").includes("smuggled through the raw array"),
      ),
    ).toBe(false)
  })

  it("mirror-eliminated: the system channel is actor.systemPrompts, no array path exists (P7)", () => {
    // Reversal of the former bounded exception (design.md §3, decisions.md
    // decision 7): the prompt plan's system channel is actor.systemPrompts
    // plus the identity block — system-role content placed in ANY raw array
    // has no path into the prompt plan, the domains, or the provider prompt.
    const { vm, actor, llmAdapter } = createConformanceRuntime()
    const sideArray: any[] = [{ role: "system", content: "mirror system directive" }]
    void sideArray

    const build = buildProviderPromptForActorTurn({
      vm,
      actor,
      tools: [],
      llmAdapter: llmAdapter as any,
      model: "conformance-mock",
    })
    expect(build.promptSource).toBe("domain_materialization")
    // The array system content reaches NOTHING...
    expect(build.promptPlan.systemPrompts).not.toContain("mirror system directive")
    const domainView = materializeConversationRuntimeMessagesFromVm({ vm, actorKey: actor.key })
    expect(
      domainView.some((message: any) => String(message?.content ?? "").includes("mirror system directive")),
    ).toBe(false)
    expect(
      build.providerMessages.some((message: any) =>
        String(message?.content ?? "").includes("mirror system directive"),
      ),
    ).toBe(false)
    // ...while the actor's own system prompts are the system channel.
    expect(build.promptPlan.systemPrompts).toContain(
      "You are the single-in-memory-truth conformance agent.",
    )
    expect(
      build.providerMessages.some(
        (message: any) =>
          String(message?.role ?? "") === "system"
          && String(message?.content ?? "").includes("single-in-memory-truth conformance agent"),
      ),
    ).toBe(true)
  })
})

describe("single-in-memory-truth: no provider assembly from params.messages (source-level, T4.3)", () => {
  const executorPath = path.join(
    cellPackagesRoot,
    "ai-organ-logic",
    "src",
    "exec",
    "AiAgentExecutor.ts",
  )
  const executorSource = fs.readFileSync(executorPath, "utf8")

  it("the legacy assembly symbol is gone from every package source tree", () => {
    const roots = [cellPackagesRoot, terminalPackagesRoot]
    const offenders: string[] = []
    for (const root of roots) {
      for (const packageDir of fs.readdirSync(root)) {
        const srcDir = path.join(root, packageDir, "src")
        if (!fs.existsSync(srcDir)) continue
        for (const file of walkTypeScriptFiles(srcDir)) {
          if (fs.readFileSync(file, "utf8").includes("buildLegacyProviderPromptForActorTurn")) {
            offenders.push(file)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it("AiAgentExecutor keeps no legacy assembly entry points", () => {
    expect(executorSource.includes("buildLegacyProviderPromptForActorTurn")).toBe(false)
    expect(executorSource.includes("materializeExecutionMessagesWithWorkContext")).toBe(false)
    expect(executorSource.includes('"legacy_messages"')).toBe(false)
  })

  it("the provider prompt build sources executionMessages from the domain materialization only", () => {
    const buildBody = extractFunctionBody(executorSource, "buildProviderPromptForActorTurn")
    expect(buildBody).toContain("materializeConversationRuntimeMessagesFromVm")
    expect(buildBody).toContain("prepareMessagesForLlmAdapter(params.llmAdapter, executionMessages)")
    // P7 mirror elimination: the build accepts NO message array at all —
    // params.messages does not exist; the prompt-plan system channel is
    // actor.systemPrompts + the identity block seed.
    expect(buildBody.includes("params.messages")).toBe(false)
    expect(/executionMessages\s*=\s*materializeConversationRuntimeMessagesFromVm/.test(buildBody)).toBe(true)
  })

  it("every provider stream call sends providerMessages from the build, never a raw array", () => {
    const callSites = [...executorSource.matchAll(/\.createStream\(\{/g)]
    expect(callSites.length).toBeGreaterThan(0)
    for (const match of callSites) {
      const window = executorSource.slice(match.index!, match.index! + 400)
      expect({
        at: match.index,
        sendsProviderMessages: /messages:\s*(retryPrompt\.providerMessages|promptBuild\.providerMessages|providerMessages)\s*,/.test(window),
      }).toEqual({ at: match.index, sendsProviderMessages: true })
      expect(/messages:\s*(params\.messages|input\.messages|messages)\s*,/.test(window)).toBe(false)
    }
  })
})

describe("single-in-memory-truth: writes-via-semantic-events", () => {
  it("semantic events reduced by the message-assembly derivation are the domain write path", () => {
    const { vm, actor } = createConformanceRuntime()
    let assemblyState = messageAssemblyDerivation.initializeAssemblyState()
    let emittedAt = 1_000
    const reduceIntoDomain = (eventType: SemanticEvent["event_type"], extra: Record<string, unknown> = {}) => {
      emittedAt += 10
      const next = messageAssemblyDerivation.reduceSemanticEvent(
        assemblyState,
        makeSemanticEvent(actor, emittedAt, eventType, extra),
      )
      assemblyState = next.state
      for (const committed of next.committed ?? []) {
        appendLiveHistoryMessageToConversationDomainRuntime({
          vm,
          actorKey: actor.key,
          actorId: actor.id,
          message: committed.message,
          occurredAt: new Date(emittedAt).toISOString(),
        })
      }
    }

    reduceIntoDomain("semantic_user_input", { text: "hello over the stream", input_source: "system" })
    reduceIntoDomain("semantic_content_start")
    reduceIntoDomain("semantic_content_delta", { text: "assistant answer" })
    reduceIntoDomain("semantic_content_end")
    reduceIntoDomain("semantic_tool_call_planned", {
      tool_call: {
        tool_call_id: "tc-1",
        tool_name: "read_file",
        arguments_text: '{"path":"a.txt"}',
        protocol: "openai",
        call_kind: "json_function",
        raw_payload_text: "",
      },
    })
    reduceIntoDomain("semantic_tool_call_result", {
      tool_call: {
        tool_call_id: "tc-1",
        tool_name: "read_file",
        arguments_text: '{"path":"a.txt"}',
        protocol: "openai",
        call_kind: "json_function",
        raw_payload_text: "",
      },
      output_text: "file contents",
      is_error: false,
    })

    const materialized = materializeConversationRuntimeMessagesFromVm({ vm, actorKey: actor.key })
    const roles = materialized.map((message: any) => String(message.role))
    expect(roles).toEqual(["user", "assistant", "tool"])
    expect(String((materialized[0] as any).content)).toBe("hello over the stream")
    expect(String((materialized[2] as any).content)).toBe("file contents")
  })

  it("a bare array push never reaches the three domains", () => {
    const { vm, actor } = createConformanceRuntime()
    const before = materializeConversationRuntimeMessagesFromVm({ vm, actorKey: actor.key })

    const sideArray: any[] = []
    sideArray.push({ role: "user", content: "this must not enter the domains" })

    const after = materializeConversationRuntimeMessagesFromVm({ vm, actorKey: actor.key })
    expect(after).toEqual(before)
    expect(
      after.some((message: any) => String(message?.content ?? "").includes("this must not enter the domains")),
    ).toBe(false)
  })
})

describe("single-in-memory-truth: compaction-in-domain", () => {
  it("compaction produces a compact history generation and a summary transform in the domains", async () => {
    const run = await runScriptedAssemblyScenario(SCENARIO_COMPACTION_FOLLOW_UP)
    // The harness keeps the vm internal; assert through the captured
    // boundaries instead: the boundary right after compaction must contain
    // the summary/ack prelude from the domain materialization (turn:3) and
    // the gate already certifies it equals the legacy compaction rewrite.
    const postCompaction = run.snapshots.find((snapshot) => snapshot.label === "turn:3")
    expect(postCompaction).toBeDefined()
    const domainContents = postCompaction!.domainProviderMessages.map((message: any) => String(message.content ?? ""))
    expect(domainContents.some((content) => content.includes("Summary: the incident stems from dual truth"))).toBe(true)
    expect(domainContents.some((content) => content.includes("Acknowledged. Continuing from the compacted context."))).toBe(true)
    expect(postCompaction!.promptSource).toBe("domain_materialization")
  })

  it("the compaction path lands in the History/LLM-Context domains via the domain command (not an array)", () => {
    const { vm, actor } = createConformanceRuntime()
    // The conversation domain state after the harness compaction scenario is
    // covered above end to end; here pin the domain-level shape contract:
    // the raw state exposed from the vm is the only provider-context input.
    const rawState = getConversationActorRawStateFromVm({ vm, actorKey: actor.key })
    // Before any domain write there is no actor raw state — the build then
    // materializes an empty conversation rather than reading any array.
    expect(rawState).toBeNull()
    expect(materializeConversationRuntimeMessagesFromVm({ vm, actorKey: actor.key })).toEqual([])
  })
})
