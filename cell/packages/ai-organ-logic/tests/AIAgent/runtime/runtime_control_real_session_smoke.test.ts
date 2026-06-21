import { describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent/ToolFuncComposer"
import { recoverAiAgentRuntime } from "@cell/ai-organ-logic/persistence/RuntimeSnapshots"
import { dryRunFileStoreAiRuntimeSessionUpgrade } from "@cell/ai-runtime-control-composer"
import {
  readRuntimeControlEffectEvidence,
} from "@cell/ai-file-store-logic"
import { rebuildEffectsFromLifecycleEvidence } from "@cell/ai-runtime-control-logic"
import {
  configureRuntimePersistenceSupport,
} from "@cell/ai-organ-logic"
import {
  LocalFileConversationPersistenceRepositoryFactory,
  LocalFileRuntimeDerivedIndexesStore,
  LocalFileRuntimeSnapshotRepositoryFactory,
} from "@cell/ai-support"

const historicalSessionDir =
  "/Users/kongweixian/ai/ai-coder/sparrow-agents/.eidolon/sessions/20260604001602__01KT74AEF400CGVZ5X318GJM8Y"

configureRuntimePersistenceSupport({
  snapshotRepositoryFactory: LocalFileRuntimeSnapshotRepositoryFactory,
  derivedIndexesStore: LocalFileRuntimeDerivedIndexesStore,
  conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
})

function makeMockAdapter() {
  return {
    type: "openai" as const,
    async createStream() {
      throw new Error("historical session smoke must not start a new LLM request during recovery")
    },
  }
}

describe("runtime-control real historical session smoke", () => {
  it("loads the upgraded historical session through the owned recovery gate", async () => {
    if (!fs.existsSync(historicalSessionDir)) {
      console.warn(`skip historical session smoke: ${historicalSessionDir} is not present`)
      return
    }

    const sessionCopyDir = path.join(os.tmpdir(), `eidolon-historical-session-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    fs.cpSync(historicalSessionDir, sessionCopyDir, { recursive: true })

    try {
      const dryRun = await dryRunFileStoreAiRuntimeSessionUpgrade({ sessionDir: sessionCopyDir })
      expect(dryRun.upgraded).toBe(true)
      expect(dryRun.hasCheckpoint).toBe(true)
      expect(["clean", "pending"]).toContain(dryRun.classification)
      expect(dryRun.blockers.every((blocker) => blocker.reason === "effect_pending")).toBe(true)

      let processStreamCalls = 0
      const recovered = await recoverAiAgentRuntime({
        sessionDir: sessionCopyDir,
        sessionId: "20260604001602__01KT74AEF400CGVZ5X318GJM8Y",
        llmClient: makeMockAdapter(),
        registries: { toolRegistry: composeToolRegistry({ includeInternalOnly: true }) } as any,
        actorCallbacks: {
          buildToolset: () => [],
          processStream: async () => {
            processStreamCalls += 1
            return { role: "assistant", content: "continued after recovered pending effect" }
          },
        },
      })

      expect(recovered).toBeTruthy()
      expect(recovered?.driver.getState()).toBeTruthy()
      const fiberId = Object.keys(recovered!.driver.getState().fibers)[0]
      const recoveredFiber = recovered!.driver.getState().fibers[fiberId]
      const execState = (recovered!.driver.inspectRuntime().fibers[fiberId] as any)?.execState

      const effects = rebuildEffectsFromLifecycleEvidence(await readRuntimeControlEffectEvidence(sessionCopyDir))
      if (dryRun.classification === "pending") {
        expect(recoveredFiber?.status).toBe("ready")
        for (const blocker of dryRun.blockers) {
          expect(effects[blocker.effectId!]?.status).toBe("failed")
        }
        if (execState?.phase === "wait_tool") {
          expect(execState?.pendingAiGenerated?.length).toBeGreaterThan(0)
        }
      } else {
        expect(recoveredFiber?.status).toBe("suspended")
        expect(recoveredFiber?.waitingReason).toBe("idle_external")
      }

      await recovered!.driver.tickUntilForegroundSettled({ now: Date.now(), maxTicks: 20, maxWallMs: 2000 })

      if (dryRun.classification === "pending") {
        const hadPendingToolEffect = dryRun.blockers.some((blocker) => {
          const effect = effects[blocker.effectId!]
          return effect?.handlerKey !== "llm:codex" && effect?.handlerKey !== "llm:recovery"
        })
        if (hadPendingToolEffect) {
          expect(recovered!.controlActor.messages.some((message: any) =>
            message?.role === "tool"
            && String(message?.content ?? "").includes("interrupted tool call")
          )).toBe(true)
        }
      } else {
        expect(processStreamCalls).toBe(0)
      }
    } finally {
      fs.rmSync(sessionCopyDir, { recursive: true, force: true })
    }
  })
})
