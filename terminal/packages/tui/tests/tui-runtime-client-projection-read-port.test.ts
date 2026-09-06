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
  ConversationHistoryPageProjection,
  ConversationHistorySummaryProjection,
  ConversationProjectionReadPort,
  ConversationSessionProjection,
  PendingQuestionsProjection,
} from "@cell/ai-core-contract/runtime/ConversationProjectionReadPort"
import { createTuiRuntimeClient } from "../src/runtime/client/TuiRuntimeClient"
import { runtimeMessagesToTuiA1Messages } from "../src/app/tui_a1/data"

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
  | { method: "loadHistoryPageProjection"; sessionDir: string; actorKey: string; before?: string | null; after?: string | null }
  | { method: "loadHistorySummaryProjection"; sessionDir: string; actorKey: string }
  | { method: "loadSessionProjection"; sessionDir: string }
  | { method: "loadActorProjection"; sessionDir: string; actorKey: string }
  | { method: "loadPendingQuestionsProjection"; sessionDir: string }

function createRecordingPort(overrides?: {
  history?: ConversationHistoryProjection
  page?: ConversationHistoryPageProjection
  summary?: ConversationHistorySummaryProjection
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
    async loadHistoryPageProjection(target, query) {
      calls.push({
        method: "loadHistoryPageProjection",
        sessionDir: target.sessionDir,
        actorKey: target.actorKey,
        before: query?.before,
        after: query?.after,
      })
      return overrides?.page ?? {
        status: "ok",
        source: "empty",
        messages: [],
        pageInfo: {
          snapshotId: "snapshot",
          startCursor: null,
          hasPreviousPage: false,
          endCursor: null,
          hasNextPage: false,
        },
        observedBytes: 0,
        sourceBytes: 0,
      }
    },
    async loadHistorySummaryProjection(target) {
      calls.push({ method: "loadHistorySummaryProjection", sessionDir: target.sessionDir, actorKey: target.actorKey })
      return overrides?.summary ?? { source: "empty", observedBytes: 0, sourceBytes: 0 }
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
  it("catalog list uses a bounded history summary when a legacy sidecar has no preview", async () => {
    const { directory, sessionID } = makeMaterializedSession()
    tmpDirs.push(directory)
    const { port, calls } = createRecordingPort({
      summary: {
        source: "conversation",
        initialUserMessage: "first legacy prompt",
        latestMessage: "latest legacy response",
        observedBytes: 131_072,
        sourceBytes: 56_000_000,
      },
    })
    const sdk = createTuiRuntimeClient({
      mode: "local-runtime",
      directory,
      conversationProjectionReadPort: port,
    })

    const result = await sdk.client.session.list()

    expect(calls.some((call) => call.method === "loadHistorySummaryProjection")).toBe(true)
    expect(calls.some((call) => call.method === "loadHistoryProjection")).toBe(false)
    expect(result.data?.find((session) => session.id === sessionID)?.preview).toEqual({
      initialUserMessage: "first legacy prompt",
      latestMessage: "latest legacy response",
    })
  })

  it("catalog list uses the lightweight session summary without loading full history", async () => {
    const { directory, sessionID } = makeMaterializedSession()
    tmpDirs.push(directory)
    const sessionDir = path.join(directory, ".eidolon", "sessions", sessionID)
    fs.writeFileSync(
      path.join(sessionDir, "tui-session.json"),
      JSON.stringify({
        title: "A renamed long session",
        createdAt: "2026-09-01T10:00:00.000Z",
        updatedAt: "2026-09-02T10:00:00.000Z",
        preview: {
          initialUserMessage: "first durable prompt",
          latestMessage: "latest durable response",
        },
      }),
    )
    // The file is deliberately large enough to catch implementations that try
    // to infer catalog data by parsing the full authority instead of the
    // bounded summary sidecar.
    fs.writeFileSync(path.join(sessionDir, "conversation", "history.xnl"), "x".repeat(2_000_000))

    const { port, calls } = createRecordingPort()
    const sdk = createTuiRuntimeClient({
      mode: "local-runtime",
      directory,
      conversationProjectionReadPort: port,
    })

    const result = await sdk.client.session.list()

    expect(calls.some((call) => call.method === "loadHistoryProjection")).toBe(false)
    expect(result.data?.find((session) => session.id === sessionID)).toMatchObject({
      title: "A renamed long session",
      preview: {
        initialUserMessage: "first durable prompt",
        latestMessage: "latest durable response",
      },
    })
  })

  it("rename updates the lightweight projection and event stream without history hydration", async () => {
    const { directory, sessionID } = makeMaterializedSession()
    tmpDirs.push(directory)
    const { port, calls } = createRecordingPort()
    const sdk = createTuiRuntimeClient({
      mode: "local-runtime",
      directory,
      conversationProjectionReadPort: port,
    })
    const updates: any[] = []
    sdk.event.on((event: any) => {
      if (event.type === "session.updated") updates.push(event.properties?.info)
    })

    const result = await sdk.client.session.update({ sessionID, title: "Renamed immediately" })

    expect(calls.some((call) => call.method === "loadHistoryProjection")).toBe(false)
    expect(result.data?.title).toBe("Renamed immediately")
    expect(updates.at(-1)?.title).toBe("Renamed immediately")
    expect(JSON.parse(fs.readFileSync(path.join(directory, ".eidolon", "sessions", sessionID, "tui-session.json"), "utf8")))
      .toMatchObject({ title: "Renamed immediately", deleted: false })
  })

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
      {
        role: "tool",
        name: "read",
        content: '<context-resource status="loaded">tool progress after the user input</context-resource>',
        toolCallId: "call-port-order",
        resultMetadata: {
          contextResource: {
            status: "loaded",
            resourceId: "file:///workspace/README.md",
            revision: "abc123",
            totalLines: 1,
            requestedLines: "1-1",
            deliveredLines: "1-1",
            contentText: "tool progress after the user input",
          },
        },
      } as ChatMessage,
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

    const summary = JSON.parse(
      fs.readFileSync(path.join(directory, ".eidolon", "sessions", sessionID, "tui-session.json"), "utf8"),
    )
    expect(summary.preview).toEqual({
      initialUserMessage: "hello from the port",
      latestMessage: '<context-resource status="loaded">tool progress after the user input</context-resource>',
    })

    // The port (not a self-built repo) produced the visible history.
    expect(calls.some((call) => call.method === "loadSessionProjection")).toBe(true)
    expect(calls.some((call) => call.method === "loadHistoryProjection")).toBe(true)
    const parts = (result.data ?? [])
      .flatMap((entry: any) => (entry.parts ?? []))
    const texts = parts.filter((part: any) => part.type === "text").map((part: any) => part.text)
    expect(texts).toEqual(["hello from the port", "hi back from the port"])
    const toolParts = parts.filter((part: any) => part.type === "tool")
    expect(toolParts).toHaveLength(1)
    expect(toolParts[0]).toMatchObject({
        type: "tool",
        callID: "call-port-order",
        state: {
          status: "completed",
          output: '<context-resource status="loaded">tool progress after the user input</context-resource>',
          metadata: {
            contextResource: {
              status: "loaded",
              resourceId: "file:///workspace/README.md",
              contentText: "tool progress after the user input",
            },
          },
        },
      })
  })

  it("page mode hydrates only the requested tail page through the paginated projection", async () => {
    const { directory, sessionID } = makeMaterializedSession()
    tmpDirs.push(directory)
    const { port, calls } = createRecordingPort({
      page: {
        status: "ok",
        source: "conversation",
        messages: [{ role: "assistant", content: "latest bounded page" } as ChatMessage],
        pageInfo: {
          snapshotId: "snapshot-1",
          startCursor: "cursor-before",
          hasPreviousPage: true,
          endCursor: "cursor-after",
          hasNextPage: false,
        },
        historyGenerationId: "history-1",
        promptGenerationId: "prompt-1",
        observedBytes: 4096,
        sourceBytes: 4_000_000,
      },
    })
    const sdk = createTuiRuntimeClient({ mode: "local-runtime", directory, conversationProjectionReadPort: port })

    const result = await sdk.client.session.messages({ sessionID, page: true, limit: 40 })

    expect(result.page).toMatchObject({
      snapshotId: "snapshot-1",
      startCursor: "cursor-before",
      hasPreviousPage: true,
      endCursor: "cursor-after",
      hasNextPage: false,
      observedBytes: 4096,
    })
    expect(result.data).toHaveLength(1)
    expect(calls.some((call) => call.method === "loadHistoryPageProjection")).toBe(true)
    expect(calls.some((call) => call.method === "loadHistoryProjection")).toBe(false)
  })

  it("passes opaque forward boundaries through the read port without full hydration", async () => {
    const { directory, sessionID } = makeMaterializedSession()
    tmpDirs.push(directory)
    const { port, calls } = createRecordingPort({
      page: {
        status: "ok", source: "conversation",
        messages: [{ messageId: "ordered-message", role: "assistant", content: "adjacent newer page", startAt: 0 } as ChatMessage],
        messageOrder: { "ordered-message": [3, 800] },
        pageInfo: {
          snapshotId: "snapshot-1", startCursor: "before-newer", endCursor: "after-newer",
          hasPreviousPage: true, hasNextPage: true,
        },
        observedBytes: 4096, sourceBytes: 56_000_000,
      },
    })
    const sdk = createTuiRuntimeClient({ mode: "local-runtime", directory, conversationProjectionReadPort: port })
    const result = await sdk.client.session.messages({ sessionID, page: true, after: "opaque-after", limit: 40 })
    expect(calls.find((call) => call.method === "loadHistoryPageProjection")).toMatchObject({ after: "opaque-after" })
    expect(result.page).toMatchObject({ endCursor: "after-newer", hasNextPage: true })
    expect(calls.some((call) => call.method === "loadHistoryProjection")).toBe(false)
    expect(result.data?.[0]?.parts[0]).toMatchObject({ text: "adjacent newer page" })
    expect(result.data?.[0]?.info.historyOrder).toEqual([3, 800])
  })

  it("rejects ambiguous page directions before reading the projection", async () => {
    const { directory, sessionID } = makeMaterializedSession()
    tmpDirs.push(directory)
    const { port, calls } = createRecordingPort()
    const sdk = createTuiRuntimeClient({ mode: "local-runtime", directory, conversationProjectionReadPort: port })
    await expect(sdk.client.session.messages({ sessionID, page: true, cursor: "before", after: "after" }))
      .rejects.toThrow("history_page_ambiguous_direction")
    expect(calls).toHaveLength(0)
  })

  it("does not silently read the whole history when the bounded port is unavailable", async () => {
    const { directory, sessionID } = makeMaterializedSession()
    tmpDirs.push(directory)
    const { port, calls } = createRecordingPort()
    delete port.loadHistoryPageProjection
    const sdk = createTuiRuntimeClient({ mode: "local-runtime", directory, conversationProjectionReadPort: port })
    await expect(sdk.client.session.messages({ sessionID, page: true, limit: 40 }))
      .rejects.toThrow("history_page_projection_unavailable")
    expect(calls.some((call) => call.method === "loadHistoryProjection")).toBe(false)
  })

  it("loads recent user-input history through bounded pages without hydrating actor raw state", async () => {
    const { directory, sessionID } = makeMaterializedSession()
    tmpDirs.push(directory)
    const { port, calls } = createRecordingPort()
    port.loadActorProjection = async () => {
      throw new Error("full actor projection must not be loaded")
    }
    port.loadHistoryPageProjection = async (target, query) => {
      calls.push({
        method: "loadHistoryPageProjection",
        sessionDir: target.sessionDir,
        actorKey: target.actorKey,
        before: query?.before,
      })
      if (!query?.before) {
        return {
          status: "ok",
          source: "conversation",
          messages: [
            { role: "assistant", content: "latest answer" } as ChatMessage,
            { role: "user", content: "newer input", startAt: 20 } as ChatMessage,
          ],
          pageInfo: { snapshotId: "snapshot-1", startCursor: "older", hasPreviousPage: true, endCursor: "tail", hasNextPage: false },
          observedBytes: 4096,
          sourceBytes: 56_000_000,
        }
      }
      return {
        status: "ok",
        source: "conversation",
        messages: [{ role: "user", content: "older input", startAt: 10 } as ChatMessage],
        pageInfo: { snapshotId: "snapshot-1", startCursor: null, hasPreviousPage: false, endCursor: "middle", hasNextPage: true },
        observedBytes: 4096,
        sourceBytes: 56_000_000,
      }
    }
    const sdk = createTuiRuntimeClient({ mode: "local-runtime", directory, conversationProjectionReadPort: port })

    const result = await sdk.client.session.userInputs({ sessionID, limit: 2 })

    expect(result.data).toEqual([
      { text: "older input", createdAt: 10 },
      { text: "newer input", createdAt: 20 },
    ])
    expect(calls.filter((call) => call.method === "loadHistoryPageProjection")).toHaveLength(2)
    expect(calls.some((call) => call.method === "loadActorProjection")).toBe(false)
  })

  it("behavioral: structured history hydrates text and image parts without object coercion", async () => {
    const { directory, sessionID } = makeMaterializedSession()
    tmpDirs.push(directory)

    const historyMessages: ChatMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "你是谁" }],
      } as ChatMessage,
      {
        role: "user",
        content: [
          { type: "text", text: "查看 " },
          {
            type: "image",
            mime: "image/png",
            dataUrl: "data:image/png;base64,iVBORw0KGgo=",
            filename: "screen.png",
            sourceDigest: "sha256:history-image",
            size: 8,
          },
          { type: "text", text: " 并告诉我结果" },
        ],
      } as ChatMessage,
    ]
    const { port } = createRecordingPort({
      history: { source: "conversation", messages: historyMessages },
    })
    const sdk = createTuiRuntimeClient({
      mode: "local-runtime",
      directory,
      conversationProjectionReadPort: port,
    })

    const result = await sdk.client.session.messages({ sessionID })
    const parts = (result.data ?? []).flatMap((entry) => entry.parts ?? [])
    const texts = parts.filter((part) => part.type === "text").map((part) => part.text)
    const files = parts.filter((part) => part.type === "file")

    expect(texts).toEqual(["你是谁", "查看 ", " 并告诉我结果"])
    expect(texts.join("")).not.toContain("[object Object]")
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({
      type: "file",
      filename: "screen.png",
      mime: "image/png",
      url: "data:image/png;base64,iVBORw0KGgo=",
      attachment: {
        type: "image",
        sourceDigest: "sha256:history-image",
        size: 8,
      },
    })

    const sessions = await sdk.client.session.list()
    const preview = sessions.data?.find((session) => session.id === sessionID)?.preview
    expect(preview?.initialUserMessage).toBe("你是谁")
    expect(preview?.latestMessage).toBe("查看 并告诉我结果")
    expect(JSON.stringify(preview)).not.toContain("[object Object]")
  })

  it("restores tool calls as non-empty cards with the active actor provider epoch model", async () => {
    const { directory, sessionID } = makeMaterializedSession()
    tmpDirs.push(directory)
    const actorBinding = {
      actorKey: "actor-main",
      actorId: "actor-main-id",
      providerEpochReceiptV2: {
        targetProviderId: "deepseek-iqingwa",
        targetModelId: "deepseek-v4-pro",
      },
    } as any
    const session = {
      sessionId: sessionID,
      activeActorKey: "actor-main",
      actorBindings: { "actor-main": actorBinding },
      historyIndex: { version: 1, heads: {} },
      promptIndex: { version: 1, heads: {} },
      sessionIndex: {
        version: 1,
        sessionId: sessionID,
        session: {
          activeActorKey: "actor-main",
          actorBindings: { "actor-main": actorBinding },
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:01:00.000Z",
        },
        updatedAt: "2026-09-01T00:01:00.000Z",
      },
    } as any
    const historyMessages: ChatMessage[] = [
      ...Array.from({ length: 305 }, (_, index) => ({
        messageId: `filler-${index}`,
        role: "assistant",
        content: `historical answer ${index}`,
        startAt: index,
        endAt: index,
      } as ChatMessage)),
      {
        messageId: "request-1",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-shared", name: "read", input: { path: "/tmp/a" } }],
        startAt: 1_000,
      },
      {
        messageId: "result-1",
        role: "tool",
        name: "read",
        toolCallId: "call-shared",
        content: "first result",
        endAt: 2_000,
      },
      // A copied compaction record preserves the logical message identity and
      // toolCallId. It must update/dedupe the logical tool card before trimming.
      {
        messageId: "request-1",
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-shared", name: "read", input: { path: "/tmp/a" } }],
        startAt: 1_000,
      },
      {
        messageId: "result-1",
        role: "tool",
        name: "read",
        toolCallId: "call-shared",
        content: "first result",
        endAt: 2_000,
      },
      {
        messageId: "answer-1",
        role: "assistant",
        reasoning_content: "检查工具结果",
        content: "读取完成",
        startAt: 3_000,
        endAt: 4_000,
      },
      // Same logical message copied into a later compaction generation. Without
      // pre-projection dedupe, trimming the earlier copy deletes the parts map
      // entry shared by this retained copy and produces an empty card.
      {
        messageId: "filler-0",
        role: "assistant",
        content: "historical answer 0",
        startAt: 0,
        endAt: 0,
      },
    ] as ChatMessage[]
    const { port } = createRecordingPort({
      session,
      history: { source: "conversation", messages: historyMessages },
    })
    const sdk = createTuiRuntimeClient({
      mode: "local-runtime",
      directory,
      conversationProjectionReadPort: port,
    })

    const result = await sdk.client.session.messages({ sessionID })
    const entries = result.data ?? []
    const retainedCompactionCopy = entries.findLast((entry) => entry.info.id === "filler-0")
    expect(retainedCompactionCopy).toBeDefined()
    expect(retainedCompactionCopy?.parts).not.toEqual([])
    const tuiMessages = runtimeMessagesToTuiA1Messages(
      entries.map((entry) => entry.info),
      Object.fromEntries(entries.map((entry) => [entry.info.id, entry.parts ?? []])),
    )

    expect(tuiMessages.filter((message) => message.kind === "assistant" && !message.text)).toEqual([])
    expect(tuiMessages.some((message) => (
      message.kind === "assistant" && message.text === "historical answer 0"
    ))).toBe(true)
    const tools = tuiMessages.filter((message) => message.kind === "tool" && message.source === "runtime-part")
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({
      tool: "read",
      input: { path: "/tmp/a" },
      output: "first result",
      part: { state: { status: "completed" } },
    })
    const assistantInfos = entries.map((entry) => entry.info).filter((info) => info.role === "assistant")
    expect(assistantInfos).not.toHaveLength(0)
    expect(assistantInfos.every((info: any) => (
      info.providerID === "deepseek-iqingwa" && info.modelID === "deepseek-v4-pro"
    ))).toBe(true)
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
