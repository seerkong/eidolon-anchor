import path from "path"
import fs from "fs"
import { JsonlAppendOnlySink } from "./jsonl-log-sink"

type StreamDiagnosticStage =
  | "diagnostic.config"
  | "runtime.emit"
  | "runtime.turn"
  | "provider.receive"
  | "provider.flush"
  | "sync.apply"
  | "tui_a1.receive"
  | "tui_a1.project"
  | "runtime.history"
  | "history.scroll"

type StreamDiagnosticPart = {
  id?: string
  sessionID?: string
  messageID?: string
  type?: string
  text?: string
}

type StreamDiagnosticEvent = {
  type?: string
  properties?: {
    part?: StreamDiagnosticPart
    info?: {
      id?: string
      sessionID?: string
      role?: string
      time?: {
        created?: number
        completed?: number
      }
    }
    sessionID?: string
    status?: {
      type?: string
    }
  }
}

type StreamDiagnosticData = {
  stage: StreamDiagnosticStage
  eventType?: string
  sessionID?: string
  messageID?: string
  partID?: string
  partType?: string
  textLength?: number
  deltaTextLength?: number
  eventCount?: number
  partUpdateCount?: number
  elapsedMs?: number
  durationMs?: number
  droppedByCoalesce?: number
  note?: string
  stream?: string
  payloadLength?: number
  workDir?: string
  path?: string
  finalTextLength?: number
  currentTextLength?: number
  missingTextLength?: number
  chunkLength?: number
  controlCategory?: string
  sawChunk?: boolean
}

type StreamDiagnosticState = {
  lastTextLengthByStageAndPart: Map<string, number>
  lastAtByStageAndKey: Map<string, number>
  sinksBySession: Map<string, JsonlAppendOnlySink>
  sessionTouchOrder: string[]
  workDir: string
  fallbackSessionID?: string
}

const GLOBAL_STATE_KEY = "__eidolonTuiStreamDiagnosticsState"
const MAX_DIAGNOSTIC_KEYS = 2_000
const MAX_DIAGNOSTIC_SESSION_SINKS = 16

function getState(): StreamDiagnosticState {
  const root = globalThis as typeof globalThis & {
    [GLOBAL_STATE_KEY]?: StreamDiagnosticState
  }
  if (!root[GLOBAL_STATE_KEY]) {
    root[GLOBAL_STATE_KEY] = {
      lastTextLengthByStageAndPart: new Map(),
      lastAtByStageAndKey: new Map(),
      sinksBySession: new Map(),
      sessionTouchOrder: [],
      workDir: process.cwd(),
    }
  }
  return root[GLOBAL_STATE_KEY]
}

function rememberMapKey<T>(map: Map<string, T>, key: string, value: T): void {
  if (map.has(key)) {
    map.delete(key)
  }
  map.set(key, value)
  while (map.size > MAX_DIAGNOSTIC_KEYS) {
    const oldest = map.keys().next().value
    if (oldest === undefined) break
    map.delete(oldest)
  }
}

function touchSession(state: StreamDiagnosticState, sessionID: string): void {
  state.sessionTouchOrder = state.sessionTouchOrder.filter((id) => id !== sessionID)
  state.sessionTouchOrder.push(sessionID)
}

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now()
  }
  return Date.now()
}

function partKey(part?: StreamDiagnosticPart): string | undefined {
  if (!part?.sessionID || !part.messageID || !part.id) return undefined
  return `${part.sessionID}:${part.messageID}:${part.id}`
}

function summarizeEvent(event?: StreamDiagnosticEvent): Partial<StreamDiagnosticData> {
  const part = event?.properties?.part
  const info = event?.properties?.info
  return {
    eventType: event?.type,
    sessionID: part?.sessionID ?? info?.sessionID ?? event?.properties?.sessionID,
    messageID: part?.messageID ?? info?.id,
    partID: part?.id,
    partType: part?.type,
    textLength: typeof part?.text === "string" ? part.text.length : undefined,
  }
}

function resolveSessionID(data: Omit<StreamDiagnosticData, "stage">): string {
  const state = getState()
  return data.sessionID || state.fallbackSessionID || "unknown"
}

function hasSessionMarker(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".eidolon", "sessions"))
}

function findNearestDiagnosticsWorkDir(startDir: string): string {
  let current = path.resolve(startDir)
  const home = path.resolve(process.env.HOME || process.env.USERPROFILE || "")
  let nearest: string | undefined
  while (true) {
    if (hasSessionMarker(current) && current !== home) nearest = current
    const parent = path.dirname(current)
    if (parent === current) return nearest ?? path.resolve(startDir)
    if (parent === home) return nearest ?? path.resolve(startDir)
    current = parent
  }
}

function sinkForSession(sessionID: string): JsonlAppendOnlySink {
  const state = getState()
  const existing = state.sinksBySession.get(sessionID)
  if (existing) {
    touchSession(state, sessionID)
    return existing
  }

  const filePath = path.join(state.workDir, ".eidolon", "sessions", sessionID, "diagnostics", "tui-stream.jsonl")
  const sink = new JsonlAppendOnlySink(filePath)
  state.sinksBySession.set(sessionID, sink)
  touchSession(state, sessionID)
  while (state.sinksBySession.size > MAX_DIAGNOSTIC_SESSION_SINKS) {
    const oldest = state.sessionTouchOrder.shift()
    if (!oldest || oldest === sessionID) break
    const oldSink = state.sinksBySession.get(oldest)
    state.sinksBySession.delete(oldest)
    void oldSink?.flush().catch(() => {})
  }
  return sink
}

export function isTuiStreamDiagnosticsEnabled(): boolean {
  return process.env.EIDOLON_TUI_STREAM_DIAGNOSTICS === "1"
}

export function configureTuiStreamDiagnostics(input: {
  workDir?: string
  sessionID?: string
}): void {
  const state = getState()
  if (input.workDir) {
    state.workDir = findNearestDiagnosticsWorkDir(input.workDir)
  }
  if (input.sessionID) {
    state.fallbackSessionID = input.sessionID
  }
  if (isTuiStreamDiagnosticsEnabled()) {
    traceStreamDiagnostic("diagnostic.config", {
      sessionID: input.sessionID,
      workDir: state.workDir,
      path: input.sessionID
        ? path.join(state.workDir, ".eidolon", "sessions", input.sessionID, "diagnostics", "tui-stream.jsonl")
        : undefined,
    })
  }
}

export function streamDiagnosticNow(): number {
  return nowMs()
}

export function traceStreamDiagnostic(stage: StreamDiagnosticStage, data: Omit<StreamDiagnosticData, "stage"> = {}): void {
  if (!isTuiStreamDiagnosticsEnabled()) return
  const sessionID = resolveSessionID(data)
  sinkForSession(sessionID).append({
    timestamp: new Date().toISOString(),
    level: "DEBUG",
    service: "tui.stream",
    message: "tui.stream.diagnostic",
    data: {
      stage,
      ...data,
      sessionID,
    },
    line: `tui.stream.diagnostic ${stage} ${sessionID}`,
  })
}

export function traceStreamDiagnosticSession(sessionID: string, data: Record<string, unknown> = {}): void {
  if (!isTuiStreamDiagnosticsEnabled()) return
  const state = getState()
  sinkForSession(sessionID).append({
    timestamp: new Date().toISOString(),
    level: "INFO",
    service: "tui.stream",
    message: "tui.stream.session",
    data: {
      sessionID,
      path: path.join(state.workDir, ".eidolon", "sessions", sessionID, "diagnostics", "tui-stream.jsonl"),
      ...data,
    },
    line: `tui.stream.session ${sessionID}`,
  })
}

export async function flushTuiStreamDiagnostics(): Promise<void> {
  const state = getState()
  await Promise.all(Array.from(state.sinksBySession.values()).map((sink) => sink.flush()))
}

export function traceStreamEvent(stage: StreamDiagnosticStage, event: StreamDiagnosticEvent, extra: Omit<StreamDiagnosticData, "stage"> = {}): void {
  if (!isTuiStreamDiagnosticsEnabled()) return
  const summary = summarizeEvent(event)
  const key = summary.partID && summary.messageID && summary.sessionID
    ? `${stage}:${summary.sessionID}:${summary.messageID}:${summary.partID}`
    : `${stage}:${summary.eventType ?? "unknown"}`
  const at = nowMs()
  const state = getState()
  const previousAt = state.lastAtByStageAndKey.get(key)
  rememberMapKey(state.lastAtByStageAndKey, key, at)

  const rawPartKey = partKey(event.properties?.part)
  const stagedPartKey = rawPartKey ? `${stage}:${rawPartKey}` : undefined
  const previousTextLength = stagedPartKey ? state.lastTextLengthByStageAndPart.get(stagedPartKey) : undefined
  if (stagedPartKey && typeof summary.textLength === "number") {
    rememberMapKey(state.lastTextLengthByStageAndPart, stagedPartKey, summary.textLength)
  }

  traceStreamDiagnostic(stage, {
    ...summary,
    deltaTextLength:
      typeof summary.textLength === "number" && typeof previousTextLength === "number"
        ? summary.textLength - previousTextLength
        : undefined,
    elapsedMs: typeof previousAt === "number" ? Math.round(at - previousAt) : undefined,
    ...extra,
  })
}

export function traceRuntimeHistoryEvent(
  sessionID: string | undefined,
  event: { stream?: string; payload?: string },
): void {
  if (!isTuiStreamDiagnosticsEnabled()) return
  const stream = event.stream || "unknown"
  const state = getState()
  const key = `runtime.history:${sessionID || state.fallbackSessionID || "unknown"}:${stream}`
  const at = nowMs()
  const previousAt = state.lastAtByStageAndKey.get(key)
  rememberMapKey(state.lastAtByStageAndKey, key, at)
  traceStreamDiagnostic("runtime.history", {
    sessionID,
    stream,
    payloadLength: typeof event.payload === "string" ? event.payload.length : undefined,
    elapsedMs: typeof previousAt === "number" ? Math.round(at - previousAt) : undefined,
  })
}
