import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { join } from "node:path"
import { parseCreateSessionCommand } from "@cell/ai-runtime-host-contract"
import type { HostAuthorizationEffects, HostRequest, RuntimeHostPort, SessionSummary } from "@cell/ai-runtime-host-contract"
import { HostProtocolFailure } from "@cell/ai-runtime-host-logic"
import { createHostResourceEffects, createObservationCursorEffects, openHostSessionRegistry } from "@cell/ai-runtime-host-support"
import type { StoredHostSession } from "@cell/ai-runtime-host-support"
import type { SessionRuntimeConfig } from "./session/SessionRuntimeAssembly"
import { createRuntimeSession, type RuntimeSession } from "./sessionHost"

export type RuntimeHostOptions = {
  workDir: string
  globalRoot?: string
  hostStateDir?: string
  allowedProfiles?: readonly string[]
  runtimeConfig?: Omit<SessionRuntimeConfig, "workDir" | "globalRoot" | "profileId">
  authorization: HostAuthorizationEffects
}

/** Composes shared runtime owners. HTTP, browser and TUI rendering never enter this closure. */
export async function createHost(options: RuntimeHostOptions): Promise<RuntimeHostPort> {
  const workDir = realpathSync(options.workDir)
  const serverInstanceId = randomUUID()
  const allowedProfiles = Object.freeze([...(options.allowedProfiles ?? ["ai-coding"])])
  if (!allowedProfiles.length || allowedProfiles.some(id => id !== "ai-coding")) throw new Error("unsupported_web_profile")
  const registry = openHostSessionRegistry(options.hostStateDir ?? join(workDir, ".eidolon", "web-host"))
  const resources = createHostResourceEffects()
  const cursors = createObservationCursorEffects()
  const identity = { newId: randomUUID, now: Date.now }
  const sessions = new Map<string, Promise<RuntimeSession>>()
  let closed = false
  let closePromise: Promise<void> | undefined
  const failure = (request: HostRequest, status: number, code: string, cause?: unknown): never => {
    const failure = new HostProtocolFailure(status, { code, requestId: request.requestId, retryable: false })
    if (cause !== undefined) Object.defineProperty(failure, "cause", { value: cause })
    throw failure
  }
  const check = (request: HostRequest, target?: Parameters<HostAuthorizationEffects["permits"]>[1]) => {
    if (closed) failure(request, 503, "host_closed")
    if (options.authorization.currentGrantsVersion(request.principal.principalId) !== request.principal.grantsVersion || target && !options.authorization.permits(request.principal, target)) failure(request, 403, "forbidden")
  }
  const activate = (stored: StoredHostSession): Promise<RuntimeSession> => {
    const current = sessions.get(stored.sessionId)
    if (current) return current
    const opening = createRuntimeSession({ stored, epoch: randomUUID(), workDir, globalRoot: options.globalRoot,
      config: options.runtimeConfig, authorization: options.authorization, identity, resources })
    sessions.set(stored.sessionId, opening)
    // Failed assembly owns its cleanup. A new explicit request may retry the same identity.
    opening.catch(() => { if (sessions.get(stored.sessionId) === opening) sessions.delete(stored.sessionId) })
    return opening
  }
  const session = async (request: HostRequest, sessionId: string) => {
    check(request, { kind: "session", sessionId, action: "open" })
    const stored = registry.get(sessionId)
    if (!stored) failure(request, 404, "session_not_found")
    try {
      const active = await activate(stored!)
      check(request, { kind: "session", sessionId, action: "open" })
      return active
    } catch (error) {
      if (error instanceof HostProtocolFailure) throw error
      failure(request, error instanceof Error && error.message === "session_writer_conflict" ? 409 : 503,
        error instanceof Error && error.message === "session_writer_conflict" ? "session_writer_conflict" : "session_unavailable", error)
    }
  }
  return {
    capabilities(request) {
      check(request)
      return { protocolVersion: "1", serverInstanceId, authMode: "bearer", allowedProfiles, inputKinds: ["text"],
        features: { actorCreate: true, concurrentActors: true, cancelTurn: true, questionnaireAnswer: true, historyPagination: true, resumeStream: true },
        limits: { httpBodyBytes: 262144, textBytes: 65536, actorsPerSession: 64, queuedPerActor: 32, queuedPerSession: 128,
          subscriptionsPerPrincipal: 32, liveFrameBytes: 1048576, snapshotBytes: 8388608, parserBytes: 9437184, historyPageBytes: 1048576, contentChunkBytes: 262144 } }
    },
    async sessions(request, input) {
      check(request, { kind: "server", action: "list_sessions" })
      const limit = input.limit ?? 100
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) failure(request, 400, "invalid_limit")
      const binding = { epoch: serverInstanceId, ...request.principal, actors: ["session-directory"] }
      const offset = input.after ? cursors.read(binding, input.after) : 0
      if (offset === undefined) failure(request, 410, "session_cursor_expired")
      const visible: SessionSummary[] = []
      let index = 0
      for (const stored of registry.list()) {
        if (index++ < offset!) continue
        if (!options.authorization.permits(request.principal, { kind: "session", sessionId: stored.sessionId, action: "open" })) continue
        if (visible.length === limit) return { sessions: visible, nextCursor: cursors.issue(binding, index - 1) }
        visible.push((await session(request, stored.sessionId))!.summary)
      }
      return { sessions: visible }
    },
    async createSession(request, input) {
      check(request, { kind: "server", action: "create_session" })
      const command = parseCreateSessionCommand(input)
      if (command.expectedServerInstanceId !== serverInstanceId) failure(request, 409, "server_instance_mismatch")
      if (!allowedProfiles.includes(command.profileId)) failure(request, 403, "profile_not_allowed")
      const id = randomUUID()
      let stored: StoredHostSession
      try {
        stored = registry.create({ instanceId: serverInstanceId, principalId: request.principal.principalId, commandId: command.commandId,
          session: { sessionId: id, storageKey: id, profileId: command.profileId, displayName: "Conversation", createdAt: Date.now() } })
      } catch (error) {
        failure(request, error instanceof Error && error.message === "idempotency_conflict" ? 409 : 503,
          error instanceof Error && error.message === "idempotency_conflict" ? "idempotency_conflict" : "session_registry_unavailable")
      }
      return (await session(request, stored!.sessionId))!.summary
    },
    actors: async (request, selector) => (await session(request, selector.sessionId))!.actors(request),
    command: async (request, selector, input) => (await session(request, selector.sessionId))!.command(request, input),
    commandStatus: async (request, selector, input) => (await session(request, selector.sessionId))!.commandStatus(request, input),
    history: async (request, selector, input) => (await session(request, selector.sessionId))!.history(request, selector.actorId, input),
    content: async (request, selector, input) => (await session(request, selector.sessionId))!.content(request, selector.actorId, input),
    subscribe: async (request, selector, input) => (await session(request, selector.sessionId))!.subscribe(request, input),
    close() {
      if (closePromise) return closePromise
      closed = true
      closePromise = (async () => {
        const opened = await Promise.allSettled(sessions.values())
        const results = await Promise.allSettled(opened.filter((s): s is PromiseFulfilledResult<RuntimeSession> => s.status === "fulfilled").map(s => s.value.close()))
        resources.close()
        registry.close()
        sessions.clear()
        const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected")
        if (errors.length) throw new Error("host_close_failed")
      })()
      return closePromise
    },
  }
}
