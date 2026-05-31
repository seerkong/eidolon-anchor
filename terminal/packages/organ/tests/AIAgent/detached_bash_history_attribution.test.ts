import fs from "fs"
import os from "os"
import path from "path"
import { describe, expect, it } from "bun:test"

import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent/ToolFuncComposer"
import { getActorTranscriptPaths } from "@cell/ai-core-logic/runtime/ActorTranscript"
import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry"
import { createVM } from "@cell/ai-core-logic/runtime/runtime"
import { AgentEventGraph } from "@cell/ai-core-logic/stream/AgentEventGraph"
import { createLocalFileMessageHistoryEffects } from "@cell/ai-support"
import { StreamTranscript } from "@cell/symbiont-logic/stream/StreamTranscript"
import { createAiAgentOrchestratorDriverWithCooperative } from "@cell/ai-organ-logic/OrchestratorDriver"

function makeTempDir(prefix: string): string {
  const dir = path.join(os.tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
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

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((r) => setTimeout(r, 0))
  }
}

describe("Detached bash history attribution", () => {
  it("keeps delegate actor LLM think/tool events out of the control actor transcript", async () => {
    const workDir = makeTempDir("detached-history-")
    const sessionDir = makeTempDir("detached-history-session-")
    const messageHistory = createLocalFileMessageHistoryEffects({
      sessionPathProvider: () => sessionDir,
    })
    const adapter = makeMockAdapter()

    const processStream = async (_vm: any, actor: any) => {
      if (actor.type === "delegate" || actor.type === "detached") {
        return {
          role: "assistant",
          tool_calls: [
            {
              id: "tc-sub-bash-only",
              function: { name: "bash", arguments: JSON.stringify({ command: "pwd" }) },
            },
          ],
        }
      }

      return {
        role: "assistant",
        tool_calls: [
          {
            id: "tc-detached-bash-main",
            function: {
                name: "RunDetachedBash",
              arguments: JSON.stringify({ command: "pwd", agent_type: "code" }),
            },
          },
        ],
      }
    }

    const main = createActor({
      key: "main",
      llmClient: adapter,
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async (vm, actor) => processStream(vm, actor),
      },
    })

    const eventBus = new AgentEventGraph()
    const toolRegistry = composeToolRegistry({ includeInternalOnly: true })
    const vm = createVM({
      controlActorKey: "main",
      actors: { main },
      eventBus,
      outerCtx: { workDir },
      effects: { messageHistory },
      registries: {
        toolRegistry,
        agentRegistry: new AgentRegistry({
          code: { name: "code", description: "test agent", tools: "*", prompt: ["you are a test delegate actor"] },
        } as any),
      },
    })

    const messages: any[] = [{ role: "user", content: "hi" }]
    const mainFiberId = `${main.key}:${main.id}`
    const driver = createAiAgentOrchestratorDriverWithCooperative({
      fibers: [{ fiberId: mainFiberId, vm, actor: main, messages, basePriority: 1 }],
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })

    driver.resumeFiber(mainFiberId, Date.now())
    await driver.tickUntilForegroundSettled({ now: Date.now(), maxTicks: 50, maxWallMs: 2000 })
    await flushMicrotasks()
    await driver.tickUntilBackgroundSettled({ now: Date.now(), maxTicks: 100, maxWallMs: 2000 })
    await flushMicrotasks()

    const mainHistoryPath = getActorTranscriptPaths(sessionDir, {
      agentKey: main.key,
      actorId: main.id,
      actorType: main.type,
    }).transcriptPath
    expect(fs.existsSync(mainHistoryPath)).toBe(true)

    const mainParsed = StreamTranscript.parse(fs.readFileSync(mainHistoryPath, 'utf-8'))
    const mainPayload = mainParsed.records.map((r) => r.payload).join('\n')
    expect(mainPayload.includes('tc-sub-bash-only')).toBe(false)
    expect(mainPayload.includes('toolName":"bash"')).toBe(false)
  })
})
