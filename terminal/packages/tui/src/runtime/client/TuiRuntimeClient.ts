import { createEmitter } from "@solid-primitives/event-bus"
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { join as joinPath } from "node:path"
import type {
  Event,
  Session,
  Message,
  Part,
  AssistantMessage,
  Command,
  Question,
  QuestionAnswer,
  QuestionRequest,
  McpStatus,
  ToolPart,
  TuiRuntimeSdk,
} from "@terminal/core/AIAgent"
import type { ChatMessage } from "@shared/composer"
import {
  bootstrapConversationHistoryFromMessages,
  loadConversationHistoryMessages,
  loadConversationSessionRawState,
  LocalFileActorTranscriptStore,
  LocalFileConversationPersistenceRepositoryFactory,
} from "@cell/ai-support"
import { buildQuestionnaireProtocolQuestion, questionnaireOptionCode } from "@cell/ai-core-contract/runtime/QuestionnaireProtocol"
import { getMockRuntimeBridge } from "../mock/MockRuntime"
import {
  disposeTuiRuntimeBridge,
  getTuiRuntimeBridge,
  type RuntimeBridgeHistoryEvent,
  type RuntimeBridgeNotification,
  type TuiRuntimeBridge,
} from "../bridge/TuiRuntime"
import { COMMAND_ID } from "../../commands/catalog"
import { isDefaultSessionTitle, parseModelRef, makeMessageId, makePartId, makeSessionKey, makeSessionUlid } from "@terminal/core/AIAgent"
import {
  createRuntimeCatalog,
  type RuntimeClientMode,
  type RuntimeModel,
} from "../catalog/TuiRuntimeCatalog"
import {
  configureTuiStreamDiagnostics,
  traceRuntimeHistoryEvent,
  traceStreamDiagnostic,
  traceStreamDiagnosticSession,
  traceStreamEvent,
} from "../../support/util/stream-diagnostics"

function resolveBuiltinSlashCommand(rawInput: string): string | null {
  const normalized = rawInput.trim().toLowerCase()
  if (normalized === "/session" || normalized === "/resume" || normalized === "/continue") {
    return COMMAND_ID.SessionList
  }
  return null
}

type RuntimeBridgeFactory = (sessionID?: string) => Promise<TuiRuntimeBridge | null>

let runtimeBridgeFactoryOverride: null | RuntimeBridgeFactory = null

export function __setRuntimeBridgeFactoryForTest(factory: null | RuntimeBridgeFactory) {
  runtimeBridgeFactoryOverride = factory
}

async function getRuntimeBridge(sessionID: string, mode: RuntimeClientMode): Promise<TuiRuntimeBridge> {
  if (runtimeBridgeFactoryOverride) {
    const runtime = await runtimeBridgeFactoryOverride(sessionID)
    if (runtime) return runtime
    if (mode === "mock") {
      return await getMockRuntimeBridge()
    }
    throw new Error("Local runtime bridge unavailable")
  }
  if (mode === "mock") {
    return await getMockRuntimeBridge()
  }
  const runtime = await getTuiRuntimeBridge(sessionID)
  if (runtime) return runtime
  throw new Error("Local runtime bridge unavailable")
}

type TextPart = Extract<Part, { type: "text" }>

type LoadedRuntimeConversationState = {
  activeActorKey: string | null
  historyMessages: ChatMessage[]
  runtimeMessages: ChatMessage[]
}

function isTextPart(part: Part): part is TextPart {
  return part.type === "text"
}

function extractPromptContent(parts?: Part[]): string {
  return (parts ?? [])
    .filter(isTextPart)
    .map((part) => part.text)
    .join("")
}

export const hiddenAssistantCategories = new Set(["turn", "done", "toolcall", "result"] as const)
const STREAM_PART_UPDATE_INTERVAL_MS = 48
const STREAM_PART_UPDATE_MAX_BUFFER_CHARS = 96
const STREAM_FINAL_CATCHUP_CHARS_PER_FRAME = 96

export function shouldDisplayAssistantCategory(category?: string): boolean {
  return !category || !hiddenAssistantCategories.has(category as "turn" | "done" | "toolcall" | "result")
}

function tryParseJson(value?: string): unknown {
  if (!value) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function parseToolInput(argumentsText?: string): Record<string, unknown> {
  const parsed = tryParseJson(argumentsText)
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  if (typeof argumentsText === "string" && argumentsText.trim()) {
    return { raw: argumentsText }
  }
  return {}
}

function inferResultCount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.length
  if (!value || typeof value !== "object") return undefined

  const record = value as Record<string, unknown>
  const directKeys = ["count", "total", "numResults", "results"]
  for (const key of directKeys) {
    const count = inferResultCount(record[key])
    if (count !== undefined) return count
  }

  const arrayKeys = ["items", "data", "searchResults", "entries", "matches"]
  for (const key of arrayKeys) {
    if (Array.isArray(record[key])) return (record[key] as unknown[]).length
  }

  return undefined
}

function buildToolMetadata(tool: string, output?: string): Record<string, unknown> {
  const metadata: Record<string, unknown> = {}
  const parsed = tryParseJson(output)
  if ((tool === "edit" || tool === "multiedit" || tool === "apply_patch" || tool === "patch") && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>
    metadata.output = typeof record.message === "string" ? record.message : output
    if (typeof record.diff === "string" && record.diff.trim()) {
      metadata.diff = record.diff
    }
    if (typeof record.filePath === "string" && record.filePath.trim()) {
      metadata.filePath = record.filePath
    }
    return metadata
  }

  if (typeof output === "string") {
    metadata.output = output
  }

  const count = inferResultCount(parsed)

  if (tool === "codesearch" && count !== undefined) {
    metadata.results = count
  }
  if (tool === "websearch" && count !== undefined) {
    metadata.numResults = count
  }

  return metadata
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))]
}

function parseIsoTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null
  const ts = Date.parse(value)
  return Number.isFinite(ts) && ts > 0 ? ts : null
}

function firstFiniteTimestamp(values: Array<number | null | undefined>): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value
    }
  }
  return null
}

type TuiPersistedSessionMetadata = {
  title?: string
  deleted?: boolean
  updatedAt?: string
}

function maxFiniteTimestamp(values: Array<number | null | undefined>): number | null {
  const filtered = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0)
  if (filtered.length === 0) return null
  return Math.max(...filtered)
}

function normalizePreviewText(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
}

function previewTextFromChatMessage(message: ChatMessage | null | undefined): string {
  if (!message) return ""
  const content = normalizePreviewText(message.content)
  if (content) return content
  const reasoning = normalizePreviewText(message.reasoning_content)
  if (reasoning) return reasoning
  return ""
}

async function loadRuntimeConversationState(
  runtimeBridge: TuiRuntimeBridge | null | undefined,
): Promise<LoadedRuntimeConversationState | null> {
  const state = await runtimeBridge?.loadConversationState?.().catch(() => null)
  if (state) {
    return {
      activeActorKey: state.activeActorKey,
      historyMessages: state.historyMessages,
      runtimeMessages: state.runtimeMessages,
    }
  }

  const views = await runtimeBridge?.loadConversationViews?.().catch(() => null)
  if (!views) return null
  return {
    activeActorKey: views.activeActorKey,
    historyMessages: views.historyMessages,
    runtimeMessages: views.runtimeMessages,
  }
}

function buildSessionPreviewFromChatMessages(messages: ChatMessage[]): Session["preview"] | undefined {
  const initialUserMessage =
    messages
      .find((message) => message.role === "user" && previewTextFromChatMessage(message))
      ?? messages.find((message) => previewTextFromChatMessage(message))
  const latestMessage = [...messages].reverse().find((message) => previewTextFromChatMessage(message))

  if (!initialUserMessage && !latestMessage) return undefined
  return {
    initialUserMessage: initialUserMessage ? previewTextFromChatMessage(initialUserMessage) : undefined,
    latestMessage: latestMessage ? previewTextFromChatMessage(latestMessage) : undefined,
  }
}

function parseQuestionChoice(choice: unknown): { label: string; description?: string; value?: string } | null {
  if (typeof choice === "string") {
    const label = choice.trim()
    return label ? { label, value: label } : null
  }
  if (!isRecord(choice)) return null

  const value = typeof choice.value === "string" && choice.value.trim() ? choice.value.trim() : undefined
  const label = typeof choice.label === "string" && choice.label.trim() ? choice.label.trim() : value
  if (!label) return null
  const description =
    typeof choice.description === "string" && choice.description.trim() ? choice.description.trim() : undefined
  return { label, description, value }
}

function buildQuestionOptions(type: string, rawChoices: unknown): Array<{ label: string; description?: string; value?: string }> {
  const parsedChoices = Array.isArray(rawChoices)
    ? rawChoices.map((choice) => parseQuestionChoice(choice)).filter((choice): choice is NonNullable<typeof choice> => !!choice)
    : []
  if (parsedChoices.length > 0) {
    return parsedChoices
  }
  if (type === "yes_no") {
    return [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }]
  }
  return []
}

function parseQuestionnaireRequestPayload(sessionID: string, event: RuntimeBridgeHistoryEvent): QuestionRequest | null {
  if (event.stream !== "questionnaire_request") return null
  const parsed = tryParseJson(event.payload)
  return buildQuestionRequestFromRecord(sessionID, parsed)
}

function parseQuestionnaireResultPayload(event: RuntimeBridgeHistoryEvent): {
  questionnaireId: string
  status: string
} | null {
  if (event.stream !== "questionnaire_result") return null
  const parsed = tryParseJson(event.payload)
  if (!isRecord(parsed)) return null
  const questionnaireId = typeof parsed.questionnaireId === "string" ? parsed.questionnaireId.trim() : ""
  if (!questionnaireId) return null
  return {
    questionnaireId,
    status: typeof parsed.status === "string" ? parsed.status : "",
  }
}

function buildQuestionRequestFromRecord(sessionID: string, parsed: unknown): QuestionRequest | null {
  if (!isRecord(parsed)) return null

  const questionnaireId = typeof parsed.questionnaireId === "string" ? parsed.questionnaireId.trim() : ""
  if (!questionnaireId) return null

  const title = typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : undefined
  const intro = typeof parsed.intro === "string" && parsed.intro.trim() ? parsed.intro.trim() : undefined
  const toolCallId = typeof parsed.toolCallId === "string" && parsed.toolCallId.trim() ? parsed.toolCallId.trim() : undefined
  const kind = typeof parsed.kind === "string" && parsed.kind.trim() ? parsed.kind.trim() : undefined
  const suspendPolicy =
    typeof parsed.suspendPolicy === "string" && parsed.suspendPolicy.trim() ? parsed.suspendPolicy.trim() : undefined

  const questions: Question[] = (Array.isArray(parsed.questions) ? parsed.questions : []).flatMap((entry, index): Question[] => {
      if (!isRecord(entry)) return []
      const id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : `q${index + 1}`
      const questionText =
        typeof entry.prompt === "string" && entry.prompt.trim()
          ? entry.prompt.trim()
          : title ?? intro ?? `Question ${index + 1}`
      const type = typeof entry.type === "string" && entry.type.trim() ? entry.type.trim() : "text"
      const promptQuestion = buildQuestionnaireProtocolQuestion(
        {
          id,
          prompt: questionText,
          type,
          required: entry.required === true,
          choices: Array.isArray(entry.choices) ? (entry.choices as any[]) : undefined,
          helpText: typeof entry.helpText === "string" ? entry.helpText : undefined,
        },
        index,
      )
      const options = promptQuestion.options
        .filter((option) => !option.isCustom)
        .map((option) => ({
          label: option.label,
          description: option.description,
          value: option.value,
          code: option.code,
        }))
      const multiple = type === "multi_select"
      const custom = true
      return [{
        id,
        header: promptQuestion.header,
        question: questionText,
        options,
        multiple,
        custom,
        input_kind: type,
        type,
        required: entry.required === true,
        helpText: typeof entry.helpText === "string" ? entry.helpText : undefined,
        customOptionCode: promptQuestion.options.find((option) => option.isCustom)?.code,
      }]
    })

  if (questions.length === 0) {
    const promptQuestion = buildQuestionnaireProtocolQuestion(
      {
        id: "q1",
        prompt: title ?? intro ?? "Questionnaire",
        type: "text",
      },
      0,
    )
    questions.push({
      id: "q1",
      header: promptQuestion.header,
      question: title ?? intro ?? "Questionnaire",
      options: [],
      custom: true,
      input_kind: "text",
      type: "text",
      customOptionCode: promptQuestion.options.find((option) => option.isCustom)?.code,
    })
  }

  return {
    id: questionnaireId,
    sessionID,
    questionnaireId,
    toolCallId,
    title,
    intro,
    kind,
    suspendPolicy,
    questions,
  }
}

function serializeQuestionAnswers(request: QuestionRequest, answers: QuestionAnswer[]): string {
  const questions = request.questions ?? []
  if (questions.length === 0) {
    return answers.flatMap((answer) => answer).join("\n").trim()
  }

  const formatAnswer = (question: Question, answer?: QuestionAnswer): string => {
    if (!answer?.length) return ""
    if (questions.length === 1) {
      if (question.multiple) return answer.join(", ")
      return answer[0] ?? ""
    }

    const mapped = answer
      .map((value) => mapQuestionAnswerToken(question, value))
      .filter((value): value is string => Boolean(value))

    if (question.multiple) return mapped.join(", ")
    return mapped[0] ?? ""
  }

  if (questions.length === 1) {
    return formatAnswer(questions[0]!, answers[0]).trim()
  }

  return questions
    .map((question, index) => {
      const label =
        typeof question.header === "string" && question.header.trim()
          ? question.header.trim()
          : typeof question.id === "string" && question.id.trim()
            ? question.id.trim()
            : `Q${index + 1}`
      const value = formatAnswer(question, answers[index]).trim()
      return value ? `${label}: ${value}` : ""
    })
    .filter(Boolean)
    .join("\n")
}

function mapQuestionAnswerToken(question: Question, value: string): string | undefined {
  const options = Array.isArray(question.options) ? question.options : []
  const matched = options.find((option) => {
    if (!isRecord(option)) return false
    const label = typeof option.label === "string" ? option.label.trim() : ""
    const optionValue = typeof option.value === "string" ? option.value.trim() : ""
    return label === value || optionValue === value
  }) as (Record<string, unknown> & { label: string }) | undefined

  if (matched) {
    const code = typeof matched.code === "string" && matched.code.trim() ? matched.code.trim() : undefined
    return code || matched.label
  }

  const customCode =
    typeof question.customOptionCode === "string" && question.customOptionCode.trim()
      ? question.customOptionCode.trim()
      : question.custom !== false
        ? questionnaireOptionCode(options.length)
        : ""

  const trimmed = value.trim()
  if (!trimmed) return undefined
  return customCode ? `${customCode} ${trimmed}` : trimmed
}

function parseToolStartPayload(event: RuntimeBridgeHistoryEvent): {
  toolName: string
  toolCallId: string
  argumentsText?: string
} | null {
  if (event.stream !== "tool_call_start") return null
  const parsed = tryParseJson(event.payload)
  if (!parsed || typeof parsed !== "object") return null
  const record = parsed as Record<string, unknown>
  const toolName = typeof record.toolName === "string" ? record.toolName : ""
  const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : ""
  if (!toolName || !toolCallId) return null
  return {
    toolName,
    toolCallId,
    argumentsText: typeof record.arguments === "string" ? record.arguments : undefined,
  }
}

function parseToolResultPayload(event: RuntimeBridgeHistoryEvent): {
  toolName: string
  toolCallId: string
  result?: string
  isError: boolean
} | null {
  if (event.stream !== "tool_call_result") return null
  const parsed = tryParseJson(event.payload)
  if (!parsed || typeof parsed !== "object") return null
  const record = parsed as Record<string, unknown>
  const toolName = typeof record.toolName === "string" ? record.toolName : ""
  const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : ""
  if (!toolName || !toolCallId) return null
  return {
    toolName,
    toolCallId,
    result: typeof record.result === "string" ? record.result : undefined,
    isError: record.isError === true,
  }
}

const mockProjectID = "proj_1"
function makeEventEmitter() {
  const emitter = createEmitter<Event>()
  return {
    on: (handler: (event: Event) => void) => emitter.listen(handler),
    emit: (event: Event) => emitter.emit(event),
  }
}

export function createTuiRuntimeClient(options?: { mode?: RuntimeClientMode; directory?: string }): TuiRuntimeSdk {
  const eventEmitter = makeEventEmitter()
  const mode = options?.mode ?? "mock"
  const directory = options?.directory ?? process.cwd()
  configureTuiStreamDiagnostics({ workDir: directory })
  const catalog = createRuntimeCatalog(mode, directory)

  function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value))
  }

  const providerState = clone(catalog.providers)
  const providerListState = clone(catalog.providerList)
  const providerAuthState = clone(catalog.providerAuthMethods)
  const configState = clone(catalog.config)
  const agentState = clone(catalog.agents)

  function resolveMessageModel(input?: {
    model?: string | RuntimeModel
    providerID?: string
    modelID?: string
  }): RuntimeModel {
    if (input?.model && typeof input.model === "object" && input.model.providerID && input.model.modelID) {
      return input.model
    }
    if (typeof input?.model === "string") {
      return parseModelRef(input.model) ?? catalog.defaultModel
    }
    if (input?.providerID && input?.modelID) {
      return {
        providerID: input.providerID,
        modelID: input.modelID,
      }
    }
    return catalog.defaultModel
  }

  type SessionStatus = { type: "idle" | "busy" }
  type SessionState = {
    info: Session
    messages: Message[]
    parts: Record<string, Part[]>
    status: SessionStatus
    historyHydrated: boolean
    runtimePromise: Promise<TuiRuntimeBridge> | null
    runtimeNotificationUnsub: null | (() => void)
    materialized: boolean
  }

  function previewTextFromSessionParts(parts: Part[]): string {
    const text = normalizePreviewText(
      parts
        .filter((part) => part.type === "text" || part.type === "reasoning")
        .map((part) => ("text" in part ? part.text : ""))
        .join(" "),
    )
    if (text) return text

    const toolPart = parts.find((part) => part.type === "tool") as ToolPart | undefined
    if (!toolPart) return ""
    return normalizePreviewText(toolPart.state.output ?? toolPart.state.error ?? toolPart.tool)
  }

  function buildSessionPreviewFromState(state: SessionState): Session["preview"] | undefined {
    const entries = state.messages.map((info) => ({
      info,
      preview: previewTextFromSessionParts(state.parts[info.id] ?? []),
    }))
    const initialUserEntry =
      entries.find((entry) => entry.info.role === "user" && entry.preview)
      ?? entries.find((entry) => entry.preview)
    const latestEntry = [...entries].reverse().find((entry) => entry.preview)

    if (!initialUserEntry && !latestEntry) return undefined
    return {
      initialUserMessage: initialUserEntry?.preview || undefined,
      latestMessage: latestEntry?.preview || undefined,
    }
  }

  function getSessionDir(sessionID: string): string {
    return joinPath(directory, ".eidolon", "sessions", sessionID)
  }

  function getTuiSessionMetadataPath(sessionID: string): string {
    return joinPath(getSessionDir(sessionID), "tui-session.json")
  }

  const DEFAULT_SESSION_ID = "ses_1"
  let messageCounter = 0
  const sessions = new Map<string, SessionState>()
  const sessionOrder: string[] = []
  const pendingQuestionsByID = new Map<string, { sessionID: string; request: QuestionRequest }>()
  const mcpState: Record<string, McpStatus> =
    mode === "mock"
      ? {
          filesystem: { status: "connected" },
          memory: { status: "failed", error: "Connection failed" },
        }
      : {}

  function nextMessageId() {
    messageCounter += 1
    return makeMessageId()
  }
  function nextPartId() {
    messageCounter += 1
    return makePartId()
  }

  function nextSessionId() {
    if (mode === "local-runtime") {
      return makeSessionKey()
    }
    if (!sessions.has(DEFAULT_SESSION_ID)) {
      return DEFAULT_SESSION_ID
    }
    return `ses_${makeSessionUlid()}`
  }

  function buildSessionInfo(sessionID: string, now = Date.now()): Session {
    return {
      id: sessionID,
      slug: `session-${sessionID}`,
      projectID: mockProjectID,
      directory,
      title: catalog.sessionTitle,
      version: "0.0.0",
      materialized: false,
      time: { created: now, updated: now },
      permission: [],
    }
  }

  async function emitEvent(event: Event) {
    traceStreamEvent("runtime.emit", event)
    eventEmitter.emit(clone(event))
  }

  function clearPendingQuestionsForSession(sessionID: string) {
    for (const [requestID, pending] of pendingQuestionsByID.entries()) {
      if (pending.sessionID !== sessionID) continue
      pendingQuestionsByID.delete(requestID)
    }
  }

  async function emitQuestionAsked(state: SessionState, event: RuntimeBridgeHistoryEvent) {
    const request = parseQuestionnaireRequestPayload(state.info.id, event)
    if (!request) return
    pendingQuestionsByID.set(request.id, { sessionID: state.info.id, request })
    await emitEvent({ type: "question.asked", properties: request } as Event)
  }

  async function emitQuestionResult(state: SessionState, event: RuntimeBridgeHistoryEvent) {
    const payload = parseQuestionnaireResultPayload(event)
    if (!payload) return
    const pending = pendingQuestionsByID.get(payload.questionnaireId)
    if (!pending || pending.sessionID !== state.info.id) return
    if (payload.status === "ok") {
      pendingQuestionsByID.delete(payload.questionnaireId)
      await emitEvent({
        type: "question.replied",
        properties: {
          sessionID: state.info.id,
          requestID: payload.questionnaireId,
        },
      } as Event)
    }
  }

  async function readJson(filePath: string): Promise<unknown | null> {
    try {
      return JSON.parse(await readFile(filePath, "utf8"))
    } catch {
      return null
    }
  }

  async function loadTuiSessionMetadata(sessionID: string): Promise<TuiPersistedSessionMetadata> {
    const raw = await readJson(getTuiSessionMetadataPath(sessionID))
    if (!isRecord(raw)) return {}
    return {
      title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : undefined,
      deleted: raw.deleted === true,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
    }
  }

  async function writeTuiSessionMetadata(sessionID: string, metadata: TuiPersistedSessionMetadata): Promise<void> {
    if (mode !== "local-runtime") return
    await mkdir(getSessionDir(sessionID), { recursive: true })
    await writeFile(getTuiSessionMetadataPath(sessionID), `${JSON.stringify(metadata, null, 2)}\n`, "utf8")
  }

  async function loadPendingQuestionsFromSnapshot(sessionID: string): Promise<QuestionRequest[]> {
    if (mode !== "local-runtime") return []

    const sessionDir = joinPath(directory, ".eidolon", "sessions", sessionID, "runtime_state")
    const manifest = await readJson(joinPath(sessionDir, "manifest.json"))
    if (!isRecord(manifest)) return []

    const controlActorKey =
      typeof manifest.controlActorKey === "string" && manifest.controlActorKey.trim() ? manifest.controlActorKey.trim() : ""
    const actorFiles = isRecord(manifest.actorFiles) ? manifest.actorFiles : null
    if (!controlActorKey || !actorFiles) return []

    const actorFile = typeof actorFiles[controlActorKey] === "string" ? String(actorFiles[controlActorKey]) : ""
    if (!actorFile) return []

    const actorState = await readJson(joinPath(sessionDir, actorFile.replace(/actor\.json$/, "state.json")))
    const actorMailboxes = await readJson(joinPath(sessionDir, actorFile.replace(/actor\.json$/, "mailboxes.json")))
    if (!isRecord(actorState) || !isRecord(actorMailboxes)) return []

    const pendingQuestionnaires = isRecord(actorState.pendingQuestionnaires) ? actorState.pendingQuestionnaires : {}
    const mailboxes = isRecord(actorMailboxes.mailboxes) ? actorMailboxes.mailboxes : {}
    const controlQueue = Array.isArray(mailboxes.control) ? mailboxes.control : []

    const pendingIDs = new Set(
      controlQueue
        .filter((entry) => isRecord(entry) && entry.kind === "questionnaire_pending")
        .map((entry) => (typeof entry.questionnaireId === "string" ? entry.questionnaireId.trim() : ""))
        .filter(Boolean),
    )

    return [...pendingIDs]
      .map((questionnaireId) => {
        const payload = pendingQuestionnaires[questionnaireId]
        if (!isRecord(payload)) return null
        return buildQuestionRequestFromRecord(sessionID, payload)
      })
      .filter((request): request is QuestionRequest => !!request)
  }

  async function hydratePendingQuestionsFromSnapshot(state: SessionState) {
    const pending = await loadPendingQuestionsFromSnapshot(state.info.id)
    for (const request of pending) {
      if (pendingQuestionsByID.has(request.id)) continue
      pendingQuestionsByID.set(request.id, { sessionID: state.info.id, request })
      await emitEvent({ type: "question.asked", properties: request } as Event)
    }
  }

  async function hasMaterializedSessionPersistence(sessionID: string): Promise<boolean> {
    if (mode !== "local-runtime") return false

    const sessionDir = getSessionDir(sessionID)
    const root = await stat(sessionDir).catch(() => null)
    if (!root?.isDirectory()) return false

    const candidates = [
      joinPath(sessionDir, "conversation", "history.index.json"),
      joinPath(sessionDir, "conversation", "prompt.index.json"),
      joinPath(sessionDir, "conversation", "session.index.json"),
      joinPath(sessionDir, "runtime_state", "manifest.json"),
    ]
    for (const filePath of candidates) {
      const entry = await stat(filePath).catch(() => null)
      if (entry?.isFile() && entry.size > 0) return true
    }

    const actorsDir = joinPath(sessionDir, "actors")
    const actorDirs = await readdir(actorsDir, { withFileTypes: true }).catch(() => [])
    for (const actorDir of actorDirs) {
      if (!actorDir.isDirectory()) continue
      const transcriptPath = joinPath(actorsDir, actorDir.name, "transcript.txt")
      const transcript = await stat(transcriptPath).catch(() => null)
      if (transcript?.isFile() && transcript.size > 0) return true
    }

    return false
  }

  async function listPersistedSessionIds(): Promise<string[]> {
    if (mode !== "local-runtime") return []
    try {
      const entries = await readdir(joinPath(directory, ".eidolon", "sessions"), { withFileTypes: true })
      const materialized = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => ({
            sessionID: entry.name,
            materialized: await hasMaterializedSessionPersistence(entry.name),
          })),
      )
      return materialized
        .filter((entry) => entry.materialized)
        .map((entry) => entry.sessionID)
        .sort((a, b) => a.localeCompare(b))
    } catch {
      return []
    }
  }

  async function loadPersistedControlActor(sessionDir: string): Promise<{
    actorKey: string
    actorId: string
    actorType?: string
    identity?: Record<string, unknown> | null
  } | null> {
    const runtimeStateDir = joinPath(sessionDir, "runtime_state")
    const manifest = await readJson(joinPath(runtimeStateDir, "manifest.json"))
    if (!isRecord(manifest)) return null

    const actorKey =
      typeof manifest.controlActorKey === "string" && manifest.controlActorKey.trim()
        ? manifest.controlActorKey.trim()
        : ""
    const actorFiles = isRecord(manifest.actorFiles) ? manifest.actorFiles : null
    if (!actorKey || !actorFiles) return null

    const actorFile = typeof actorFiles[actorKey] === "string" ? actorFiles[actorKey] : ""
    if (!actorFile) return null

    const actorSnapshot = await readJson(joinPath(runtimeStateDir, actorFile))
    if (!isRecord(actorSnapshot)) return null

    const actorId = typeof actorSnapshot.id === "string" && actorSnapshot.id.trim() ? actorSnapshot.id.trim() : ""
    if (!actorId) return null

    return {
      actorKey,
      actorId,
      actorType: typeof actorSnapshot.type === "string" ? actorSnapshot.type : undefined,
      identity: isRecord(actorSnapshot.identity) ? actorSnapshot.identity : null,
    }
  }

  async function loadPersistedSessionInfo(sessionID: string): Promise<Session | null> {
    if (mode !== "local-runtime") return null

    if (!(await hasMaterializedSessionPersistence(sessionID))) {
      return null
    }

    const sessionDir = getSessionDir(sessionID)
    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)
    const sessionStats = await stat(sessionDir).catch(() => null)
    const sessionIndex = await repository.loadSessionIndex().catch(() => null)
    const tuiMetadata = await loadTuiSessionMetadata(sessionID)
    if (tuiMetadata.deleted) return null
    const controlActor = await loadPersistedControlActor(sessionDir)

    const activeActorKey =
      (sessionIndex?.session.activeActorKey && sessionIndex.session.activeActorKey.trim())
      || Object.keys(sessionIndex?.session.actorBindings ?? {})[0]
      || controlActor?.actorKey
      || null

    let historyMessages: ChatMessage[] = []
    if (activeActorKey) {
      const loaded = await loadConversationHistoryMessages({
        sessionDir,
        actorKey: activeActorKey,
        repository,
      }).catch(() => ({ source: "empty", messages: [] as ChatMessage[] }))

      if (loaded.source === "conversation" && loaded.messages.length > 0) {
        historyMessages = loaded.messages
      } else if (controlActor && controlActor.actorKey === activeActorKey) {
        const transcriptLoaded = await LocalFileActorTranscriptStore.loadMessages({
          sessionDir,
          actor: {
            agentKey: controlActor.actorKey,
            actorId: controlActor.actorId,
            actorType: controlActor.actorType,
            identity: controlActor.identity,
          },
        }).catch(() => ({ messages: [] as ChatMessage[] }))
        historyMessages = transcriptLoaded.messages
      }
    }

    const preview = buildSessionPreviewFromChatMessages(historyMessages)
    const firstMessageTs = firstFiniteTimestamp(
      historyMessages.flatMap((message) => [message.startAt ?? null, message.endAt ?? null]),
    )
    const lastMessageTs = firstFiniteTimestamp(
      [...historyMessages]
        .reverse()
        .flatMap((message) => [message.endAt ?? null, message.startAt ?? null]),
    )
    const created =
      firstFiniteTimestamp([
        parseIsoTimestamp(sessionIndex?.session.createdAt),
        firstMessageTs,
        sessionStats?.birthtimeMs,
        sessionStats?.mtimeMs,
      ])
      ?? Date.now()
    const updated =
      firstFiniteTimestamp([
        parseIsoTimestamp(sessionIndex?.session.updatedAt),
        parseIsoTimestamp(sessionIndex?.updatedAt),
        lastMessageTs,
        sessionStats?.mtimeMs,
        created,
      ])
      ?? created

    return {
      ...buildSessionInfo(sessionID, created),
      materialized: true,
      title: tuiMetadata.title ?? buildSessionInfo(sessionID, created).title,
      time: {
        created,
        updated,
      },
      preview,
    }
  }

  function buildHistorySessionMessage(params: {
    sessionID: string
    message: any
    messageIndex: number
  }): { info: Message; parts: Part[] } {
    const createdAt = Date.now() + params.messageIndex
    const role = String(params.message?.role ?? "assistant")
    if (role === "user") {
      const info: Message = {
        id: nextMessageId(),
        sessionID: params.sessionID,
        role: "user",
        time: { created: createdAt, completed: createdAt },
        agent: "build",
        variant: "history",
      } as Message
      const parts: Part[] = [
        {
          id: nextPartId(),
          sessionID: params.sessionID,
          messageID: info.id,
          type: "text",
          text: String(params.message?.content ?? ""),
          synthetic: false,
          ignored: false,
        },
      ]
      return { info, parts }
    }

    const info: Message = {
      id: nextMessageId(),
      sessionID: params.sessionID,
      role: role === "assistant" ? "assistant" : role,
      time: { created: createdAt, completed: createdAt },
      agent: role === "tool" ? "tool" : "build",
      modelID: catalog.defaultModel.modelID,
      providerID: catalog.defaultModel.providerID,
      mode: "history",
      path: { cwd: directory, root: directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
    } as Message

    const parts: Part[] = []
    if (typeof params.message?.reasoning_content === "string" && params.message.reasoning_content.trim()) {
      parts.push({
        id: nextPartId(),
        sessionID: params.sessionID,
        messageID: info.id,
        type: "reasoning",
        text: params.message.reasoning_content,
      })
    }
    parts.push({
      id: nextPartId(),
      sessionID: params.sessionID,
      messageID: info.id,
      type: "text",
      text: String(params.message?.content ?? ""),
      synthetic: false,
      ignored: false,
    })
    return { info, parts }
  }

  async function hydrateSessionHistoryFromPersistence(state: SessionState) {
    if (state.historyHydrated || mode !== "local-runtime" || state.messages.length > 0) {
      state.historyHydrated = true
      return
    }

    const runtimeBridge = await ensureSessionRuntime(state).catch(() => null)
    const runtimeState = await loadRuntimeConversationState(runtimeBridge)
    if (runtimeState && runtimeState.historyMessages.length > 0) {
      const historical = runtimeState.historyMessages.map((message, messageIndex) =>
        buildHistorySessionMessage({
          sessionID: state.info.id,
          message,
          messageIndex,
        }),
      )
      state.messages.splice(0, state.messages.length, ...historical.map((entry) => entry.info))
      state.parts = Object.fromEntries(historical.map((entry) => [entry.info.id, entry.parts]))
      touchSession(state)
      state.historyHydrated = true
      return
    }

    const sessionDir = getSessionDir(state.info.id)
    const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir)
    const sessionRawState = await loadConversationSessionRawState({ sessionDir, repository })
    const controlActor = await loadPersistedControlActor(sessionDir)
    const activeActorKey =
      sessionRawState.activeActorKey
      ?? Object.keys(sessionRawState.actorBindings)[0]
      ?? controlActor?.actorKey
      ?? null

    if (!activeActorKey) {
      state.historyHydrated = true
      return
    }

    let loaded = await loadConversationHistoryMessages({
      sessionDir,
      actorKey: activeActorKey,
      repository,
    })
    if (loaded.source !== "conversation" && controlActor && controlActor.actorKey === activeActorKey) {
      const transcriptLoaded = await LocalFileActorTranscriptStore.loadMessages({
        sessionDir,
        actor: {
          agentKey: controlActor.actorKey,
          actorId: controlActor.actorId,
          actorType: controlActor.actorType,
          identity: controlActor.identity,
        },
      })
      if (transcriptLoaded.messages.length > 0) {
        await bootstrapConversationHistoryFromMessages({
          sessionId: state.info.id,
          actorKey: controlActor.actorKey,
          actorId: controlActor.actorId,
          messages: transcriptLoaded.messages,
          transcriptPath: transcriptLoaded.path,
          repository,
        })
        loaded = await loadConversationHistoryMessages({
          sessionDir,
          actorKey: activeActorKey,
          repository,
        })
      }
    }
    if (loaded.source !== "conversation" || loaded.messages.length === 0) {
      state.historyHydrated = true
      return
    }

    const historical = loaded.messages.map((message, messageIndex) =>
      buildHistorySessionMessage({
        sessionID: state.info.id,
        message,
        messageIndex,
      }),
    )
    state.messages.splice(0, state.messages.length, ...historical.map((entry) => entry.info))
    state.parts = Object.fromEntries(historical.map((entry) => [entry.info.id, entry.parts]))
    touchSession(state)
    state.historyHydrated = true
  }

  function touchSession(state: SessionState, now = Date.now()) {
    state.info = {
      ...state.info,
      time: {
        ...state.info.time,
        updated: now,
      },
    }
  }

  function markSessionMaterialized(state: SessionState) {
    if (state.materialized) return
    state.materialized = true
    state.info = {
      ...state.info,
      materialized: true,
    }
  }

  function addSessionMessage(state: SessionState, info: Message, parts: Part[]) {
    markSessionMaterialized(state)
    const existingIndex = state.messages.findIndex((message) => message.id === info.id)
    if (existingIndex >= 0) {
      state.messages[existingIndex] = info
    } else {
      state.messages.push(info)
    }
    state.parts[info.id] = parts
    touchSession(state)
    state.info = {
      ...state.info,
      preview: buildSessionPreviewFromState(state),
    }
  }

  async function emitRuntimeNotification(state: SessionState, notification: RuntimeBridgeNotification) {
    const text = String(notification?.text ?? "").trim()
    if (!text) return

    const assistantMessage: AssistantMessage = {
      id: nextMessageId(),
      sessionID: state.info.id,
      role: "assistant",
      time: { created: Date.now(), completed: Date.now() },
      modelID: catalog.defaultModel.modelID,
      providerID: catalog.defaultModel.providerID,
      mode: notification.category ?? "assist",
      agent: "build",
      path: { cwd: directory, root: directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
    }
    const assistantPart: TextPart = {
      id: nextPartId(),
      sessionID: state.info.id,
      messageID: assistantMessage.id,
      type: "text",
      text,
      synthetic: false,
      ignored: false,
    }
    addSessionMessage(state, assistantMessage, [assistantPart])
    await emitEvent({ type: "message.updated", properties: { info: assistantMessage } } as Event)
    await emitEvent({ type: "message.part.updated", properties: { part: assistantPart } } as Event)
  }

  function createSessionState(sessionID = nextSessionId()): SessionState {
    configureTuiStreamDiagnostics({ sessionID })
    traceStreamDiagnosticSession(sessionID, {
      source: "runtime.session.create",
      mode,
      directory,
    })
    const state: SessionState = {
      info: buildSessionInfo(sessionID),
      messages: [],
      parts: {},
      status: { type: "idle" },
      historyHydrated: false,
      runtimePromise: null,
      runtimeNotificationUnsub: null,
      materialized: false,
    }
    sessions.set(sessionID, state)
    sessionOrder.push(sessionID)
    return state
  }

  function attachRuntimeNotificationBridge(state: SessionState, runtimePromise: Promise<TuiRuntimeBridge>) {
    void runtimePromise
      .then((runtime) => {
        if (typeof runtime.subscribeNotifications !== "function") {
          return
        }
        const sub = runtime.subscribeNotifications((notification) => {
          void emitRuntimeNotification(state, notification)
        })
        state.runtimeNotificationUnsub = () => sub.unsubscribe()
      })
      .catch(() => {})
  }

  function ensureSessionRuntime(state: SessionState): Promise<TuiRuntimeBridge> {
    if (state.runtimePromise) return state.runtimePromise
    const runtimePromise = getRuntimeBridge(state.info.id, mode)
    state.runtimePromise = runtimePromise
    attachRuntimeNotificationBridge(state, runtimePromise)
    return runtimePromise
  }

  function ensureSessionState(sessionID?: string): SessionState {
    const resolvedSessionID = sessionID ?? DEFAULT_SESSION_ID
    configureTuiStreamDiagnostics({ sessionID: resolvedSessionID })
    return sessions.get(resolvedSessionID) ?? createSessionState(resolvedSessionID)
  }

  function applySessionInfoToState(state: SessionState, info: Session) {
    state.info = {
      ...state.info,
      ...clone(info),
      id: state.info.id,
    }
    state.materialized = state.materialized || info.materialized === true
  }

  function cloneMessages(state: SessionState) {
    return state.messages.map((info) => ({
      info: clone(info),
      parts: clone(state.parts[info.id] ?? []),
    }))
  }

  function findMessageCutoffIndex(state: SessionState, messageID?: string): number {
    if (!messageID) return state.messages.length - 1
    const index = state.messages.findIndex((message) => message.id === messageID)
    return index >= 0 ? index : state.messages.length - 1
  }

  function cloneSessionMessagesThrough(state: SessionState, messageID?: string) {
    const cutoff = findMessageCutoffIndex(state, messageID)
    const messages = cutoff >= 0 ? state.messages.slice(0, cutoff + 1) : []
    const parts = Object.fromEntries(messages.map((message) => [message.id, clone(state.parts[message.id] ?? [])]))
    return {
      messages: clone(messages),
      parts,
    }
  }

  async function setSessionStatus(state: SessionState, type: SessionStatus["type"]) {
    state.status = { type }
    touchSession(state)
    await emitEvent({ type: "session.status", properties: { sessionID: state.info.id, status: state.status } } as Event)
  }

  async function disposeSessionState(state: SessionState) {
    clearPendingQuestionsForSession(state.info.id)
    state.runtimeNotificationUnsub?.()
    state.runtimeNotificationUnsub = null
    if (!state.runtimePromise) {
      return
    }
    if (mode === "local-runtime" && !runtimeBridgeFactoryOverride) {
      await disposeTuiRuntimeBridge(state.info.id)
      return
    }
    const runtime = await state.runtimePromise.catch(() => null)
    runtime?.dispose?.()
  }

  async function loadLiveSessionInfo(state: SessionState): Promise<Session> {
    const runtimeState = await loadRuntimeConversationState(
      await (state.runtimePromise?.catch(() => null) ?? Promise.resolve(null)),
    )
    const runtimeMaterialized =
      !!runtimeState && (runtimeState.historyMessages.length > 0 || runtimeState.runtimeMessages.length > 0)
    const runtimePreview =
      runtimeState && runtimeState.historyMessages.length > 0
        ? buildSessionPreviewFromChatMessages(runtimeState.historyMessages)
        : undefined
    const runtimeCreated =
      runtimeState && runtimeState.historyMessages.length > 0
        ? firstFiniteTimestamp(
            runtimeState.historyMessages.flatMap((message) => [message.startAt ?? null, message.endAt ?? null]),
          )
        : null
    const runtimeUpdated =
      runtimeState && runtimeState.historyMessages.length > 0
        ? firstFiniteTimestamp(
            [...runtimeState.historyMessages]
              .reverse()
              .flatMap((message) => [message.endAt ?? null, message.startAt ?? null]),
          )
        : null

    return {
      ...clone(state.info),
      materialized: state.materialized || runtimeMaterialized,
      preview: runtimePreview ?? buildSessionPreviewFromState(state),
      time: {
        created: firstFiniteTimestamp([runtimeCreated, state.info.time.created]) ?? state.info.time.created,
        updated:
          maxFiniteTimestamp([runtimeUpdated, state.info.time.updated, runtimeCreated, state.info.time.created])
          ?? state.info.time.updated,
      },
    }
  }

  async function loadBestSessionInfo(sessionID?: string): Promise<Session> {
    const resolvedSessionID = sessionID ?? DEFAULT_SESSION_ID
    const state = sessions.get(resolvedSessionID) ?? null
    const liveInfo = state ? await loadLiveSessionInfo(state).catch(() => null) : null
    const persistedInfo =
      mode === "local-runtime"
        ? await loadPersistedSessionInfo(resolvedSessionID).catch(() => null)
        : null

    if (state && liveInfo) {
      applySessionInfoToState(state, liveInfo)
    } else if (state && persistedInfo) {
      applySessionInfoToState(state, persistedInfo)
    }

    if (liveInfo || persistedInfo) {
      const created = firstFiniteTimestamp([
        liveInfo?.time.created ?? null,
        persistedInfo?.time.created ?? null,
      ]) ?? Date.now()
      const updated = maxFiniteTimestamp([
        liveInfo?.time.updated ?? null,
        persistedInfo?.time.updated ?? null,
        created,
      ]) ?? created
      const merged: Session = {
        ...(persistedInfo ?? buildSessionInfo(resolvedSessionID, created)),
        ...(liveInfo ?? {}),
        id: resolvedSessionID,
        title:
          (liveInfo && !isDefaultSessionTitle(liveInfo.title) ? liveInfo.title : null)
          ?? persistedInfo?.title
          ?? liveInfo?.title
          ?? buildSessionInfo(resolvedSessionID, created).title,
        materialized:
          (state?.materialized === true)
          || liveInfo?.materialized === true
          || persistedInfo?.materialized === true,
        time: {
          created,
          updated,
        },
        preview: liveInfo?.preview ?? persistedInfo?.preview,
      }
      if (state) {
        applySessionInfoToState(state, merged)
      }
      return merged
    }

    const stateForFallback = state ?? ensureSessionState(resolvedSessionID)
    return clone(stateForFallback.info)
  }

  const session = {
    async list({ search, limit }: { search?: string; limit?: number } = {}) {
      const persisted = await listPersistedSessionIds()
      const merged = uniqueStrings([...sessionOrder, ...persisted])
      const normalizedSearch = normalizePreviewText(search).toLowerCase()
      const sessionsList = await Promise.all(
        merged.map(async (sessionID) => {
          const state = sessions.get(sessionID)
          const persistedInfo = await loadPersistedSessionInfo(sessionID).catch(() => null)
          const liveInfo = state ? await loadLiveSessionInfo(state) : null
          const liveMaterialized = state?.materialized === true || liveInfo?.materialized === true
          const persistedMaterialized = persistedInfo?.materialized === true
          if (!liveMaterialized && !persistedMaterialized) {
            return null
          }
          const preview = liveInfo?.preview
          const mergedPreview = preview ?? persistedInfo?.preview
          const created = firstFiniteTimestamp([
            liveInfo?.time.created ?? null,
            persistedInfo?.time.created ?? null,
          ]) ?? Date.now()
          const updated = maxFiniteTimestamp([
            liveInfo?.time.updated ?? null,
            persistedInfo?.time.updated ?? null,
            created,
          ]) ?? created
          const title =
            (liveInfo && !isDefaultSessionTitle(liveInfo.title) ? liveInfo.title : null)
            ?? persistedInfo?.title
            ?? liveInfo?.title
            ?? buildSessionInfo(sessionID, created).title

          return {
            ...(persistedInfo ?? buildSessionInfo(sessionID, created)),
            ...(liveInfo ?? {}),
            id: sessionID,
            title,
            materialized: liveMaterialized || persistedMaterialized,
            time: {
              created,
              updated,
            },
            preview: mergedPreview,
          } as Session
        }),
      )

      const materializedSessions = sessionsList.filter((entry): entry is Session => !!entry)
      const filtered = normalizedSearch
        ? materializedSessions.filter((entry) =>
            [
              entry.id,
              entry.title,
              entry.preview?.initialUserMessage,
              entry.preview?.latestMessage,
            ]
              .map((value) => normalizePreviewText(value).toLowerCase())
              .some((value) => value.includes(normalizedSearch)),
          )
        : materializedSessions

      return {
        data:
          typeof limit === "number" && limit > 0
            ? filtered.slice(0, limit)
            : filtered,
      }
    },
    async create() {
      const state = createSessionState()
      await emitEvent({ type: "session.created", properties: { info: state.info } } as Event)
      await emitEvent({ type: "session.status", properties: { sessionID: state.info.id, status: state.status } } as Event)
      return { data: clone(state.info) }
    },
    async get({ sessionID }: { sessionID?: string } = {}) {
      return { data: await loadBestSessionInfo(sessionID) }
    },
    async messages({ sessionID }: { sessionID?: string } = {}) {
      const state = ensureSessionState(sessionID)
      await hydrateSessionHistoryFromPersistence(state)
      await hydratePendingQuestionsFromSnapshot(state)
      return {
        data: cloneMessages(state),
      }
    },
    async todo() {
      return { data: [] }
    },
    async diff() {
      return { data: [] }
    },
    async status() {
      return {
        data: Object.fromEntries(
          sessionOrder
            .map((sessionID) => sessions.get(sessionID))
            .filter((state): state is SessionState => !!state)
            .map((state) => [state.info.id, clone(state.status)]),
        ),
      }
    },
    async share({ sessionID }: { sessionID?: string } = {}) {
      const state = ensureSessionState(sessionID)
      state.info = { ...state.info, share: { url: "https://eidolon.ai/share/mock" } }
      await emitEvent({ type: "session.updated", properties: { info: state.info } } as Event)
      return { data: clone(state.info) }
    },
    async unshare({ sessionID }: { sessionID?: string } = {}) {
      const state = ensureSessionState(sessionID)
      state.info = { ...state.info, share: undefined }
      await emitEvent({ type: "session.updated", properties: { info: state.info } } as Event)
      return { data: clone(state.info) }
    },
    async summarize() {
      return { data: true }
    },
    async abort({ sessionID }: { sessionID?: string } = {}) {
      const state = ensureSessionState(sessionID)
      const runtime = await (state.runtimePromise ?? ensureSessionRuntime(state).catch(() => null))
      await runtime?.abort?.()
      await setSessionStatus(state, "idle")
      return { data: true }
    },
    async revert({ sessionID, messageID }: { sessionID?: string; messageID?: string } = {}) {
      const state = ensureSessionState(sessionID)
      if (mode === "local-runtime") {
        const bestInfo = await loadBestSessionInfo(state.info.id)
        applySessionInfoToState(state, bestInfo)
        await hydrateSessionHistoryFromPersistence(state)
      }
      const cutoff = findMessageCutoffIndex(state, messageID)
      const retainedMessages = cutoff >= 0 ? state.messages.slice(0, cutoff + 1) : []
      const removedMessages = state.messages.slice(cutoff + 1)
      state.messages.splice(0, state.messages.length, ...retainedMessages)
      const retainedIDs = new Set(retainedMessages.map((message) => message.id))
      for (const messageID of Object.keys(state.parts)) {
        if (!retainedIDs.has(messageID)) {
          delete state.parts[messageID]
        }
      }
      state.info = {
        ...state.info,
        revert: { messageID: messageID ?? retainedMessages.at(-1)?.id ?? "" },
        preview: buildSessionPreviewFromState(state),
      }
      touchSession(state)
      for (const message of removedMessages) {
        await emitEvent({
          type: "message.removed",
          properties: {
            sessionID: state.info.id,
            messageID: message.id,
          },
        } as Event)
      }
      await emitEvent({ type: "session.updated", properties: { info: state.info } } as Event)
      return { data: clone(state.info) }
    },
    async unrevert({ sessionID }: { sessionID?: string } = {}) {
      const state = ensureSessionState(sessionID)
      state.info = { ...state.info, revert: undefined }
      await emitEvent({ type: "session.updated", properties: { info: state.info } } as Event)
      return { data: clone(state.info) }
    },
    async update({ sessionID, title }: { sessionID?: string; title?: string } = {}) {
      const state = ensureSessionState(sessionID)
      if (mode === "local-runtime") {
        const bestInfo = await loadBestSessionInfo(state.info.id)
        applySessionInfoToState(state, bestInfo)
      }
      const nextTitle = typeof title === "string" ? title.trim() : ""
      if (nextTitle) {
        state.info = {
          ...state.info,
          title: nextTitle,
        }
        if (mode === "local-runtime") {
          await writeTuiSessionMetadata(state.info.id, {
            ...(await loadTuiSessionMetadata(state.info.id)),
            title: nextTitle,
            deleted: false,
            updatedAt: new Date().toISOString(),
          })
        }
      }
      touchSession(state)
      await emitEvent({ type: "session.updated", properties: { info: state.info } } as Event)
      return { data: clone(state.info) }
    },
    async delete({ sessionID }: { sessionID?: string } = {}) {
      const state = ensureSessionState(sessionID)
      await disposeSessionState(state)
      sessions.delete(state.info.id)
      const index = sessionOrder.indexOf(state.info.id)
      if (index >= 0) {
        sessionOrder.splice(index, 1)
      }
      if (mode === "local-runtime") {
        await rm(getSessionDir(state.info.id), { recursive: true, force: true })
      }
      await emitEvent({ type: "session.deleted", properties: { info: state.info } } as Event)
      return { data: true }
    },
    async fork({ sessionID, messageID }: { sessionID?: string; messageID?: string } = {}) {
      const source = ensureSessionState(sessionID)
      if (mode === "local-runtime") {
        const bestInfo = await loadBestSessionInfo(source.info.id)
        applySessionInfoToState(source, bestInfo)
        await hydrateSessionHistoryFromPersistence(source)
      }
      const forked = createSessionState()
      const forkedSnapshot = cloneSessionMessagesThrough(source, messageID)
      forked.messages.splice(0, forked.messages.length, ...forkedSnapshot.messages)
      forked.parts = forkedSnapshot.parts
      if (source.materialized || source.messages.length > 0) {
        markSessionMaterialized(forked)
      }
      forked.info = {
        ...forked.info,
        title: source.info.title,
        share: source.info.share,
        preview: buildSessionPreviewFromState(forked),
      }
      await emitEvent({ type: "session.created", properties: { info: forked.info } } as Event)
      await emitEvent({ type: "session.status", properties: { sessionID: forked.info.id, status: forked.status } } as Event)
      return { data: clone(forked.info) }
    },
    async prompt({
      sessionID,
      messageID,
      agent,
      variant,
      parts,
      model,
      providerID,
      modelID,
    }: {
      sessionID?: string
      messageID?: string
      agent?: string
      variant?: string
      parts?: Part[]
      model?: string | RuntimeModel
      providerID?: string
      modelID?: string
    }) {
      const state = ensureSessionState(sessionID)
      const promptContent = extractPromptContent(parts)
      const selectedModel = resolveMessageModel({ model, providerID, modelID })
      const userMessage: Message = {
        id: messageID ?? nextMessageId(),
        sessionID: state.info.id,
        role: "user",
        time: { created: Date.now() },
        agent: agent ?? "build",
        model: {
          providerID: selectedModel.providerID,
          modelID: selectedModel.modelID,
        },
        variant: variant ?? "fast",
      }
      const userPart: Part = {
        id: nextPartId(),
        sessionID: state.info.id,
        messageID: userMessage.id,
        type: "text",
        text: promptContent,
        synthetic: false,
        ignored: false,
      }
      addSessionMessage(state, userMessage, [userPart])

      await setSessionStatus(state, "busy")
      await emitEvent({ type: "message.updated", properties: { info: userMessage } } as Event)
      await emitEvent({ type: "message.part.updated", properties: { part: userPart } } as Event)

      type AssistantTurnState = {
        message: AssistantMessage
        part: TextPart
      }

      const finalizedStates: AssistantTurnState[] = []
      const toolPartsByCallID = new Map<string, { message: AssistantMessage; part: ToolPart }>()
      let currentState: AssistantTurnState | undefined
      let activeCategory: string | undefined
      let lastStreamPartUpdateAt = Date.now()
      let pendingStreamPart: TextPart | undefined
      let pendingStreamBufferChars = 0
      let streamTimer: ReturnType<typeof setTimeout> | undefined
      let streamDrainResolvers: Array<() => void> = []

      const createAssistantState = (mode = "assist") => {
        activeCategory = mode
        if (!shouldDisplayAssistantCategory(mode)) {
          currentState = undefined
          return
        }
        const assistantMessage: AssistantMessage = {
          id: nextMessageId(),
          sessionID: state.info.id,
          role: "assistant",
          time: { created: Date.now() },
          parentID: userMessage.id,
          modelID: selectedModel.modelID,
          providerID: selectedModel.providerID,
          mode,
          agent: agent ?? "build",
          path: {
            cwd: directory,
            root: directory,
          },
          cost: 0,
          tokens: {
            input: 10,
            output: 20,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          finish: "stop",
        }
        const assistantPart: TextPart = {
          id: nextPartId(),
          sessionID: state.info.id,
          messageID: assistantMessage.id,
          type: "text",
          text: "",
          synthetic: false,
          ignored: false,
        }
        addSessionMessage(state, assistantMessage, [assistantPart])
        eventEmitter.emit(clone({ type: "message.updated", properties: { info: assistantMessage } } as Event))
        currentState = {
          message: assistantMessage,
          part: assistantPart,
        }
      }

      const resolveStreamDrainIfIdle = () => {
        if (pendingStreamPart || streamTimer) return
        const resolvers = streamDrainResolvers
        streamDrainResolvers = []
        for (const resolve of resolvers) resolve()
      }

      const emitStreamPartUpdate = (part: TextPart) => {
        pendingStreamPart = undefined
        pendingStreamBufferChars = 0
        lastStreamPartUpdateAt = Date.now()
        const event = { type: "message.part.updated", properties: { part } } as Event
        traceStreamEvent("runtime.emit", event, { note: "prompt-stream" })
        eventEmitter.emit(clone(event))
      }

      const scheduleNextStreamFrame = (delayMs = STREAM_PART_UPDATE_INTERVAL_MS) => {
        if (streamTimer || !pendingStreamPart) return
        streamTimer = setTimeout(() => {
          streamTimer = undefined
          flushStreamPartUpdate()
        }, Math.max(0, delayMs))
      }

      const flushStreamPartUpdate = () => {
        if (streamTimer) {
          clearTimeout(streamTimer)
          streamTimer = undefined
        }
        if (!pendingStreamPart) {
          resolveStreamDrainIfIdle()
          return
        }
        const targetPart = pendingStreamPart
        emitStreamPartUpdate(targetPart)
        resolveStreamDrainIfIdle()
      }

      const scheduleStreamPartUpdate = (part: TextPart, appendedChars: number) => {
        pendingStreamPart = part
        pendingStreamBufferChars += appendedChars
        const elapsed = Date.now() - lastStreamPartUpdateAt
        if (elapsed >= STREAM_PART_UPDATE_INTERVAL_MS || pendingStreamBufferChars >= STREAM_PART_UPDATE_MAX_BUFFER_CHARS) {
          const delayMs = Math.max(0, STREAM_PART_UPDATE_INTERVAL_MS - elapsed)
          scheduleNextStreamFrame(delayMs)
          return
        }
        scheduleNextStreamFrame(STREAM_PART_UPDATE_INTERVAL_MS - elapsed)
      }

      const waitForStreamDrain = () => {
        flushStreamPartUpdate()
        if (!pendingStreamPart && !streamTimer) return Promise.resolve()
        return new Promise<void>((resolve) => {
          streamDrainResolvers.push(resolve)
        })
      }

      const finalizeCurrentState = async () => {
        const stateToFinalize = currentState
        if (!stateToFinalize) return
        await waitForStreamDrain()
        const completedAssistantMessage: AssistantMessage = {
          ...stateToFinalize.message,
          time: {
            ...stateToFinalize.message.time,
            completed: Date.now(),
          },
        }
        const completedAssistantPart: TextPart = {
          ...stateToFinalize.part,
        }
        addSessionMessage(state, completedAssistantMessage, [completedAssistantPart])
        finalizedStates.push({
          message: completedAssistantMessage,
          part: completedAssistantPart,
        })
        eventEmitter.emit(clone({ type: "message.updated", properties: { info: completedAssistantMessage } } as Event))
        eventEmitter.emit(clone({ type: "message.part.updated", properties: { part: completedAssistantPart } } as Event))
        if (currentState === stateToFinalize) {
          currentState = undefined
        }
      }

      const appendChunk = (chunk: string) => {
        if (!chunk) return undefined
        traceStreamDiagnostic("runtime.turn", {
          sessionID: state.info.id,
          note: "on-chunk",
          chunkLength: chunk.length,
          currentTextLength: currentState?.part.text.length ?? 0,
        })
        const nextMode = activeCategory ?? currentState?.message.mode ?? "assist"
        if (!shouldDisplayAssistantCategory(nextMode)) return undefined
        if (!currentState) {
          createAssistantState(nextMode)
        }
        if (!currentState) {
          return undefined
        }
        const nextPart: TextPart = {
          ...currentState!.part,
          text: currentState!.part.text + chunk,
        }
        currentState = {
          ...currentState!,
          part: nextPart,
        }
        addSessionMessage(state, currentState.message, [nextPart])
        scheduleStreamPartUpdate(nextPart, chunk.length)
      }

      const alignCurrentStateToFinalText = async (text: string) => {
        if (!currentState || !text) return
        const currentText = currentState.part.text
        if (!text.startsWith(currentText) || text.length <= currentText.length) return
        await waitForStreamDrain()
        let remaining = text.slice(currentText.length)
        traceStreamDiagnostic("runtime.turn", {
          sessionID: state.info.id,
          note: "final-catchup-start",
          finalTextLength: text.length,
          currentTextLength: currentText.length,
          missingTextLength: remaining.length,
        })
        while (remaining.length > 0) {
          const frame = remaining.slice(0, STREAM_FINAL_CATCHUP_CHARS_PER_FRAME)
          traceStreamDiagnostic("runtime.turn", {
            sessionID: state.info.id,
            note: "final-catchup-frame",
            chunkLength: frame.length,
            missingTextLength: remaining.length,
          })
          appendChunk(frame)
          remaining = remaining.slice(STREAM_FINAL_CATCHUP_CHARS_PER_FRAME)
          await waitForStreamDrain()
        }
      }

      const emitToolPartStart = async (event: RuntimeBridgeHistoryEvent) => {
        const payload = parseToolStartPayload(event)
        if (!payload) return
        const key = `${event.agentActorId}:${payload.toolCallId}`
        if (toolPartsByCallID.has(key)) return

        const assistantMessage: AssistantMessage = {
          id: nextMessageId(),
          sessionID: state.info.id,
          role: "assistant",
          time: { created: Date.now() },
          parentID: userMessage.id,
          modelID: selectedModel.modelID,
          providerID: selectedModel.providerID,
          mode: "assist",
          agent: event.agentKey || agent || "build",
          path: { cwd: directory, root: directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
        }
        const toolPart: ToolPart = {
          id: nextPartId(),
          sessionID: state.info.id,
          messageID: assistantMessage.id,
          type: "tool",
          tool: payload.toolName,
          callID: payload.toolCallId,
          state: {
            status: "pending",
            input: parseToolInput(payload.argumentsText),
          },
        }

        addSessionMessage(state, assistantMessage, [toolPart])
        toolPartsByCallID.set(key, { message: assistantMessage, part: toolPart })
        await emitEvent({ type: "message.updated", properties: { info: assistantMessage } } as Event)
        await emitEvent({ type: "message.part.updated", properties: { part: toolPart } } as Event)
      }

      const emitToolPartResult = async (event: RuntimeBridgeHistoryEvent) => {
        const payload = parseToolResultPayload(event)
        if (!payload) return
        const key = `${event.agentActorId}:${payload.toolCallId}`
        let existing = toolPartsByCallID.get(key)
        if (!existing) {
          await emitToolPartStart({
            ...event,
            stream: "tool_call_start",
            payload: JSON.stringify({
              toolName: payload.toolName,
              toolCallId: payload.toolCallId,
            }),
          })
          existing = toolPartsByCallID.get(key)
        }
        if (!existing) return

        const nextMessage: AssistantMessage = {
          ...existing.message,
          time: {
            ...existing.message.time,
            completed: Date.now(),
          },
        }
        const nextPart: ToolPart = {
          ...existing.part,
          state: {
            ...existing.part.state,
            status: payload.isError ? "error" : "completed",
            output: payload.result,
            error: payload.isError ? payload.result : undefined,
            metadata: buildToolMetadata(payload.toolName, payload.result),
          },
        }

        addSessionMessage(state, nextMessage, [nextPart])
        toolPartsByCallID.set(key, { message: nextMessage, part: nextPart })
        await emitEvent({ type: "message.updated", properties: { info: nextMessage } } as Event)
        await emitEvent({ type: "message.part.updated", properties: { part: nextPart } } as Event)
      }

      let finalText = ""
      let sawChunk = false
      let historySub: { unsubscribe: () => void } | undefined
      try {
        const runtime = await ensureSessionRuntime(state)
        historySub = runtime.subscribeHistoryEvents?.((event) => {
          traceRuntimeHistoryEvent(state.info.id, event)
          void (async () => {
            if (event.stream === "tool_call_start") {
              await emitToolPartStart(event)
            }
            if (event.stream === "tool_call_result") {
              await emitToolPartResult(event)
            }
            if (event.stream === "questionnaire_request") {
              await emitQuestionAsked(state, event)
            }
            if (event.stream === "questionnaire_result") {
              await emitQuestionResult(state, event)
            }
          })()
        })
        finalText = await runtime.turn(promptContent, {
          onControl: async (control) => {
            if (control.cmd !== "NewMessage") return
            activeCategory = control.category ?? "assist"
            traceStreamDiagnostic("runtime.turn", {
              sessionID: state.info.id,
              note: "on-control",
              controlCategory: activeCategory,
            })
            if (!shouldDisplayAssistantCategory(activeCategory)) {
              if (currentState?.part.text) {
                await finalizeCurrentState()
              }
              currentState = undefined
              return
            }
            if (!currentState) {
              createAssistantState(activeCategory)
              return
            }
            if (!currentState.part.text) return
            await finalizeCurrentState()
            createAssistantState(activeCategory)
          },
          onChunk: (chunk) => {
            const before = currentState?.part.text ?? ""
            appendChunk(chunk)
            const after = currentState?.part.text ?? before
            if (after !== before) {
              sawChunk = true
              finalText += chunk
            }
          },
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        finalText = `Runtime error: ${message}`
        await appendChunk(finalText)
      } finally {
        historySub?.unsubscribe()
      }

      traceStreamDiagnostic("runtime.turn", {
        sessionID: state.info.id,
        note: "turn-finished",
        finalTextLength: finalText.length,
        currentTextLength: currentState?.part.text.length ?? 0,
        sawChunk,
      })
      if (!sawChunk && !currentState && finalText) {
        await appendChunk(finalText)
      }
      await alignCurrentStateToFinalText(finalText)
      await waitForStreamDrain()
      await finalizeCurrentState()
      await hydratePendingQuestionsFromSnapshot(state)
      await setSessionStatus(state, "idle")
      await emitEvent({ type: "session.updated", properties: { info: state.info } } as Event)
      const lastAssistant = finalizedStates[finalizedStates.length - 1]
      if (!lastAssistant) {
        const lastTool = Array.from(toolPartsByCallID.values()).at(-1)
        if (lastTool) {
          return { data: { info: clone(lastTool.message), parts: [clone(lastTool.part)] } }
        }
        return { data: { info: clone(userMessage), parts: [clone(userPart)] } }
      }
      return { data: { info: clone(lastAssistant.message), parts: [clone(lastAssistant.part)] } }
    },
    async command({
      sessionID,
      command,
      arguments: rawArgs,
      messageID,
      agent,
      variant,
      model,
      providerID,
      modelID,
    }: {
      sessionID?: string
      command: string
      arguments?: string
      messageID?: string
      agent?: string
      variant?: string
      model?: string | RuntimeModel
      providerID?: string
      modelID?: string
    }) {
      const rawInput = `/${command}${rawArgs ? ` ${rawArgs}` : ""}`
      const builtinCommand = resolveBuiltinSlashCommand(rawInput)
      if (builtinCommand) {
        await emitEvent({ type: "tui.command.execute", properties: { command: builtinCommand } } as Event)
        return { data: true }
      }

      const state = ensureSessionState(sessionID)
      const runtime = await ensureSessionRuntime(state)
      const resolved = runtime.slashRuntime?.resolveCommand(rawInput) ?? null
      const selectedModel = resolveMessageModel({ model, providerID, modelID })

      const shouldPersistUser = resolved?.kind !== "direct_execute"
      let userMessage: Message | undefined
      if (shouldPersistUser) {
        userMessage = {
          id: messageID ?? nextMessageId(),
          sessionID: state.info.id,
          role: "user",
          time: { created: Date.now() },
          agent: agent ?? "build",
          model: selectedModel,
          variant: variant ?? "fast",
        }
        const userPart: TextPart = {
          id: nextPartId(),
          sessionID: state.info.id,
          messageID: userMessage.id,
          type: "text",
          text: rawInput,
          synthetic: false,
          ignored: false,
        }
        addSessionMessage(state, userMessage, [userPart])
        await emitEvent({ type: "message.updated", properties: { info: userMessage } } as Event)
        await emitEvent({ type: "message.part.updated", properties: { part: userPart } } as Event)
      }

      await setSessionStatus(state, "busy")

      type AssistantTurnState = { message: AssistantMessage; part: TextPart }
      const toolPartsByCallID = new Map<string, { message: AssistantMessage; part: ToolPart }>()
      let currentState: AssistantTurnState | undefined
      let activeCategory: string | undefined
      let lastStreamPartUpdateAt = Date.now()
      let pendingStreamPart: TextPart | undefined
      let pendingStreamBufferChars = 0
      let streamTimer: ReturnType<typeof setTimeout> | undefined
      let streamDrainResolvers: Array<() => void> = []

      const createAssistantState = async (mode = "assist") => {
        activeCategory = mode
        if (!shouldDisplayAssistantCategory(mode)) {
          currentState = undefined
          return
        }
        const assistantMessage: AssistantMessage = {
          id: nextMessageId(),
          sessionID: state.info.id,
          role: "assistant",
          time: { created: Date.now() },
          parentID: userMessage?.id,
          modelID: selectedModel.modelID,
          providerID: selectedModel.providerID,
          mode,
          agent: agent ?? "build",
          path: { cwd: directory, root: directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
        }
        const assistantPart: TextPart = {
          id: nextPartId(),
          sessionID: state.info.id,
          messageID: assistantMessage.id,
          type: "text",
          text: "",
          synthetic: false,
          ignored: false,
        }
        addSessionMessage(state, assistantMessage, [assistantPart])
        await emitEvent({ type: "message.updated", properties: { info: assistantMessage } } as Event)
        currentState = { message: assistantMessage, part: assistantPart }
      }

      const resolveStreamDrainIfIdle = () => {
        if (pendingStreamPart || streamTimer) return
        const resolvers = streamDrainResolvers
        streamDrainResolvers = []
        for (const resolve of resolvers) resolve()
      }

      const emitStreamPartUpdate = async (part: TextPart): Promise<void> => {
        pendingStreamPart = undefined
        pendingStreamBufferChars = 0
        lastStreamPartUpdateAt = Date.now()
        await emitEvent({ type: "message.part.updated", properties: { part } } as Event)
      }

      const scheduleNextStreamFrame = (delayMs = STREAM_PART_UPDATE_INTERVAL_MS) => {
        if (streamTimer || !pendingStreamPart) return
        streamTimer = setTimeout(() => {
          streamTimer = undefined
          void flushStreamPartUpdate()
        }, Math.max(0, delayMs))
      }

      const flushStreamPartUpdate = async (): Promise<void> => {
        if (streamTimer) {
          clearTimeout(streamTimer)
          streamTimer = undefined
        }
        if (!pendingStreamPart) {
          resolveStreamDrainIfIdle()
          return
        }
        const targetPart = pendingStreamPart
        await emitStreamPartUpdate(targetPart)
        resolveStreamDrainIfIdle()
      }

      const scheduleStreamPartUpdate = (part: TextPart, appendedChars: number) => {
        pendingStreamPart = part
        pendingStreamBufferChars += appendedChars
        const elapsed = Date.now() - lastStreamPartUpdateAt
        if (elapsed >= STREAM_PART_UPDATE_INTERVAL_MS || pendingStreamBufferChars >= STREAM_PART_UPDATE_MAX_BUFFER_CHARS) {
          const delayMs = Math.max(0, STREAM_PART_UPDATE_INTERVAL_MS - elapsed)
          scheduleNextStreamFrame(delayMs)
          return
        }
        scheduleNextStreamFrame(STREAM_PART_UPDATE_INTERVAL_MS - elapsed)
      }

      const waitForStreamDrain = async () => {
        await flushStreamPartUpdate()
        if (!pendingStreamPart && !streamTimer) return
        await new Promise<void>((resolve) => {
          streamDrainResolvers.push(resolve)
        })
      }

      const finalizeCurrentState = async () => {
        const stateToFinalize = currentState
        if (!stateToFinalize) return
        await waitForStreamDrain()
        const completedAssistantMessage: AssistantMessage = {
          ...stateToFinalize.message,
          time: { ...stateToFinalize.message.time, completed: Date.now() },
        }
        const completedAssistantPart: TextPart = { ...stateToFinalize.part }
        addSessionMessage(state, completedAssistantMessage, [completedAssistantPart])
        await emitEvent({ type: "message.updated", properties: { info: completedAssistantMessage } } as Event)
        await emitEvent({ type: "message.part.updated", properties: { part: completedAssistantPart } } as Event)
        if (currentState === stateToFinalize) {
          currentState = undefined
        }
      }

      const appendChunk = async (chunk: string) => {
        if (!chunk) return
        traceStreamDiagnostic("runtime.turn", {
          sessionID: state.info.id,
          note: "command-on-chunk",
          chunkLength: chunk.length,
          currentTextLength: currentState?.part.text.length ?? 0,
        })
        const nextMode = activeCategory ?? currentState?.message.mode ?? "assist"
        if (!shouldDisplayAssistantCategory(nextMode)) return false
        if (!currentState) {
          await createAssistantState(nextMode)
        }
        if (!currentState) {
          return false
        }
        const nextPart: TextPart = {
          ...currentState!.part,
          text: currentState!.part.text + chunk,
        }
        currentState = { ...currentState!, part: nextPart }
        addSessionMessage(state, currentState.message, [nextPart])
        scheduleStreamPartUpdate(nextPart, chunk.length)
        return true
      }

      const alignCurrentStateToFinalText = async (text: string) => {
        if (!currentState || !text) return
        const currentText = currentState.part.text
        if (!text.startsWith(currentText) || text.length <= currentText.length) return
        await waitForStreamDrain()
        let remaining = text.slice(currentText.length)
        traceStreamDiagnostic("runtime.turn", {
          sessionID: state.info.id,
          note: "command-final-catchup-start",
          finalTextLength: text.length,
          currentTextLength: currentText.length,
          missingTextLength: remaining.length,
        })
        while (remaining.length > 0) {
          const frame = remaining.slice(0, STREAM_FINAL_CATCHUP_CHARS_PER_FRAME)
          traceStreamDiagnostic("runtime.turn", {
            sessionID: state.info.id,
            note: "command-final-catchup-frame",
            chunkLength: frame.length,
            missingTextLength: remaining.length,
          })
          await appendChunk(frame)
          remaining = remaining.slice(STREAM_FINAL_CATCHUP_CHARS_PER_FRAME)
          await waitForStreamDrain()
        }
      }

      const emitToolPartStart = async (event: RuntimeBridgeHistoryEvent) => {
        const payload = parseToolStartPayload(event)
        if (!payload) return
        const key = `${event.agentActorId}:${payload.toolCallId}`
        if (toolPartsByCallID.has(key)) return

        const assistantMessage: AssistantMessage = {
          id: nextMessageId(),
          sessionID: state.info.id,
          role: "assistant",
          time: { created: Date.now() },
          parentID: userMessage?.id,
          modelID: selectedModel.modelID,
          providerID: selectedModel.providerID,
          mode: "assist",
          agent: event.agentKey || agent || "build",
          path: { cwd: directory, root: directory },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          finish: "stop",
        }
        const toolPart: ToolPart = {
          id: nextPartId(),
          sessionID: state.info.id,
          messageID: assistantMessage.id,
          type: "tool",
          tool: payload.toolName,
          callID: payload.toolCallId,
          state: {
            status: "pending",
            input: parseToolInput(payload.argumentsText),
          },
        }

        addSessionMessage(state, assistantMessage, [toolPart])
        toolPartsByCallID.set(key, { message: assistantMessage, part: toolPart })
        await emitEvent({ type: "message.updated", properties: { info: assistantMessage } } as Event)
        await emitEvent({ type: "message.part.updated", properties: { part: toolPart } } as Event)
      }

      const emitToolPartResult = async (event: RuntimeBridgeHistoryEvent) => {
        const payload = parseToolResultPayload(event)
        if (!payload) return
        const key = `${event.agentActorId}:${payload.toolCallId}`
        let existing = toolPartsByCallID.get(key)
        if (!existing) {
          await emitToolPartStart({
            ...event,
            stream: "tool_call_start",
            payload: JSON.stringify({
              toolName: payload.toolName,
              toolCallId: payload.toolCallId,
            }),
          })
          existing = toolPartsByCallID.get(key)
        }
        if (!existing) return

        const nextMessage: AssistantMessage = {
          ...existing.message,
          time: {
            ...existing.message.time,
            completed: Date.now(),
          },
        }
        const nextPart: ToolPart = {
          ...existing.part,
          state: {
            ...existing.part.state,
            status: payload.isError ? "error" : "completed",
            output: payload.result,
            error: payload.isError ? payload.result : undefined,
            metadata: buildToolMetadata(payload.toolName, payload.result),
          },
        }

        addSessionMessage(state, nextMessage, [nextPart])
        toolPartsByCallID.set(key, { message: nextMessage, part: nextPart })
        await emitEvent({ type: "message.updated", properties: { info: nextMessage } } as Event)
        await emitEvent({ type: "message.part.updated", properties: { part: nextPart } } as Event)
      }

      let finalText = ""
      let sawChunk = false
      let historySub: { unsubscribe: () => void } | undefined
      try {
        historySub = runtime.subscribeHistoryEvents?.((event) => {
          traceRuntimeHistoryEvent(state.info.id, event)
          void (async () => {
            if (event.stream === "tool_call_start") {
              await emitToolPartStart(event)
            }
            if (event.stream === "tool_call_result") {
              await emitToolPartResult(event)
            }
            if (event.stream === "questionnaire_request") {
              await emitQuestionAsked(state, event)
            }
            if (event.stream === "questionnaire_result") {
              await emitQuestionResult(state, event)
            }
          })()
        })
        finalText = await runtime.turn(rawInput, {
          onControl: async (control) => {
            if (control.cmd !== "NewMessage") return
            activeCategory = control.category ?? "assist"
            traceStreamDiagnostic("runtime.turn", {
              sessionID: state.info.id,
              note: "command-on-control",
              controlCategory: activeCategory,
            })
            if (!shouldDisplayAssistantCategory(activeCategory)) {
              if (currentState?.part.text) {
                await finalizeCurrentState()
              }
              currentState = undefined
              return
            }
            if (!currentState) {
              await createAssistantState(activeCategory)
              return
            }
            if (!currentState.part.text) return
            await finalizeCurrentState()
            await createAssistantState(activeCategory)
          },
          onChunk: async (chunk) => {
            if (await appendChunk(chunk)) {
              sawChunk = true
              finalText += chunk
            }
          },
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        finalText = `Runtime error: ${message}`
        await appendChunk(finalText)
      } finally {
        historySub?.unsubscribe()
      }

      traceStreamDiagnostic("runtime.turn", {
        sessionID: state.info.id,
        note: "command-turn-finished",
        finalTextLength: finalText.length,
        currentTextLength: currentState?.part.text.length ?? 0,
        sawChunk,
      })
      if (!sawChunk && !currentState && finalText) {
        await appendChunk(finalText)
      }
      await alignCurrentStateToFinalText(finalText)
      await waitForStreamDrain()
      await finalizeCurrentState()
      await hydratePendingQuestionsFromSnapshot(state)
      await setSessionStatus(state, "idle")
      await emitEvent({ type: "session.updated", properties: { info: state.info } } as Event)
      return { data: true }
    },
    async shell() {
      return { data: true }
    },
  }

  const permission = {
    async reply() {
      return { data: true }
    },
  }

  const question = {
    async reply({ requestID, answers }: { requestID: string; answers: QuestionAnswer[] }) {
      const pending = pendingQuestionsByID.get(requestID)
      if (!pending) {
        return { data: true }
      }

      const text = serializeQuestionAnswers(pending.request, answers)
      await session.prompt({
        sessionID: pending.sessionID,
        parts: [
          {
            id: nextPartId(),
            sessionID: pending.sessionID,
            messageID: nextMessageId(),
            type: "text",
            text,
            synthetic: false,
            ignored: false,
          } as Part,
        ],
      })
      return { data: true }
    },
    async reject({ requestID }: { requestID: string }) {
      const pending = pendingQuestionsByID.get(requestID)
      if (!pending) {
        return { data: true }
      }

      await session.prompt({
        sessionID: pending.sessionID,
        parts: [
          {
            id: nextPartId(),
            sessionID: pending.sessionID,
            messageID: nextMessageId(),
            type: "text",
            text: "reject",
            synthetic: false,
            ignored: false,
          } as Part,
        ],
      })
      return { data: true }
    },
  }

  const provider = {
    async list() {
      return { data: providerListState }
    },
    async auth() {
      return { data: providerAuthState }
    },
    oauth: {
      async authorize() {
        return {
          data: {
            url: "https://eidolon.ai",
            method: "auto",
            instructions: "Visit the URL to authorize",
          },
        }
      },
      async callback() {
        return { data: true }
      },
    },
  }

  const config = {
    async get() {
      return { data: configState }
    },
    async providers() {
      return {
        data: {
          providers: providerState,
          default: providerListState.default,
          connected: providerListState.connected,
        },
      }
    },
  }

  const app = {
    async agents() {
      if (mode === "local-runtime") {
        const runtime = await getRuntimeBridge("default", mode).catch(() => null)
        if (runtime?.agents) {
          return { data: await runtime.agents() }
        }
      }
      return { data: agentState }
    },
  }

  const find = {
    async files() {
      return { data: [] }
    },
    async text() {
      return { data: [] }
    },
    async symbols() {
      return { data: [] }
    },
  }

  const mcp = {
    async status() {
      return { data: clone(mcpState) }
    },
    async connect({ name }: { name: string }) {
      mcpState[name] = { status: "connected" }
      return { data: true }
    },
    async disconnect({ name }: { name: string }) {
      mcpState[name] = { status: "disabled" }
      return { data: true }
    },
  }

  const formatter = {
    async status() {
      return { data: [] }
    },
  }

  const vcs = {
    async get() {
      return { data: { branch: "main" } }
    },
  }

  const path = {
    async get() {
      return {
        data: {
          home: process.env["HOME"] ?? "",
          state: "",
          config: "",
          worktree: directory,
          directory,
        },
      }
    },
  }

  const command = {
    async list() {
      const commands: Command[] = []
      return { data: commands }
    },
  }

  const experimental = {
    resource: {
      async list() {
        return { data: {} }
      },
    },
  }

  const instance = {
    async dispose() {
      for (const sessionID of [...sessionOrder]) {
        const state = sessions.get(sessionID)
        if (!state) continue
        await disposeSessionState(state)
      }
      return { data: {} }
    },
  }

  const auth = {
    async set() {
      if (mode === "mock") {
        const { providerID, modelID } = catalog.defaultModel
        providerListState.connected = Array.from(new Set([...providerListState.connected, providerID]))
        const provider = providerState.find((item) => item.id === providerID)
        if (provider?.models[modelID]) {
          provider.models[modelID].cost = {
            input: 1,
            output: 1,
            cache: { read: 0, write: 0 },
          }
          await emitEvent({ type: "provider.updated", properties: { info: provider } } as unknown as Event)
          await emitEvent({ type: "provider.list.updated" } as unknown as Event)
        }
      }
      return { data: true }
    },
  }

  function on(handler: (event: Event) => void): () => void
  function on(type: Event["type"], handler: (event: Event) => void): () => void
  function on(typeOrHandler: Event["type"] | ((event: Event) => void), maybeHandler?: (event: Event) => void) {
    if (typeof typeOrHandler === "function") {
      return eventEmitter.on(typeOrHandler)
    }
    return eventEmitter.on((evt) => {
      if (evt.type !== typeOrHandler) return
      maybeHandler?.(evt)
    })
  }

  const event = {
    async subscribe() {
      const stream = (async function* () {
        for (const sessionID of sessionOrder) {
          const state = ensureSessionState(sessionID)
          yield clone({ type: "session.created", properties: { info: state.info } } as Event)
          yield clone({ type: "session.status", properties: { sessionID: state.info.id, status: state.status } } as Event)
        }
      })()
      return { stream }
    },
    listen(handler: (event: CustomEvent<{ detail: Event }>) => void) {
      return eventEmitter.on((evt) => handler({ detail: evt } as never))
    },
    on,
    emit(event: Event) {
      eventEmitter.emit(event)
    },
  }

  const tui = {
    async appendPrompt({ text }: { text: string }) {
      await emitEvent({ type: "tui.prompt.append", properties: { text } } as Event)
      return { data: true }
    },
    async openHelp() {
      await emitEvent({ type: "tui.command.execute", properties: { command: COMMAND_ID.HelpShow } } as Event)
      return { data: true }
    },
    async openSessions() {
      await emitEvent({ type: "tui.command.execute", properties: { command: COMMAND_ID.SessionList } } as Event)
      return { data: true }
    },
    async openThemes() {
      await emitEvent({ type: "tui.command.execute", properties: { command: COMMAND_ID.ThemeSwitch } } as Event)
      return { data: true }
    },
    async openModels() {
      await emitEvent({ type: "tui.command.execute", properties: { command: COMMAND_ID.ModelList } } as Event)
      return { data: true }
    },
    async submitPrompt() {
      await emitEvent({ type: "tui.command.execute", properties: { command: COMMAND_ID.PromptSubmit } } as Event)
      return { data: true }
    },
    async clearPrompt() {
      await emitEvent({ type: "tui.command.execute", properties: { command: COMMAND_ID.PromptClear } } as Event)
      return { data: true }
    },
    async executeCommand({ command }: { command: string }) {
      await emitEvent({ type: "tui.command.execute", properties: { command } } as Event)
      return { data: true }
    },
    async showToast(input: { message: string; title?: string; variant?: "info" | "success" | "warning" | "error"; duration?: number }) {
      await emitEvent({
        type: "tui.toast.show",
        properties: {
          title: input.title,
          message: input.message,
          variant: input.variant ?? "info",
          duration: input.duration,
        },
      } as Event)
      return { data: true }
    },
    control: {
      async next() {
        return { data: true }
      },
      async response() {
        return { data: true }
      },
    },
    publish: async () => ({ data: true }),
  }

  return {
    client: {
      session,
      permission,
      question,
      provider,
      config,
      app,
      find,
      mcp,
      formatter,
      vcs,
      path,
      command,
      experimental,
      instance,
      auth,
      tui,
    },
    event,
    url: mode,
  }
}
