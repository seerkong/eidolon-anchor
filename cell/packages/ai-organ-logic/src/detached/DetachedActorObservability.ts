export type DetachedLogSource = "stdout" | "stderr" | "system"
export type DetachedMessageRole = "user" | "assistant" | "tool" | "system_event"
export type DetachedMessageKind = "message" | "tool_call" | "tool_result" | "error" | "status"

export type DetachedRetentionPolicy = {
  maxEntries: number
  maxBytes: number
}

export type DetachedActorObservabilityOptions = {
  logs?: Partial<DetachedRetentionPolicy>
  messages?: Partial<DetachedRetentionPolicy>
}

export type DetachedLogEntry = {
  taskId: string
  seq: number
  source: DetachedLogSource
  text: string
  createdAt: number
}

export type DetachedMessageEntry = {
  taskId: string
  seq: number
  role: DetachedMessageRole
  kind: DetachedMessageKind
  text: string
  createdAt: number
  toolName?: string
  toolCallId?: string
}

export type DetachedLogAppendInput = {
  source: DetachedLogSource
  text: string
  createdAt?: number
}

export type DetachedMessageAppendInput = {
  role: DetachedMessageRole
  kind: DetachedMessageKind
  text: string
  createdAt?: number
  toolName?: string
  toolCallId?: string
}

export type DetachedLogQuery = {
  sources?: DetachedLogSource[]
  after_seq?: number
  limit_entries?: number
  limit_bytes?: number
  tail?: boolean
}

export type DetachedMessageQuery = {
  roles?: DetachedMessageRole[]
  kinds?: DetachedMessageKind[]
  after_seq?: number
  limit_entries?: number
  limit_bytes?: number
  tail?: boolean
}

export type DetachedObservationQueryResult<TEntry> = {
  ok: true
  task_id: string
  entries: TEntry[]
  first_seq: number | null
  next_seq: number
  dropped_entries: number
  dropped_bytes: number
  truncated: boolean
}

type DetachedRingState<TEntry extends { seq: number; text: string }> = {
  entries: TEntry[]
  nextSeq: number
  currentBytes: number
  droppedEntries: number
  droppedBytes: number
}

type DetachedTaskObservation = {
  logs: DetachedRingState<DetachedLogEntry>
  messages: DetachedRingState<DetachedMessageEntry>
  resultText?: string
}

const DEFAULT_LOG_POLICY: DetachedRetentionPolicy = {
  maxEntries: 512,
  maxBytes: 256 * 1024,
}

const DEFAULT_MESSAGE_POLICY: DetachedRetentionPolicy = {
  maxEntries: 512,
  maxBytes: 256 * 1024,
}

function normalizePolicy(
  policy: DetachedRetentionPolicy,
  override?: Partial<DetachedRetentionPolicy>,
): DetachedRetentionPolicy {
  const maxEntries = Number(override?.maxEntries ?? policy.maxEntries)
  const maxBytes = Number(override?.maxBytes ?? policy.maxBytes)
  return {
    maxEntries: Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : policy.maxEntries,
    maxBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : policy.maxBytes,
  }
}

function createRingState<TEntry extends { seq: number; text: string }>(): DetachedRingState<TEntry> {
  return {
    entries: [],
    nextSeq: 1,
    currentBytes: 0,
    droppedEntries: 0,
    droppedBytes: 0,
  }
}

function textBytes(text: string): number {
  return Buffer.byteLength(text, "utf-8")
}

function appendToRing<TEntry extends { seq: number; text: string }>(
  ring: DetachedRingState<TEntry>,
  entry: Omit<TEntry, "seq">,
  policy: DetachedRetentionPolicy,
): TEntry {
  const next = { ...entry, seq: ring.nextSeq++ } as TEntry
  ring.entries.push(next)
  ring.currentBytes += textBytes(next.text)
  trimRing(ring, policy)
  return { ...next }
}

function trimRing<TEntry extends { seq: number; text: string }>(
  ring: DetachedRingState<TEntry>,
  policy: DetachedRetentionPolicy,
): void {
  while (
    ring.entries.length > policy.maxEntries
    || (ring.entries.length > 1 && ring.currentBytes > policy.maxBytes)
  ) {
    const removed = ring.entries.shift()
    if (!removed) return
    ring.droppedEntries += 1
    const bytes = textBytes(removed.text)
    ring.droppedBytes += bytes
    ring.currentBytes -= bytes
  }
}

function applyEntryLimits<TEntry extends { text: string }>(
  entries: TEntry[],
  params: { limit_entries?: number; limit_bytes?: number; tail?: boolean },
): { entries: TEntry[]; truncated: boolean } {
  const limitEntries = Number(params.limit_entries)
  const hasEntryLimit = Number.isFinite(limitEntries) && limitEntries >= 0
  const entryLimited = Number.isFinite(limitEntries) && limitEntries >= 0
    ? params.tail === false
      ? entries.slice(0, Math.floor(limitEntries))
      : entries.slice(Math.max(0, entries.length - Math.floor(limitEntries)))
    : [...entries]

  const limitBytes = Number(params.limit_bytes)
  if (!Number.isFinite(limitBytes) || limitBytes < 0) {
    return {
      entries: entryLimited,
      truncated: hasEntryLimit && entryLimited.length < entries.length,
    }
  }

  const result: TEntry[] = []
  let total = 0
  const source = params.tail === false ? entryLimited : [...entryLimited].reverse()
  for (const entry of source) {
    const bytes = textBytes(entry.text)
    if (total + bytes > limitBytes) break
    total += bytes
    result.push(entry)
  }
  const byteLimited = params.tail === false ? result : result.reverse()
  return {
    entries: byteLimited,
    truncated: (hasEntryLimit && entryLimited.length < entries.length) || byteLimited.length < entryLimited.length,
  }
}

function queryRing<TEntry extends { seq: number; text: string }>(
  taskId: string,
  ring: DetachedRingState<TEntry>,
  entries: TEntry[],
  params: { after_seq?: number; limit_entries?: number; limit_bytes?: number; tail?: boolean },
): DetachedObservationQueryResult<TEntry> {
  const afterSeq = Number(params.after_seq)
  const ranged = Number.isFinite(afterSeq) ? entries.filter((entry) => entry.seq > afterSeq) : entries
  const limited = applyEntryLimits(ranged, params)
  return {
    ok: true,
    task_id: taskId,
    entries: limited.entries.map((entry) => ({ ...entry })),
    first_seq: ring.entries[0]?.seq ?? null,
    next_seq: ring.nextSeq,
    dropped_entries: ring.droppedEntries,
    dropped_bytes: ring.droppedBytes,
    truncated: limited.truncated || ring.droppedEntries > 0 || ring.droppedBytes > 0,
  }
}

export type DetachedActorObservabilityStore = {
  appendLog(taskId: string, input: DetachedLogAppendInput): DetachedLogEntry
  queryLogs(taskId: string, query: DetachedLogQuery): DetachedObservationQueryResult<DetachedLogEntry>
  appendMessage(taskId: string, input: DetachedMessageAppendInput): DetachedMessageEntry
  queryMessages(taskId: string, query: DetachedMessageQuery): DetachedObservationQueryResult<DetachedMessageEntry>
  bindFiber(taskId: string, fiberId: string): void
  getTaskIdForFiber(fiberId: string): string | null
}

export function createDetachedActorObservabilityStore(
  options: DetachedActorObservabilityOptions = {},
): DetachedActorObservabilityStore {
  const logPolicy = normalizePolicy(DEFAULT_LOG_POLICY, options.logs)
  const messagePolicy = normalizePolicy(DEFAULT_MESSAGE_POLICY, options.messages)
  const tasks = new Map<string, DetachedTaskObservation>()
  const taskIdByFiberId = new Map<string, string>()

  function getTask(taskId: string): DetachedTaskObservation {
    const existing = tasks.get(taskId)
    if (existing) return existing
    const created: DetachedTaskObservation = {
      logs: createRingState(),
      messages: createRingState(),
    }
    tasks.set(taskId, created)
    return created
  }

  return {
    appendLog(taskId, input) {
      return appendToRing<DetachedLogEntry>(
        getTask(taskId).logs,
        {
          taskId,
          source: input.source,
          text: input.text,
          createdAt: input.createdAt ?? Date.now(),
        },
        logPolicy,
      )
    },
    queryLogs(taskId, query) {
      const ring = getTask(taskId).logs
      const sources = new Set(query.sources ?? [])
      const entries = sources.size
        ? ring.entries.filter((entry) => sources.has(entry.source))
        : ring.entries
      return queryRing(taskId, ring, entries, query)
    },
    appendMessage(taskId, input) {
      return appendToRing<DetachedMessageEntry>(
        getTask(taskId).messages,
        {
          taskId,
          role: input.role,
          kind: input.kind,
          text: input.text,
          createdAt: input.createdAt ?? Date.now(),
          toolName: input.toolName,
          toolCallId: input.toolCallId,
        },
        messagePolicy,
      )
    },
    queryMessages(taskId, query) {
      const ring = getTask(taskId).messages
      const roles = new Set(query.roles ?? [])
      const kinds = new Set(query.kinds ?? [])
      const entries = ring.entries.filter((entry) => {
        if (roles.size && !roles.has(entry.role)) return false
        if (kinds.size && !kinds.has(entry.kind)) return false
        return true
      })
      return queryRing(taskId, ring, entries, query)
    },
    bindFiber(taskId, fiberId) {
      if (!taskId || !fiberId) return
      getTask(taskId)
      taskIdByFiberId.set(fiberId, taskId)
    },
    getTaskIdForFiber(fiberId) {
      return taskIdByFiberId.get(fiberId) ?? null
    },
  }
}

const STORE_BY_VM = new WeakMap<object, DetachedActorObservabilityStore>()

export function getDetachedActorObservabilityStore(vm: object): DetachedActorObservabilityStore {
  const existing = STORE_BY_VM.get(vm)
  if (existing) return existing
  const created = createDetachedActorObservabilityStore()
  STORE_BY_VM.set(vm, created)
  return created
}
