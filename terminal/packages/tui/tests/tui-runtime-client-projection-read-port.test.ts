/**
 * P2 (track isolate-runtime-projection-surfaces) — TUI hydration + pending
 * questions go through the injected typed `ConversationProjectionReadPort`, not a
 * self-built repository or a raw `questionnaires.xnl` read.
 *
 * Two layers, matching behavior-delta cases `tui-hydration-through-port` and
 * `pending-questions-through-port`:
 *  - SOURCE-LEVEL: TuiRuntimeClient.ts no longer imports / constructs the
 *    persistence repo factory, no longer imports the single-source
 *    `loadConversation*` loaders, no longer imports `parseQuestionnaireRowsXnl`,
 *    and no longer raw-reads `questionnaires.xnl`.
 *  - BEHAVIORAL: with a recording fake `ConversationProjectionReadPort` injected
 *    into `createTuiRuntimeClient`, a local-runtime `session.messages()`
 *    hydration drives the port methods (not a self-built repo) and surfaces the
 *    port's history / pending-questions as the visible result.
 */
import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { ChatMessage } from "@shared/composer"
import type {
  ConversationActorProjection,
  ConversationHistoryProjection,
  ConversationProjectionReadPort,
  ConversationSessionProjection,
  PendingQuestionsProjection,
} from "@cell/ai-core-contract/runtime/ConversationProjectionReadPort"
import { createTuiRuntimeClient } from "../src/runtime/client/TuiRuntimeClient"

const TUI_RUNTIME_CLIENT_SOURCE = path.join(
  import.meta.dir,
  "..",
  "src",
  "runtime",
  "client",
  "TuiRuntimeClient.ts",
)

function readClientSource(): string {
  return fs.readFileSync(TUI_RUNTIME_CLIENT_SOURCE, "utf8")
}

type PortCall =
  | { method: "loadHistoryProjection"; sessionDir: string; actorKey: string }
  | { method: "loadSessionProjection"; sessionDir: string }
  | { method: "loadActorProjection"; sessionDir: string; actorKey: string }
  | { method: "loadPendingQuestionsProjection"; sessionDir: string }

function createRecordingPort(overrides?: {
  history?: ConversationHistoryProjection
  session?: ConversationSessionProjection
  actor?: ConversationActorProjection
  pending?: PendingQuestionsProjection
}): { port: ConversationProjectionReadPort; calls: PortCall[] } {
  const calls: PortCall[] = []
  const session: ConversationSessionProjection =
    overrides?.session ??
    ({
      sessionId: "fake",
      activeActorKey: "actor-main",
      actorBindings: { "actor-main": {} as any },
      historyIndex: { version: 1, heads: {} } as any,
      promptIndex: { version: 1, heads: {} } as any,
      sessionIndex: {
        version: 1,
        sessionId: "fake",
        session: {
          activeActorKey: "actor-main",
          actorBindings: { "actor-main": {} as any },
          createdAt: "2026-06-18T00:00:00.000Z",
          updatedAt: "2026-06-18T00:00:00.000Z",
        } as any,
        updatedAt: "2026-06-18T00:00:00.000Z",
      } as any,
    } as ConversationSessionProjection)

  const port: ConversationProjectionReadPort = {
    async loadHistoryProjection(target) {
      calls.push({ method: "loadHistoryProjection", sessionDir: target.sessionDir, actorKey: target.actorKey })
      return overrides?.history ?? { source: "empty", messages: [] }
    },
    async loadSessionProjection(target) {
      calls.push({ method: "loadSessionProjection", sessionDir: target.sessionDir })
      return session
    },
    async loadActorProjection(target) {
      calls.push({ method: "loadActorProjection", sessionDir: target.sessionDir, actorKey: target.actorKey })
      return overrides?.actor ?? null
    },
    async loadPendingQuestionsProjection(target) {
      calls.push({ method: "loadPendingQuestionsProjection", sessionDir: target.sessionDir })
      return overrides?.pending ?? { rows: [] }
    },
  }
  return { port, calls }
}

function makeMaterializedSession(): { directory: string; sessionID: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tui-proj-port-"))
  const sessionID = "session-proj-port"
  // Minimal materialization marker so `hasMaterializedSessionPersistence` passes
  // and the local-runtime hydration paths run. The actual conversation facts come
  // from the injected port, not these files.
  const conversationDir = path.join(directory, ".eidolon", "sessions", sessionID, "conversation")
  fs.mkdirSync(conversationDir, { recursive: true })
  fs.writeFileSync(path.join(conversationDir, "session.index.json"), JSON.stringify({ version: 1 }))
  return { directory, sessionID }
}

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("TuiRuntimeClient projection-read-port hydration", () => {
  it("source: no longer imports/constructs the persistence repo factory or single-source loaders", () => {
    const source = readClientSource()
    expect(source).not.toContain("LocalFileConversationPersistenceRepositoryFactory")
    expect(source).not.toContain("loadConversationHistoryMessages")
    expect(source).not.toContain("loadConversationSessionRawState")
    expect(source).not.toContain("loadConversationActorRawState")
  })

  it("source: no longer raw-reads questionnaires.xnl or parses its rows directly", () => {
    const source = readClientSource()
    expect(source).not.toContain("questionnaires.xnl")
    expect(source).not.toContain("parseQuestionnaireRowsXnl")
  })

  it("behavioral: session.messages hydration drives the injected port and surfaces its history", async () => {
    const { directory, sessionID } = makeMaterializedSession()
    tmpDirs.push(directory)

    const historyMessages: ChatMessage[] = [
      { role: "user", content: "hello from the port" } as ChatMessage,
      { role: "assistant", content: "hi back from the port" } as ChatMessage,
    ]
    const { port, calls } = createRecordingPort({
      history: { source: "conversation", messages: historyMessages },
    })

    const sdk = createTuiRuntimeClient({
      mode: "local-runtime",
      directory,
      conversationProjectionReadPort: port,
    })

    const result = await sdk.client.session.messages({ sessionID })

    // The port (not a self-built repo) produced the visible history.
    expect(calls.some((call) => call.method === "loadSessionProjection")).toBe(true)
    expect(calls.some((call) => call.method === "loadHistoryProjection")).toBe(true)
    const texts = (result.data ?? [])
      .flatMap((entry: any) => (entry.parts ?? []))
      .filter((part: any) => part.type === "text")
      .map((part: any) => part.text)
    expect(texts).toContain("hello from the port")
    expect(texts).toContain("hi back from the port")
  })

  it("behavioral: pending-questions hydration reads through the injected port", async () => {
    const { directory, sessionID } = makeMaterializedSession()
    tmpDirs.push(directory)

    const { port, calls } = createRecordingPort({
      pending: {
        rows: [
          {
            questionnaireId: "qn-1",
            toolCallId: "tc-1",
            ownerActorId: "actor-main",
            ownerActorKey: "actor-main",
            suspendPolicy: "suspend" as any,
            status: "pending",
            request: { title: "Pick one", questions: [{ id: "q1", prompt: "Pick one?", type: "text" }] } as any,
          },
        ],
      },
    })

    const sdk = createTuiRuntimeClient({
      mode: "local-runtime",
      directory,
      conversationProjectionReadPort: port,
    })

    const askedRequestIds: string[] = []
    sdk.event.on((event: any) => {
      if (event?.type === "question.asked") askedRequestIds.push(event.properties?.id)
    })

    await sdk.client.session.messages({ sessionID })

    expect(calls.some((call) => call.method === "loadPendingQuestionsProjection")).toBe(true)
    expect(askedRequestIds).toContain("qn-1")
  })
})
