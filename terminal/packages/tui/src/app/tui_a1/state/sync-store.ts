import type {
  Agent,
  Command,
  Config,
  FormatterStatus,
  McpResource,
  McpStatus,
  Message,
  Part,
  Path,
  PermissionRequest,
  Provider,
  ProviderAuthMethod,
  ProviderListResponse,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
  VcsInfo,
  TuiRuntimeSdk,
} from "@terminal/core/AIAgent"
import type { SetStoreFunction } from "solid-js/store"
import { batch } from "solid-js"
import { produce, reconcile } from "solid-js/store"
import { Log } from "../../../support/util/log"
import { traceStreamEvent, streamDiagnosticNow } from "../../../support/util/stream-diagnostics"

export type SessionFileDiff = {
  path: string
  hunks: string
}

export type SyncStoreState = {
  status: "loading" | "partial" | "complete"
  provider: Provider[]
  provider_default: Record<string, string>
  provider_next: ProviderListResponse
  provider_auth: Record<string, ProviderAuthMethod[]>
  agent: Agent[]
  command: Command[]
  permission: Record<string, PermissionRequest[]>
  question: Record<string, QuestionRequest[]>
  config: Config
  session: Session[]
  session_status: Record<string, SessionStatus>
  session_diff: Record<string, SessionFileDiff[]>
  todo: Record<string, Todo[]>
  message: Record<string, Message[]>
  part: Record<string, Part[]>
  mcp: Record<string, McpStatus>
  mcp_resource: Record<string, McpResource>
  formatter: FormatterStatus[]
  vcs: VcsInfo | undefined
  path: Path
}

export type SyncEvent = {
  type?: string
  properties?: Record<string, any>
}

const MAX_SYNC_SESSION_MESSAGES = 100

const Binary = {
  search<T>(arr: T[] | undefined, key: string, selector: (t: T) => string) {
    const list = arr ?? []
    let low = 0
    let high = list.length - 1
    while (low <= high) {
      const mid = (low + high) >> 1
      const value = selector(list[mid])
      if (value === key) return { found: true as const, index: mid }
      if (value < key) low = mid + 1
      else high = mid - 1
    }
    return { found: false as const, index: low }
  },
}

function trimSessionMessageCache(state: SyncStoreState, sessionID: string): void {
  const messages = state.message[sessionID]
  if (!messages || messages.length <= MAX_SYNC_SESSION_MESSAGES) return

  const removed = messages.splice(0, messages.length - MAX_SYNC_SESSION_MESSAGES)
  for (const message of removed) {
    delete state.part[message.id]
  }
}

function hasCachedMessage(store: SyncStoreState, sessionID: string, messageID: string): boolean {
  const messages = store.message[sessionID]
  if (!messages) return false
  return Binary.search(messages, messageID, (message) => message.id).found
}

function replaceSessionMessageCache(
  state: SyncStoreState,
  sessionID: string,
  messages: Array<{ info: Message; parts?: Part[] }>,
): void {
  const retainedIDs = new Set(messages.map((entry) => entry.info.id))
  for (const message of state.message[sessionID] ?? []) {
    if (!retainedIDs.has(message.id)) {
      delete state.part[message.id]
    }
  }

  state.message[sessionID] = messages.map((entry) => entry.info)
  for (const entry of messages) {
    state.part[entry.info.id] = entry.parts ?? []
  }
}

export function createInitialSyncStore(): SyncStoreState {
  return {
    provider_next: {
      all: [],
      default: {},
      connected: [],
    },
    provider_auth: {},
    config: {},
    status: "loading",
    agent: [],
    permission: {},
    question: {},
    command: [],
    provider: [],
    provider_default: {},
    session: [],
    session_status: {},
    session_diff: {},
    todo: {},
    message: {},
    part: {},
    mcp: {},
    mcp_resource: {},
    formatter: [],
    vcs: undefined,
    path: { state: "", config: "", worktree: "", directory: "" },
  }
}

export function applySyncEvent(input: {
  event: SyncEvent
  store: SyncStoreState
  setStore: SetStoreFunction<SyncStoreState>
  runtimeClient: TuiRuntimeSdk
  bootstrap: () => Promise<void>
}) {
  const { event, store, setStore, runtimeClient, bootstrap } = input
  if (!event?.type) return
  const diagnosticStartedAt = streamDiagnosticNow()
  const traceApplied = () => {
    traceStreamEvent("sync.apply", event as any, {
      durationMs: Math.round(streamDiagnosticNow() - diagnosticStartedAt),
    })
  }

  switch (event.type) {
    case "server.instance.disposed":
      void bootstrap()
      traceApplied()
      break

    case "permission.replied": {
      const properties = event.properties as { sessionID: string; requestID: string } | undefined
      if (!properties) break
      const requests = store.permission[properties.sessionID]
      if (!requests) break
      const match = Binary.search(requests, properties.requestID, (r) => r.id)
      if (!match.found) break
      setStore(
        "permission",
        properties.sessionID,
        produce((draft) => {
          draft.splice(match.index, 1)
        }),
      )
      traceApplied()
      break
    }

    case "permission.asked": {
      const request = event.properties as PermissionRequest
      const requests = store.permission[request.sessionID]
      if (!requests) {
        setStore("permission", request.sessionID, [request])
        break
      }
      const match = Binary.search(requests, request.id, (r) => r.id)
      if (match.found) {
        setStore("permission", request.sessionID, match.index, reconcile(request))
        break
      }
      setStore(
        "permission",
        request.sessionID,
        produce((draft) => {
          draft.splice(match.index, 0, request)
        }),
      )
      traceApplied()
      break
    }

    case "question.replied":
    case "question.rejected": {
      const properties = event.properties as { sessionID: string; requestID: string } | undefined
      if (!properties) break
      const requests = store.question[properties.sessionID]
      if (!requests) break
      const match = Binary.search(requests, properties.requestID, (r) => r.id)
      if (!match.found) break
      setStore(
        "question",
        properties.sessionID,
        produce((draft) => {
          draft.splice(match.index, 1)
        }),
      )
      break
    }

    case "question.asked": {
      const request = event.properties as QuestionRequest
      const requests = store.question[request.sessionID]
      if (!requests) {
        setStore("question", request.sessionID, [request])
        break
      }
      const match = Binary.search(requests, request.id, (r) => r.id)
      if (match.found) {
        setStore("question", request.sessionID, match.index, reconcile(request))
        break
      }
      setStore(
        "question",
        request.sessionID,
        produce((draft) => {
          draft.splice(match.index, 0, request)
        }),
      )
      traceApplied()
      break
    }

    case "todo.updated":
      if (event.properties) setStore("todo", event.properties.sessionID, event.properties.todos)
      traceApplied()
      break

    case "session.diff":
      if (event.properties) setStore("session_diff", event.properties.sessionID, event.properties.diff)
      traceApplied()
      break

    case "session.deleted": {
      const info = event.properties?.info as Session | undefined
      if (!info) break
      const result = Binary.search(store.session, info.id, (session) => session.id)
      if (!result.found) break
      setStore(
        "session",
        produce((draft) => {
          draft.splice(result.index, 1)
        }),
      )
      traceApplied()
      break
    }

    case "session.created":
    case "session.updated": {
      const info = event.properties?.info as Session | undefined
      if (!info) break
      const result = Binary.search(store.session, info.id, (session) => session.id)
      if (result.found) {
        setStore("session", result.index, reconcile(info))
        break
      }
      setStore(
        "session",
        produce((draft) => {
          draft.splice(result.index, 0, info)
        }),
      )
      traceApplied()
      break
    }

    case "session.status":
      if (event.properties) setStore("session_status", event.properties.sessionID, event.properties.status)
      traceApplied()
      break

    case "message.updated": {
      const info = event.properties?.info as Message | undefined
      if (!info) break
      setStore(
        produce((draft) => {
          const messages = draft.message[info.sessionID]
          if (!messages) {
            draft.message[info.sessionID] = [info]
            return
          }

          const result = Binary.search(messages, info.id, (message) => message.id)
          if (result.found) {
            messages[result.index] = info
          } else {
            messages.splice(result.index, 0, info)
          }
          trimSessionMessageCache(draft, info.sessionID)
        }),
      )
      traceApplied()
      break
    }

    case "message.removed": {
      const properties = event.properties as { sessionID: string; messageID: string } | undefined
      if (!properties) break
      const messages = store.message[properties.sessionID]
      const result = Binary.search(messages, properties.messageID, (message) => message.id)
      if (!result.found) break
      setStore(
        produce((draft) => {
          draft.message[properties.sessionID]?.splice(result.index, 1)
          delete draft.part[properties.messageID]
        }),
      )
      traceApplied()
      break
    }

    case "message.part.updated": {
      const part = event.properties?.part as Part | undefined
      if (!part) break
      if (!hasCachedMessage(store, part.sessionID, part.messageID)) {
        traceStreamEvent("sync.apply", event as any, {
          durationMs: Math.round(streamDiagnosticNow() - diagnosticStartedAt),
          note: "missing-message-cache",
        })
        break
      }
      const parts = store.part[part.messageID]
      if (!parts) {
        setStore("part", part.messageID, [part])
        traceApplied()
        break
      }
      const result = Binary.search(parts, part.id, (entry) => entry.id)
      if (result.found) {
        setStore("part", part.messageID, result.index, reconcile(part))
        traceApplied()
        break
      }
      setStore(
        "part",
        part.messageID,
        produce((draft) => {
          draft.splice(result.index, 0, part)
        }),
      )
      traceApplied()
      break
    }

    case "message.part.removed": {
      const properties = event.properties as { messageID: string; partID: string } | undefined
      if (!properties) break
      const parts = store.part[properties.messageID]
      const result = Binary.search(parts, properties.partID, (part) => part.id)
      if (!result.found) break
      setStore(
        "part",
        properties.messageID,
        produce((draft) => {
          draft.splice(result.index, 1)
        }),
      )
      traceApplied()
      break
    }

    case "vcs.branch.updated":
      if (event.properties) setStore("vcs", { branch: event.properties.branch })
      break
  }
}

async function syncCurrentSessionIfNeeded(input: {
  runtimeClient: TuiRuntimeSdk
  args: { continue?: boolean; sessionID?: string }
  store: SyncStoreState
  setStore: SetStoreFunction<SyncStoreState>
}) {
  if (!input.args.continue || !input.args.sessionID) return
  await syncSessionData({
    sessionID: input.args.sessionID,
    store: input.store,
    setStore: input.setStore,
    runtimeClient: input.runtimeClient,
    fullSyncedSessions: new Set(),
  })
}

export async function bootstrapSyncStore(input: {
  runtimeClient: TuiRuntimeSdk
  args: { continue?: boolean; sessionID?: string }
  store: SyncStoreState
  setStore: SetStoreFunction<SyncStoreState>
  onError: (error: unknown) => Promise<void>
}) {
  const { runtimeClient, args, store, setStore, onError } = input
  Log.Default.info("tui.sync.bootstrap.start")
  const start = Date.now() - 30 * 24 * 60 * 60 * 1000
  const sessionListPromise = runtimeClient.client.session
    .list({ start })
    .then((x) => {
      const sessions = (x.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id))
      Log.Default.info("tui.sync.bootstrap.session_list", {
        count: sessions.length,
      })
      setStore("session", reconcile(sessions))
    })

  const blockingRequests: Promise<unknown>[] = [
    runtimeClient.client.config.providers({}, { throwOnError: true }).then((x) => {
      batch(() => {
        Log.Default.info("tui.sync.bootstrap.providers", {
          providerCount: x.data?.providers?.length ?? 0,
        })
        setStore("provider", reconcile(x.data!.providers))
        setStore("provider_default", reconcile(x.data!.default))
      })
    }),
    runtimeClient.client.provider.list({}, { throwOnError: true }).then((x) => {
      batch(() => {
        setStore("provider_next", reconcile(x.data!))
      })
    }),
    runtimeClient.client.app.agents({}, { throwOnError: true }).then((x) => setStore("agent", reconcile(x.data ?? []))),
    runtimeClient.client.config.get({}, { throwOnError: true }).then((x) => setStore("config", reconcile(x.data!))),
    ...(args.continue ? [sessionListPromise] : []),
  ]

  try {
    await Promise.all(blockingRequests)
    if (store.status !== "complete") setStore("status", "partial")

    await Promise.all([
      ...(args.continue ? [] : [sessionListPromise]),
      syncCurrentSessionIfNeeded({ runtimeClient, args, store, setStore }),
      runtimeClient.client.command.list().then((x) => setStore("command", reconcile(x.data ?? []))),
      runtimeClient.client.mcp.status().then((x) => setStore("mcp", reconcile(x.data!))),
      runtimeClient.client.experimental.resource.list().then((x) => setStore("mcp_resource", reconcile(x.data ?? {}))),
      runtimeClient.client.formatter.status().then((x) => setStore("formatter", reconcile(x.data!))),
      runtimeClient.client.session.status().then((x) => setStore("session_status", reconcile(x.data!))),
      runtimeClient.client.provider.auth().then((x) => setStore("provider_auth", reconcile(x.data ?? {}))),
      runtimeClient.client.vcs.get().then((x) => setStore("vcs", reconcile(x.data))),
      runtimeClient.client.path.get().then((x) => setStore("path", reconcile(x.data!))),
    ])

    setStore("status", "complete")
    Log.Default.info("tui.sync.bootstrap.complete")
    Log.Default.info("tui.sync.bootstrap.finished")
  } catch (error) {
    Log.Default.error("tui.sync.bootstrap.failed", {
      error: error instanceof Error ? error.message : String(error),
      name: error instanceof Error ? error.name : undefined,
      stack: error instanceof Error ? error.stack : undefined,
    })
    await onError(error)
  }
}

export function getSessionById(store: SyncStoreState, sessionID: string) {
  const match = Binary.search(store.session, sessionID, (session) => session.id)
  if (match.found) return store.session[match.index]
  return undefined
}

export function getSessionActivityStatus(store: SyncStoreState, sessionID: string) {
  const session = getSessionById(store, sessionID)
  if (!session) return "idle"
  if (session.time.compacting) return "compacting"
  const messages = store.message[sessionID] ?? []
  const last = messages.at(-1)
  if (!last) return "idle"
  if (last.role === "user") return "working"
  return last.time.completed ? "idle" : "working"
}

export async function syncSessionData(input: {
  sessionID: string
  store: SyncStoreState
  setStore: SetStoreFunction<SyncStoreState>
  runtimeClient: TuiRuntimeSdk
  fullSyncedSessions: Set<string>
}) {
  const { sessionID, store, setStore, runtimeClient, fullSyncedSessions } = input
  if (fullSyncedSessions.has(sessionID)) return

  const [session, messages, todo, diff] = await Promise.all([
    runtimeClient.client.session.get({ sessionID }, { throwOnError: true }),
    runtimeClient.client.session.messages({ sessionID, limit: 100 }),
    runtimeClient.client.session.todo({ sessionID }),
    runtimeClient.client.session.diff({ sessionID }),
  ])

  setStore(
    produce((draft) => {
      const match = Binary.search(draft.session, sessionID, (entry) => entry.id)
      if (match.found) draft.session[match.index] = session.data!
      if (!match.found) draft.session.splice(match.index, 0, session.data!)
      draft.todo[sessionID] = todo.data ?? []
      replaceSessionMessageCache(draft, sessionID, messages.data ?? [])
      draft.session_diff[sessionID] = diff.data ?? []
    }),
  )

  fullSyncedSessions.add(sessionID)
}
