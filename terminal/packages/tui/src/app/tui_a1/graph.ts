import { createObservableGraph } from "@terminal/organ/observability"
import type { SessionTraceStore } from "@terminal/organ/observability"
import { buildQuestionnaireProtocolQuestion } from "@cell/ai-core-contract/runtime/QuestionnaireProtocol"
import type { ActorSurfaceProjectionData } from "@cell/ai-core-contract/runtime/ActorSurface"
import type {
  Message,
  Part,
  PermissionRequest,
  Question,
  QuestionAnswer,
  QuestionRequest,
  RuntimeUsage,
  ToolPart,
  UserInputHistoryEntry,
} from "@terminal/core/AIAgent"
import {
  createRuntimePlaceholderMessages,
  defaultTuiA1Selection,
  formatTuiA1Selection,
  inferSelectionFromRuntimeMessages,
  runtimeMessagesToTuiA1Messages,
  type TuiA1Message,
  type TuiA1Selection,
} from "./data"
import {
  buildStructuredQuestionAnswers,
  questionnaireAnsweredCount,
  questionnaireTitle,
  summarizePermissionHistory,
  summarizeQuestionHistory,
  type PermissionReply,
} from "./features/approval/approval-utils"
import type { PromptInfo } from "./features/composer/model/prompt-info"
import type { Route } from "./route/route"
import { streamDiagnosticNow, traceStreamDiagnostic } from "../../support/util/stream-diagnostics"

type TuiA1RuntimeMessages = Record<string, Message>
type TuiA1RuntimeParts = Record<string, Part[]>
type TuiA1PermissionQueue = Record<string, PermissionRequest[]>
type TuiA1QuestionQueue = Record<string, QuestionRequest[]>
type TuiA1HistoryMessages = Record<string, TuiA1Message[]>
type TuiA1RuntimeUsageBySession = Record<string, RuntimeUsage>
type TuiA1UserInputHistoryBySession = Record<string, UserInputHistoryEntry[]>
type TuiA1QuestionnaireStatus = "pending" | "done" | "rejected"
type TuiA1QuestionnaireRecords = Record<string, Record<string, TuiA1QuestionnaireRecord>>

const MAX_RUNTIME_CACHE_MESSAGES = 100
const MAX_HISTORY_MESSAGES_PER_SESSION = 200
const MAX_VISIBLE_TIMELINE_MESSAGES = 300
const MAX_QUESTIONNAIRE_RECORDS_PER_SESSION = 100
const MAX_USER_INPUT_HISTORY_PER_SESSION = 100

export type TuiA1QuestionnaireRecord = {
  id: string
  sessionID: string
  title: string
  request: QuestionRequest
  status: TuiA1QuestionnaireStatus
  answers: QuestionAnswer[]
  answered: number
  total: number
  summary: string
  structuredAnswers: Record<string, string | string[]>
  createdAt: number
  updatedAt: number
}

export type TuiA1QuestionnaireCenter = {
  doneCount: number
  pendingCount: number
  entries: TuiA1QuestionnaireRecord[]
}

export type TuiA1ProjectionSnapshot = {
  busy: boolean
  composer: PromptInfo
  route: Route
  selection: TuiA1Selection
  sessionID?: string
  activeTranscriptKey?: string
  messages: TuiA1Message[]
  runtimeMessages: TuiA1RuntimeMessages
  runtimeParts: TuiA1RuntimeParts
  permissions: TuiA1PermissionQueue
  questions: TuiA1QuestionQueue
  historyMessages: TuiA1HistoryMessages
  runtimeUsage: TuiA1RuntimeUsageBySession
  userInputHistory: TuiA1UserInputHistoryBySession
  questionnaireRecords: TuiA1QuestionnaireRecords
  actorSurface: ActorSurfaceProjectionData | null
}

export type TuiA1GraphEvent =
  | {
      type: "merge-selection"
      selection: Partial<TuiA1Selection>
    }
  | {
      type: "set-route"
      route: Route
    }
  | {
      type: "set-composer"
      composer: PromptInfo
    }
  | {
      type: "set-busy"
      busy: boolean
    }
  | {
      type: "set-session-id"
      sessionID?: string
    }
  | {
      type: "show-runtime-placeholder"
      connecting: boolean
    }
  | {
      type: "runtime-hydrate-session"
      sessionID: string
      busy: boolean
      messages: Message[]
      partsByMessage: Record<string, Part[]>
    }
  | {
      type: "runtime-hydrate-actor-transcript"
      sessionID: string
      transcriptKey: string
      messages: Message[]
      partsByMessage: Record<string, Part[]>
    }
  | {
      type: "runtime-message-updated"
      message: Message
    }
  | {
      type: "runtime-message-removed"
      sessionID: string
      messageID: string
    }
  | {
      type: "runtime-part-updated"
      part: Part
    }
  | {
      type: "runtime-usage-updated"
      sessionID: string
      usage: RuntimeUsage
    }
  | {
      type: "runtime-user-input-history-updated"
      sessionID: string
      history: UserInputHistoryEntry[]
    }
  | {
      type: "runtime-user-input-history-appended"
      sessionID: string
      entry: UserInputHistoryEntry
      history?: UserInputHistoryEntry[]
    }
  | {
      type: "permission-asked"
      request: PermissionRequest
    }
  | {
      type: "permission-replied"
      sessionID: string
      requestID: string
    }
  | {
      type: "question-asked"
      request: QuestionRequest
    }
  | {
      type: "question-replied"
      sessionID: string
      requestID: string
    }
  | {
      type: "question-rejected"
      sessionID: string
      requestID: string
    }
  | {
      type: "record-permission-history"
      request: PermissionRequest
      reply: PermissionReply
    }
  | {
      type: "record-question-history"
      request: QuestionRequest
      answers: QuestionAnswer[]
      rejected: boolean
    }
  | {
      type: "set-actor-surface"
      surface: ActorSurfaceProjectionData | null
    }
  | {
      type: "local-append-messages"
      messages: TuiA1Message[]
    }
  | {
      type: "local-patch-message"
      messageID: string
      patch: Partial<TuiA1Message>
    }

function cloneSelection(selection: TuiA1Selection): TuiA1Selection {
  return {
    agent: selection.agent,
    providerID: selection.providerID,
    modelID: selection.modelID,
  }
}

function createInitialSnapshot(options: {
  busy?: boolean
  composer?: PromptInfo
  initialMessages: TuiA1Message[]
  route?: Route
  selection?: TuiA1Selection
  sessionID?: string
}): TuiA1ProjectionSnapshot {
  return {
    busy: options.busy ?? false,
    composer: options.composer ?? { input: "", parts: [] },
    route: options.route ?? { type: "home" },
    selection: cloneSelection(options.selection ?? defaultTuiA1Selection),
    sessionID: options.sessionID,
    activeTranscriptKey: options.sessionID,
    messages: [...options.initialMessages],
    runtimeMessages: {},
    runtimeParts: {},
    permissions: {},
    questions: {},
    historyMessages: {},
    runtimeUsage: {},
    userInputHistory: {},
    questionnaireRecords: {},
    actorSurface: null,
  }
}

function sortedRuntimeMessages(messages: TuiA1RuntimeMessages): Message[] {
  return Object.values(messages).sort((left, right) => {
    const createdDiff = (left.time.created ?? 0) - (right.time.created ?? 0)
    if (createdDiff !== 0) return createdDiff
    return left.id.localeCompare(right.id)
  })
}

function cloneRuntimeParts(partsByMessage: Record<string, Part[]>): TuiA1RuntimeParts {
  return Object.fromEntries(
    Object.entries(partsByMessage).map(([messageID, parts]) => [messageID, parts.map(cloneRuntimePart)]),
  )
}

function cloneRuntimeMessage(message: Message): Message {
  return structuredClone(message)
}

function cloneRuntimePart(part: Part): Part {
  return structuredClone(part)
}

function cloneRuntimeUsage(usage: RuntimeUsage): RuntimeUsage {
  return { ...usage }
}

function cloneUserInputHistoryEntry(entry: UserInputHistoryEntry): UserInputHistoryEntry {
  return { ...entry }
}

function boundUserInputHistory(entries: UserInputHistoryEntry[] | undefined): UserInputHistoryEntry[] {
  return (entries ?? [])
    .filter((entry) => String(entry.text ?? "").trim())
    .slice(-MAX_USER_INPUT_HISTORY_PER_SESSION)
    .map(cloneUserInputHistoryEntry)
}

function isSameSelection(left: TuiA1Selection, right: TuiA1Selection): boolean {
  return left.agent === right.agent && left.providerID === right.providerID && left.modelID === right.modelID
}

function isSameMessage(left: Message, right: Message): boolean {
  return (
    left.id === right.id &&
    left.sessionID === right.sessionID &&
    left.role === right.role &&
    left.agent === right.agent &&
    left.mode === right.mode &&
    left.providerID === right.providerID &&
    left.modelID === right.modelID &&
    left.parentID === right.parentID &&
    left.finish === right.finish &&
    left.time.created === right.time.created &&
    left.time.completed === right.time.completed &&
    JSON.stringify(left.path ?? null) === JSON.stringify(right.path ?? null) &&
    JSON.stringify(left.tokens ?? null) === JSON.stringify(right.tokens ?? null) &&
    JSON.stringify(left.cost ?? null) === JSON.stringify(right.cost ?? null)
  )
}

function isSamePart(left: Part, right: Part): boolean {
  return (
    left.id === right.id &&
    left.sessionID === right.sessionID &&
    left.messageID === right.messageID &&
    left.type === right.type &&
    JSON.stringify(left) === JSON.stringify(right)
  )
}

function upsertRequest<T extends { id: string }>(requests: T[] | undefined, request: T): T[] {
  const next = [...(requests ?? [])]
  const match = next.findIndex((item) => item.id === request.id)
  if (match >= 0) {
    next[match] = request
  } else {
    next.push(request)
  }
  return next
}

function removeRequestByID<T extends { id: string }>(requests: T[] | undefined, requestID: string): T[] {
  if (!requests || requests.length === 0) return []
  return requests.filter((request) => request.id !== requestID)
}

function activePermissionForSnapshot(snapshot: TuiA1ProjectionSnapshot): PermissionRequest | undefined {
  if (!snapshot.sessionID) return undefined
  return snapshot.permissions[snapshot.sessionID]?.[0]
}

function activeQuestionForSnapshot(snapshot: TuiA1ProjectionSnapshot): QuestionRequest | undefined {
  if (!snapshot.sessionID) return undefined
  return snapshot.questions[snapshot.sessionID]?.[0]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function isToolPart(part: Part): part is ToolPart {
  return part.type === "tool"
}

function isQuestionnaireToolPart(part: Part): part is ToolPart {
  return isToolPart(part) && part.tool.trim().toLowerCase() === "questionnaire"
}

function buildQuestionRequestFromToolInput(
  sessionID: string,
  input: unknown,
  toolCallId?: string,
): QuestionRequest | null {
  if (!isRecord(input)) return null

  const questionnaireId =
    typeof input.questionnaireId === "string" && input.questionnaireId.trim()
      ? input.questionnaireId.trim()
      : toolCallId
        ? `q-${toolCallId}`
        : ""
  if (!questionnaireId) return null

  const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : undefined
  const intro = typeof input.intro === "string" && input.intro.trim() ? input.intro.trim() : undefined
  const kind = typeof input.kind === "string" && input.kind.trim() ? input.kind.trim() : undefined
  const suspendPolicy =
    typeof input.suspendPolicy === "string" && input.suspendPolicy.trim() ? input.suspendPolicy.trim() : undefined

  const questions: Question[] = (Array.isArray(input.questions) ? input.questions : []).flatMap((entry, index): Question[] => {
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

      return [{
        id,
        header: promptQuestion.header,
        question: questionText,
        options: promptQuestion.options
          .filter((option) => !option.isCustom)
          .map((option) => ({
            label: option.label,
            description: option.description,
            value: option.value,
            code: option.code,
          })),
        multiple: type === "multi_select",
        custom: true,
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

function parseRecordedQuestionAnswer(question: Question, rawValue: string): QuestionAnswer {
  if (!rawValue.trim()) return []
  const values = question.multiple ? rawValue.split(/\s*,\s*/) : [rawValue]

  return values
    .map((value) => {
      const trimmed = value.trim()
      if (!trimmed) return undefined

      const customCode =
        typeof question.customOptionCode === "string" && question.customOptionCode.trim()
          ? question.customOptionCode.trim().toUpperCase()
          : ""
      if (customCode && trimmed.toUpperCase().startsWith(`${customCode} `)) {
        return trimmed.slice(customCode.length).trim()
      }

      const option = question.options.find((candidate) => {
        const label = typeof candidate.label === "string" ? candidate.label.trim() : ""
        const optionValue = typeof candidate.value === "string" ? candidate.value.trim() : ""
        const code = typeof candidate.code === "string" ? candidate.code.trim().toUpperCase() : ""
        const normalized = trimmed.toUpperCase()
        return label === trimmed || optionValue === trimmed || (code && code === normalized)
      })

      return option?.label ?? trimmed
    })
    .filter((value): value is string => Boolean(value))
}

function parseRecordedQuestionnaireAnswers(request: QuestionRequest, output?: string): QuestionAnswer[] {
  const questions = request.questions ?? []
  if (questions.length === 0) return []

  const empty = questions.map(() => [])
  if (!output || !output.trim()) return empty

  if (questions.length === 1) {
    return [parseRecordedQuestionAnswer(questions[0]!, output)]
  }

  const valuesByHeader = new Map<string, string>()
  for (const line of output.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const separatorIndex = trimmed.indexOf(":")
    if (separatorIndex < 0) continue
    const key = trimmed.slice(0, separatorIndex).trim()
    const value = trimmed.slice(separatorIndex + 1).trim()
    if (!key || !value) continue
    valuesByHeader.set(key, value)
  }

  return questions.map((question, index) => {
    const fallbackKey = typeof question.id === "string" && question.id.trim() ? question.id.trim() : `Q${index + 1}`
    return parseRecordedQuestionAnswer(question, valuesByHeader.get(question.header) ?? valuesByHeader.get(fallbackKey) ?? "")
  })
}

function mergeTimelineMessages(base: TuiA1Message[], overlay: TuiA1Message[]): TuiA1Message[] {
  return [
    ...base.map((message, index) => ({ message, createdAt: message.createdAt, lane: 0, index })),
    ...overlay.map((message, index) => ({ message, createdAt: message.createdAt, lane: 1, index })),
  ]
    .sort((left, right) => {
      const createdDiff = left.createdAt - right.createdAt
      if (createdDiff !== 0) return createdDiff
      const laneDiff = left.lane - right.lane
      if (laneDiff !== 0) return laneDiff
      return left.index - right.index
    })
    .map((entry) => entry.message)
}

function retainTail<T>(items: T[], maxItems: number): T[] {
  if (items.length <= maxItems) return items
  return items.slice(-maxItems)
}

function boundTimelineMessages(messages: TuiA1Message[]): TuiA1Message[] {
  return retainTail(messages, MAX_VISIBLE_TIMELINE_MESSAGES)
}

function boundHistoryMessages(messages: TuiA1Message[]): TuiA1Message[] {
  return retainTail(messages, MAX_HISTORY_MESSAGES_PER_SESSION)
}

function boundQuestionnaireRecords(
  records: Record<string, TuiA1QuestionnaireRecord>,
): Record<string, TuiA1QuestionnaireRecord> {
  const entries = Object.values(records)
  if (entries.length <= MAX_QUESTIONNAIRE_RECORDS_PER_SESSION) return records

  const retained = entries
    .sort((left, right) => {
      const pendingDiff = Number(right.status === "pending") - Number(left.status === "pending")
      if (pendingDiff !== 0) return pendingDiff
      return right.updatedAt - left.updatedAt
    })
    .slice(0, MAX_QUESTIONNAIRE_RECORDS_PER_SESSION)

  return Object.fromEntries(retained.map((record) => [record.id, record]))
}

function upsertBoundedQuestionnaireRecord(
  records: Record<string, TuiA1QuestionnaireRecord> | undefined,
  nextRecord: TuiA1QuestionnaireRecord,
): Record<string, TuiA1QuestionnaireRecord> {
  return boundQuestionnaireRecords(upsertQuestionnaireRecord(records, nextRecord))
}

function historyMessagesForSnapshot(snapshot: TuiA1ProjectionSnapshot): TuiA1Message[] {
  if (!snapshot.sessionID) return []
  return boundHistoryMessages([...(snapshot.historyMessages[snapshot.sessionID] ?? [])])
}

function upsertHistoryMessage(messages: TuiA1Message[] | undefined, nextMessage: TuiA1Message): TuiA1Message[] {
  const next = [...(messages ?? [])]
  const match = next.findIndex((message) => message.id === nextMessage.id)
  if (match >= 0) {
    next[match] = nextMessage
  } else {
    next.push(nextMessage)
  }
  return next
}

function buildPermissionHistoryMessage(request: PermissionRequest, reply: PermissionReply): TuiA1Message {
  return {
    id: `approval:${request.id}`,
    kind: "tool",
    source: "summary",
    tool: "approval",
    createdAt: Date.now(),
    status: "done",
    summary: summarizePermissionHistory(request, reply),
    input: {
      decision: reply,
      permission: request.permission,
    },
  }
}

function buildQuestionHistoryMessage(
  request: QuestionRequest,
  answers: QuestionAnswer[],
  rejected: boolean,
  createdAt = Date.now(),
): TuiA1Message {
  const answered = answers.filter((group) => group.length > 0).length
  return {
    id: `questionnaire:${request.id}`,
    kind: "tool",
    source: "summary",
    tool: "questionnaire",
    createdAt,
    status: "done",
    summary: summarizeQuestionHistory(request, answers, rejected),
    input: {
      decision: rejected ? "reject" : "submit",
      answered,
      total: request.questions.length,
    },
  }
}

function applyRuntimeProjection(state: TuiA1ProjectionSnapshot): TuiA1ProjectionSnapshot {
  const startedAt = streamDiagnosticNow()
  const runtimeMessages = sortedRuntimeMessages(state.runtimeMessages)
  const selection = inferSelectionFromRuntimeMessages(runtimeMessages) ?? state.selection
  const projectedMessages = runtimeMessagesToTuiA1Messages(runtimeMessages, state.runtimeParts)
  const historyMessages = historyMessagesForSnapshot(state)
  const mergedMessages =
    projectedMessages.length > 0
      ? mergeTimelineMessages(projectedMessages, historyMessages)
      : historyMessages
  const streamingMessage = [...projectedMessages]
    .reverse()
    .find((message): message is Extract<TuiA1Message, { kind: "assistant" }> => message.kind === "assistant" && Boolean(message.streaming))

  traceStreamDiagnostic("tui_a1.project", {
    sessionID: state.sessionID,
    messageID: streamingMessage?.id,
    textLength: streamingMessage?.text.length,
    eventCount: runtimeMessages.length,
    partUpdateCount: Object.values(state.runtimeParts).reduce((sum, parts) => sum + parts.length, 0),
    durationMs: Math.round(streamDiagnosticNow() - startedAt),
  })

  return {
    ...state,
    selection,
    messages:
      mergedMessages.length > 0
        ? boundTimelineMessages(mergedMessages)
        : createRuntimePlaceholderMessages(selection, !state.sessionID),
  }
}

function boundRuntimeCaches(state: TuiA1ProjectionSnapshot): TuiA1ProjectionSnapshot {
  const sortedMessages = sortedRuntimeMessages(state.runtimeMessages)
  if (sortedMessages.length <= MAX_RUNTIME_CACHE_MESSAGES) return state

  const retainedMessages = sortedMessages.slice(-MAX_RUNTIME_CACHE_MESSAGES)
  const retainedIDs = new Set(retainedMessages.map((message) => message.id))

  return {
    ...state,
    runtimeMessages: Object.fromEntries(retainedMessages.map((message) => [message.id, message])),
    runtimeParts: Object.fromEntries(
      Object.entries(state.runtimeParts).filter(([messageID]) => retainedIDs.has(messageID)),
    ),
  }
}

function boundSnapshotCaches(state: TuiA1ProjectionSnapshot): TuiA1ProjectionSnapshot {
  return {
    ...boundRuntimeCaches(state),
    messages: boundTimelineMessages(state.messages),
    historyMessages: Object.fromEntries(
      Object.entries(state.historyMessages).map(([sessionID, messages]) => [
        sessionID,
        boundHistoryMessages(messages),
      ]),
    ),
    userInputHistory: Object.fromEntries(
      Object.entries(state.userInputHistory).map(([sessionID, history]) => [
        sessionID,
        boundUserInputHistory(history),
      ]),
    ),
    questionnaireRecords: Object.fromEntries(
      Object.entries(state.questionnaireRecords).map(([sessionID, records]) => [
        sessionID,
        boundQuestionnaireRecords(records),
      ]),
    ),
  }
}

function questionnaireCenterForSnapshot(snapshot: TuiA1ProjectionSnapshot): TuiA1QuestionnaireCenter {
  if (!snapshot.sessionID) {
    return {
      doneCount: 0,
      pendingCount: 0,
      entries: [],
    }
  }

  const entries = Object.values(snapshot.questionnaireRecords[snapshot.sessionID] ?? {}).sort((left, right) => {
    const statusRank = questionnaireStatusRank(left.status) - questionnaireStatusRank(right.status)
    if (statusRank !== 0) return statusRank
    return right.updatedAt - left.updatedAt
  })

  return {
    doneCount: entries.filter((entry) => entry.status === "done").length,
    pendingCount: entries.filter((entry) => entry.status === "pending").length,
    entries,
  }
}

function questionnaireStatusRank(status: TuiA1QuestionnaireStatus): number {
  switch (status) {
    case "pending":
      return 0
    case "done":
      return 1
    case "rejected":
      return 2
  }
}

function upsertQuestionnaireRecord(
  records: Record<string, TuiA1QuestionnaireRecord> | undefined,
  nextRecord: TuiA1QuestionnaireRecord,
): Record<string, TuiA1QuestionnaireRecord> {
  return {
    ...(records ?? {}),
    [nextRecord.id]: nextRecord,
  }
}

function buildPendingQuestionnaireRecord(request: QuestionRequest, at = Date.now()): TuiA1QuestionnaireRecord {
  const now = at
  return {
    id: request.id,
    sessionID: request.sessionID,
    title: questionnaireTitle(request),
    request,
    status: "pending",
    answers: [],
    answered: 0,
    total: request.questions.length,
    summary: `Pending · ${questionnaireTitle(request)}`,
    structuredAnswers: buildStructuredQuestionAnswers(request, []),
    createdAt: now,
    updatedAt: now,
  }
}

function buildCompletedQuestionnaireRecord(
  request: QuestionRequest,
  answers: QuestionAnswer[],
  rejected: boolean,
  previous?: TuiA1QuestionnaireRecord,
  at = Date.now(),
): TuiA1QuestionnaireRecord {
  const resolvedAnswers = request.questions.map((_, index) => [...(answers[index] ?? [])])
  const now = at
  return {
    id: request.id,
    sessionID: request.sessionID,
    title: questionnaireTitle(request),
    request,
    status: rejected ? "rejected" : "done",
    answers: resolvedAnswers,
    answered: questionnaireAnsweredCount(resolvedAnswers),
    total: request.questions.length,
    summary: summarizeQuestionHistory(request, resolvedAnswers, rejected),
    structuredAnswers: buildStructuredQuestionAnswers(request, resolvedAnswers),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  }
}

function hydrateQuestionnaireStateFromRuntimeSession(
  sessionID: string,
  messages: Message[],
  partsByMessage: Record<string, Part[]>,
): {
  historyMessages: TuiA1Message[]
  records: Record<string, TuiA1QuestionnaireRecord>
} {
  const historyMessages: TuiA1Message[] = []
  let records: Record<string, TuiA1QuestionnaireRecord> = {}

  for (const message of messages) {
    const toolParts = (partsByMessage[message.id] ?? []).filter(isQuestionnaireToolPart)
    if (toolParts.length === 0) continue

    for (const part of toolParts) {
      const request = buildQuestionRequestFromToolInput(sessionID, part.state.input, part.callID)
      if (!request) continue

      const previous = records[request.id]
      if (part.state.status === "pending") {
        records = upsertQuestionnaireRecord(records, buildPendingQuestionnaireRecord(request, message.time.created))
        continue
      }

      if (part.state.status !== "completed") continue

      const answers = parseRecordedQuestionnaireAnswers(request, typeof part.state.output === "string" ? part.state.output : "")
      records = upsertQuestionnaireRecord(
        records,
        buildCompletedQuestionnaireRecord(
          request,
          answers,
          false,
          previous,
          message.time.completed ?? message.time.created,
        ),
      )
      historyMessages.push(buildQuestionHistoryMessage(request, answers, false, message.time.created))
    }
  }

  return { historyMessages, records }
}

function refreshRuntimePlaceholderIfNeeded(state: TuiA1ProjectionSnapshot): TuiA1ProjectionSnapshot {
  if (Object.keys(state.runtimeMessages).length > 0) return state
  if (state.messages.length !== 1) return state
  const placeholder = state.messages[0]
  if (!placeholder || placeholder.kind !== "assistant") return state
  if (placeholder.id !== "runtime-connecting" && placeholder.id !== "runtime-ready") return state
  return {
    ...state,
    messages: createRuntimePlaceholderMessages(state.selection, placeholder.id === "runtime-connecting"),
  }
}

function reduceTuiA1GraphState(
  state: TuiA1ProjectionSnapshot,
  event: TuiA1GraphEvent,
): TuiA1ProjectionSnapshot {
  switch (event.type) {
    case "merge-selection": {
      const nextSelection = {
        agent: event.selection.agent ?? state.selection.agent,
        providerID: event.selection.providerID ?? state.selection.providerID,
        modelID: event.selection.modelID ?? state.selection.modelID,
      }
      if (isSameSelection(state.selection, nextSelection)) return state
      const next = {
        ...state,
        selection: nextSelection,
      }
      return refreshRuntimePlaceholderIfNeeded(next)
    }
    case "set-route":
      if (
        state.route.type === event.route.type &&
        state.route.initialPrompt?.input === event.route.initialPrompt?.input &&
        state.route.type === "session" &&
        event.route.type === "session" &&
        state.route.sessionID === event.route.sessionID
      ) {
        return state
      }
      return {
        ...state,
        route: event.route,
      }
    case "set-composer":
      if (
        state.composer.input === event.composer.input &&
        state.composer.mode === event.composer.mode &&
        JSON.stringify(state.composer.parts) === JSON.stringify(event.composer.parts)
      ) {
        return state
      }
      return {
        ...state,
        composer: {
          input: event.composer.input,
          mode: event.composer.mode,
          parts: [...event.composer.parts],
        },
      }
    case "set-busy":
      if (state.busy === event.busy) return state
      return {
        ...state,
        busy: event.busy,
      }
    case "set-session-id":
      if (state.sessionID === event.sessionID) return state
      return {
        ...state,
        route: event.sessionID
          ? {
              type: "session",
              sessionID: event.sessionID,
              initialPrompt: state.route.initialPrompt,
            }
          : state.route.type === "session"
            ? { type: "home", initialPrompt: state.route.initialPrompt }
            : state.route,
        sessionID: event.sessionID,
      }
    case "show-runtime-placeholder":
      return {
        ...state,
        messages: createRuntimePlaceholderMessages(state.selection, event.connecting),
      }
    case "runtime-hydrate-session":
      {
        const hydratedQuestionnaire = hydrateQuestionnaireStateFromRuntimeSession(
          event.sessionID,
          event.messages,
          event.partsByMessage,
        )
        const nextHistory = [...(state.historyMessages[event.sessionID] ?? [])]
        for (const message of hydratedQuestionnaire.historyMessages) {
          const updated = upsertHistoryMessage(nextHistory, message)
          nextHistory.splice(0, nextHistory.length, ...updated)
        }

        return applyRuntimeProjection(
          boundRuntimeCaches({
            ...state,
            sessionID: event.sessionID,
            activeTranscriptKey: event.sessionID,
            busy: event.busy,
            runtimeMessages: Object.fromEntries(event.messages.map((message) => [message.id, cloneRuntimeMessage(message)])),
            runtimeParts: cloneRuntimeParts(event.partsByMessage),
            historyMessages: {
              ...state.historyMessages,
              [event.sessionID]: boundHistoryMessages(nextHistory),
            },
            questionnaireRecords: {
              ...state.questionnaireRecords,
              [event.sessionID]: boundQuestionnaireRecords({
                ...(state.questionnaireRecords[event.sessionID] ?? {}),
                ...hydratedQuestionnaire.records,
              }),
            },
          }),
        )
      }
    case "runtime-hydrate-actor-transcript":
      {
        const hydratedQuestionnaire = hydrateQuestionnaireStateFromRuntimeSession(
          event.sessionID,
          event.messages,
          event.partsByMessage,
        )
        return applyRuntimeProjection(
          boundRuntimeCaches({
            ...state,
            sessionID: event.sessionID,
            activeTranscriptKey: event.transcriptKey,
            runtimeMessages: Object.fromEntries(event.messages.map((message) => [message.id, cloneRuntimeMessage(message)])),
            runtimeParts: cloneRuntimeParts(event.partsByMessage),
            questionnaireRecords: {
              ...state.questionnaireRecords,
              [event.sessionID]: boundQuestionnaireRecords({
                ...(state.questionnaireRecords[event.sessionID] ?? {}),
                ...hydratedQuestionnaire.records,
              }),
            },
          }),
        )
      }
    case "runtime-message-updated":
      if (state.runtimeMessages[event.message.id] && isSameMessage(state.runtimeMessages[event.message.id]!, event.message)) {
        return state
      }
      return applyRuntimeProjection(
        boundRuntimeCaches({
          ...state,
          runtimeMessages: {
            ...state.runtimeMessages,
            [event.message.id]: cloneRuntimeMessage(event.message),
          },
        }),
      )
    case "runtime-message-removed": {
      const existing = state.runtimeMessages[event.messageID]
      if (!existing || existing.sessionID !== event.sessionID) return state
      const runtimeMessages = { ...state.runtimeMessages }
      const runtimeParts = { ...state.runtimeParts }
      delete runtimeMessages[event.messageID]
      delete runtimeParts[event.messageID]
      return applyRuntimeProjection({
        ...state,
        runtimeMessages,
        runtimeParts,
      })
    }
    case "runtime-part-updated": {
      if (!state.runtimeMessages[event.part.messageID]) return state
      const parts = [...(state.runtimeParts[event.part.messageID] ?? [])]
      const index = parts.findIndex((item) => item.id === event.part.id)
      if (index >= 0 && isSamePart(parts[index]!, event.part)) {
        return state
      }
      const nextPart = cloneRuntimePart(event.part)
      if (index >= 0) {
        parts[index] = nextPart
      } else {
        parts.push(nextPart)
      }
      return applyRuntimeProjection(
        boundRuntimeCaches({
          ...state,
          runtimeParts: {
            ...state.runtimeParts,
            [event.part.messageID]: parts,
          },
        }),
      )
    }
    case "runtime-usage-updated":
      return {
        ...state,
        runtimeUsage: {
          ...state.runtimeUsage,
          [event.sessionID]: cloneRuntimeUsage(event.usage),
        },
      }
    case "runtime-user-input-history-updated":
      return {
        ...state,
        userInputHistory: {
          ...state.userInputHistory,
          [event.sessionID]: boundUserInputHistory(event.history),
        },
      }
    case "runtime-user-input-history-appended": {
      const nextHistory = event.history
        ? event.history
        : [...(state.userInputHistory[event.sessionID] ?? []), event.entry]
      return {
        ...state,
        userInputHistory: {
          ...state.userInputHistory,
          [event.sessionID]: boundUserInputHistory(nextHistory),
        },
      }
    }
    case "permission-asked":
      return {
        ...state,
        permissions: {
          ...state.permissions,
          [event.request.sessionID]: upsertRequest(state.permissions[event.request.sessionID], event.request),
        },
      }
    case "permission-replied":
      return {
        ...state,
        permissions: {
          ...state.permissions,
          [event.sessionID]: removeRequestByID(state.permissions[event.sessionID], event.requestID),
        },
      }
    case "question-asked":
      return {
        ...state,
        questions: {
          ...state.questions,
          [event.request.sessionID]: upsertRequest(state.questions[event.request.sessionID], event.request),
        },
        questionnaireRecords: {
          ...state.questionnaireRecords,
          [event.request.sessionID]: upsertBoundedQuestionnaireRecord(
            state.questionnaireRecords[event.request.sessionID],
            buildPendingQuestionnaireRecord(event.request),
          ),
        },
      }
    case "question-replied":
    case "question-rejected":
      return {
        ...state,
        questions: {
          ...state.questions,
          [event.sessionID]: removeRequestByID(state.questions[event.sessionID], event.requestID),
        },
      }
    case "record-permission-history":
      return applyRuntimeProjection({
        ...state,
        historyMessages: {
          ...state.historyMessages,
          [event.request.sessionID]: boundHistoryMessages(
            upsertHistoryMessage(
              state.historyMessages[event.request.sessionID],
              buildPermissionHistoryMessage(event.request, event.reply),
            ),
          ),
        },
      })
    case "record-question-history":
      return applyRuntimeProjection({
        ...state,
        historyMessages: {
          ...state.historyMessages,
          [event.request.sessionID]: boundHistoryMessages(
            upsertHistoryMessage(
              state.historyMessages[event.request.sessionID],
              buildQuestionHistoryMessage(event.request, event.answers, event.rejected),
            ),
          ),
        },
        questionnaireRecords: {
          ...state.questionnaireRecords,
          [event.request.sessionID]: upsertBoundedQuestionnaireRecord(
            state.questionnaireRecords[event.request.sessionID],
            buildCompletedQuestionnaireRecord(
              event.request,
              event.answers,
              event.rejected,
              state.questionnaireRecords[event.request.sessionID]?.[event.request.id],
            ),
          ),
        },
      })
    case "set-actor-surface":
      return {
        ...state,
        actorSurface: event.surface ? structuredClone(event.surface) : null,
      }
    case "local-append-messages":
      return {
        ...state,
        messages: boundTimelineMessages([...state.messages, ...event.messages]),
      }
    case "local-patch-message":
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.id === event.messageID
            ? {
                ...message,
                ...event.patch,
              } as TuiA1Message
            : message,
        ),
      }
    default:
      return state
  }
}

export class TuiA1StateGraph {
  readonly graph!: ReturnType<typeof createObservableGraph>["graph"]
  private obs!: ReturnType<typeof createObservableGraph>

  constructor(options: {
    busy?: boolean
    composer?: PromptInfo
    initialMessages: TuiA1Message[]
    route?: Route
    selection?: TuiA1Selection
    sessionID?: string
  }) {
    const initialSnapshot = createInitialSnapshot(options)
    this.obs = createObservableGraph({})
    this.graph = this.obs.graph
    this.graph.addSignal<TuiA1ProjectionSnapshot>("snapshot", initialSnapshot)
    this.graph.addComputed("messages", ["snapshot"], (ctx) => ctx.get<TuiA1ProjectionSnapshot>("snapshot").messages)
    this.graph.addComputed("busy", ["snapshot"], (ctx) => ctx.get<TuiA1ProjectionSnapshot>("snapshot").busy)
    this.graph.addComputed("composer", ["snapshot"], (ctx) => ctx.get<TuiA1ProjectionSnapshot>("snapshot").composer)
    this.graph.addComputed("route", ["snapshot"], (ctx) => ctx.get<TuiA1ProjectionSnapshot>("snapshot").route)
    this.graph.addComputed("selection", ["snapshot"], (ctx) => ctx.get<TuiA1ProjectionSnapshot>("snapshot").selection)
    this.graph.addComputed("sessionID", ["snapshot"], (ctx) => ctx.get<TuiA1ProjectionSnapshot>("snapshot").sessionID)
    this.graph.addComputed("activePermission", ["snapshot"], (ctx) =>
      activePermissionForSnapshot(ctx.get<TuiA1ProjectionSnapshot>("snapshot")),
    )
    this.graph.addComputed("activeQuestion", ["snapshot"], (ctx) =>
      activeQuestionForSnapshot(ctx.get<TuiA1ProjectionSnapshot>("snapshot")),
    )
    this.graph.addComputed("composerBlocked", ["activePermission", "activeQuestion"], (ctx) =>
      Boolean(ctx.get<PermissionRequest | undefined>("activePermission") || ctx.get<QuestionRequest | undefined>("activeQuestion")),
    )
    this.graph.addComputed("messageCount", ["messages"], (ctx) => ctx.get<TuiA1Message[]>("messages").length)
    this.graph.addComputed("selectionLabel", ["selection"], (ctx) =>
      formatTuiA1Selection(ctx.get<TuiA1Selection>("selection")),
    )
    this.graph.addComputed("questionnaireCenter", ["snapshot"], (ctx) =>
      questionnaireCenterForSnapshot(ctx.get<TuiA1ProjectionSnapshot>("snapshot")),
    )
    this.graph.addComputed("actorSurface", ["snapshot"], (ctx) =>
      ctx.get<TuiA1ProjectionSnapshot>("snapshot").actorSurface,
    )
    this.graph.addComputed("currentState", ["route", "selection", "sessionID"], (ctx) => ({
      route: ctx.get<Route>("route"),
      selection: ctx.get<TuiA1Selection>("selection"),
      sessionID: ctx.get<string | undefined>("sessionID"),
    }))

  }

  snapshot(): TuiA1ProjectionSnapshot {
    return this.graph.get<TuiA1ProjectionSnapshot>("snapshot")
  }

  dispatch(event: TuiA1GraphEvent): void {
    const current = this.snapshot()
    const startedAt = streamDiagnosticNow()
    const reduced = reduceTuiA1GraphState(current, event)
    if (reduced === current) return
    const next = boundSnapshotCaches(reduced)
    this.graph.set("snapshot", next)
    if (event.type === "runtime-part-updated") {
      traceStreamDiagnostic("tui_a1.receive", {
        eventType: event.type,
        sessionID: event.part.sessionID,
        messageID: event.part.messageID,
        partID: event.part.id,
        partType: event.part.type,
        textLength: event.part.type === "text" ? event.part.text.length : undefined,
        durationMs: Math.round(streamDiagnosticNow() - startedAt),
      })
    }
  }

  mergeSelection(selection: Partial<TuiA1Selection>): void {
    this.dispatch({ type: "merge-selection", selection })
  }

  setRoute(route: Route): void {
    this.dispatch({ type: "set-route", route })
  }

  setComposer(composer: PromptInfo): void {
    this.dispatch({ type: "set-composer", composer })
  }

  setBusy(busy: boolean): void {
    this.dispatch({ type: "set-busy", busy })
  }

  setSessionID(sessionID?: string): void {
    this.dispatch({ type: "set-session-id", sessionID })
  }

  showRuntimePlaceholder(connecting: boolean): void {
    this.dispatch({ type: "show-runtime-placeholder", connecting })
  }

  hydrateRuntimeSession(options: {
    sessionID: string
    busy: boolean
    messages: Message[]
    partsByMessage: Record<string, Part[]>
  }): void {
    this.dispatch({
      type: "runtime-hydrate-session",
      sessionID: options.sessionID,
      busy: options.busy,
      messages: options.messages,
      partsByMessage: options.partsByMessage,
    })
  }

  hydrateActorTranscript(options: {
    sessionID: string
    transcriptKey: string
    messages: Message[]
    partsByMessage: Record<string, Part[]>
  }): void {
    this.dispatch({
      type: "runtime-hydrate-actor-transcript",
      sessionID: options.sessionID,
      transcriptKey: options.transcriptKey,
      messages: options.messages,
      partsByMessage: options.partsByMessage,
    })
  }

  applyRuntimeMessageUpdated(message: Message): void {
    this.dispatch({ type: "runtime-message-updated", message })
  }

  applyRuntimeMessageRemoved(sessionID: string, messageID: string): void {
    this.dispatch({ type: "runtime-message-removed", sessionID, messageID })
  }

  applyRuntimePartUpdated(part: Part): void {
    this.dispatch({ type: "runtime-part-updated", part })
  }

  applyRuntimeUsageUpdated(sessionID: string, usage: RuntimeUsage): void {
    this.dispatch({ type: "runtime-usage-updated", sessionID, usage })
  }

  setUserInputHistory(sessionID: string, history: UserInputHistoryEntry[]): void {
    this.dispatch({ type: "runtime-user-input-history-updated", sessionID, history })
  }

  appendUserInputHistory(sessionID: string, entry: UserInputHistoryEntry, history?: UserInputHistoryEntry[]): void {
    this.dispatch({ type: "runtime-user-input-history-appended", sessionID, entry, history })
  }

  applyPermissionAsked(request: PermissionRequest): void {
    this.dispatch({ type: "permission-asked", request })
  }

  applyPermissionReplied(sessionID: string, requestID: string): void {
    this.dispatch({ type: "permission-replied", sessionID, requestID })
  }

  recordPermissionHistory(request: PermissionRequest, reply: PermissionReply): void {
    this.dispatch({ type: "record-permission-history", request, reply })
  }

  applyQuestionAsked(request: QuestionRequest): void {
    this.dispatch({ type: "question-asked", request })
  }

  applyQuestionReplied(sessionID: string, requestID: string): void {
    this.dispatch({ type: "question-replied", sessionID, requestID })
  }

  applyQuestionRejected(sessionID: string, requestID: string): void {
    this.dispatch({ type: "question-rejected", sessionID, requestID })
  }

  recordQuestionHistory(request: QuestionRequest, answers: QuestionAnswer[], rejected = false): void {
    this.dispatch({ type: "record-question-history", request, answers, rejected })
  }

  setActorSurface(surface: ActorSurfaceProjectionData | null): void {
    this.dispatch({ type: "set-actor-surface", surface })
  }

  appendLocalMessages(messages: TuiA1Message[]): void {
    this.dispatch({ type: "local-append-messages", messages })
  }

  patchLocalMessage(messageID: string, patch: Partial<TuiA1Message>): void {
    this.dispatch({ type: "local-patch-message", messageID, patch })
  }

  dispose(): void {
    this.obs.dispose()
  }

  /**
   * Exposes the DiagnosticPipeline for advanced observability use.
   * The pipeline receives all TraceRecord events from the DataGraph
   * via the TraceMiddleware, and aggregates them into by-node groups
   * and global statistics.
   */
  diagnosticPipeline() {
    return this.obs.diagnosticPipeline
  }

  /** Flush pending trace records to file (when SessionTraceSink is bound). */
  async flushTrace(): Promise<void> {
    await this.obs.flushTrace?.();
  }

  /** Returns a snapshot of the current graph state for debugging. */
  getGraphSnapshot() {
    return this.snapshot()
  }

  /** Validates graph integrity (deps audit). */
  validateGraph(): string[] {
    const errors: string[] = []
    try {
      this.graph.validate?.()
    } catch (e) {
      errors.push(String(e))
    }
    return errors
  }
}
