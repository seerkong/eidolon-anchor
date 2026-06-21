import type { ActorSurfaceProjectionData } from "@cell/ai-core-contract/runtime/ActorSurface"

export type KeybindsConfig = Record<string, string | undefined>

export type Path = {
  home?: string
  state: string
  config: string
  worktree: string
  directory: string
}

export type ProviderAuthMethod = {
  type: "api" | "oauth" | string
  label: string
  [key: string]: unknown
}

export type ProviderAuthAuthorization = {
  method: "auto" | "code" | string
  url: string
  instructions: string
  [key: string]: unknown
}

export type ProviderModelCapabilities = {
  temperature?: boolean
  reasoning?: boolean
  attachment?: boolean
  toolcall?: boolean
  tool_call?: boolean
  input?: Record<string, boolean>
  output?: Record<string, boolean>
  interleaved?: boolean
}

export type ProviderModelCost = {
  input?: number
  output?: number
  cache?: {
    read?: number
    write?: number
  }
  cache_read?: number
  cache_write?: number
}

export type ProviderModelLimit = {
  context?: number
  output?: number
}

export type ProviderModel = {
  id: string
  providerID: string
  api?: {
    id?: string
    url?: string
    npm?: string
  }
  name: string
  capabilities?: ProviderModelCapabilities
  cost?: ProviderModelCost
  limit?: ProviderModelLimit
  status?: string
  options?: Record<string, unknown>
  headers?: Record<string, string>
  release_date?: string
  variants?: Record<string, unknown>
}

export type Provider = {
  id: string
  name: string
  source?: string
  env?: string[]
  options?: Record<string, unknown>
  models: Record<string, ProviderModel>
  hidden?: boolean
}

export type ProviderListModel = {
  id: string
  name: string
  release_date?: string
  attachment?: boolean
  reasoning?: boolean
  temperature?: boolean
  tool_call?: boolean
  interleaved?: boolean
  cost?: ProviderModelCost
  limit?: ProviderModelLimit
  options?: Record<string, unknown>
}

export type ProviderListItem = {
  id: string
  name: string
  env?: string[]
  api?: string
  npm?: string
  models: Record<string, ProviderListModel>
}

export type ProviderListResponse = {
  all: ProviderListItem[]
  default: Record<string, string>
  connected: string[]
}

export type AgentModelRef = {
  providerID: string
  modelID: string
}

export function parseModelRef(model?: string | null): AgentModelRef | undefined {
  if (!model) return undefined
  const trimmed = model.trim()
  const separatorIndex = trimmed.indexOf("/")
  if (separatorIndex <= 0 || separatorIndex >= trimmed.length - 1) return undefined
  const providerID = trimmed.slice(0, separatorIndex)
  const modelID = trimmed.slice(separatorIndex + 1)
  if (!providerID || !modelID) return undefined
  return {
    providerID,
    modelID,
  }
}

export type Agent = {
  name: string
  description?: string
  mode?: string
  permission?: unknown[]
  options?: Record<string, unknown>
  color?: string
  hidden?: boolean
  model?: AgentModelRef
}

export type Command = {
  id: string
  title?: string
  description?: string
  slash?: string
  keybind?: string
  category?: string
  [key: string]: unknown
}

export type Config = {
  theme?: string
  model?: string
  keybinds?: KeybindsConfig
  tui?: {
    scroll_speed?: number
    scroll_acceleration?: {
      enabled?: boolean
    }
    diff_style?: "auto" | "stacked" | string
    [key: string]: unknown
  }
  share?: string
  plugin?: unknown[]
  experimental?: Record<string, unknown>
  [key: string]: unknown
}

export type Todo = {
  status: string
  content: string
  [key: string]: unknown
}

export type SessionStatus = {
  type: "idle" | "busy" | "retry" | string
  message?: string
  next?: number
  [key: string]: unknown
}

export type McpStatus = {
  status: string
  error?: string
  [key: string]: unknown
}

export type McpResource = {
  name?: string
  [key: string]: unknown
}

export type FormatterStatus = {
  id?: string
  status?: string
  [key: string]: unknown
}

export type VcsInfo = {
  branch?: string
  [key: string]: unknown
}

export type QuestionOption = {
  label: string
  description?: string
  [key: string]: unknown
}

export type Question = {
  header: string
  question: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
  input_kind?: string
  [key: string]: unknown
}

export type QuestionAnswer = string[]

export type QuestionRequest = {
  id: string
  sessionID: string
  questions: Question[]
  [key: string]: unknown
}

export type PermissionToolRef = {
  callID: string
  messageID: string
  [key: string]: unknown
}

export type PermissionRequest = {
  id: string
  sessionID: string
  permission: string
  always: string[]
  patterns?: string[]
  tool?: PermissionToolRef
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export type Session = {
  id: string
  title: string
  materialized?: boolean
  time: {
    created: number
    updated: number
    completed?: number
    compacting?: number
    [key: string]: unknown
  }
  preview?: {
    initialUserMessage?: string
    latestMessage?: string
  }
  slug?: string
  projectID?: string
  directory?: string
  version?: string
  permission?: unknown[]
  parentID?: string
  share?: {
    url: string
    [key: string]: unknown
  }
  revert?: {
    messageID: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export const TuiSessionEvents = {
  Deleted: { type: "session.deleted" },
  Error: { type: "session.error" },
} as const

export function isDefaultSessionTitle(title?: string | null): boolean {
  if (!title) return true
  return title.trim().length === 0
}

export type MessageModelRef = {
  providerID: string
  modelID: string
}

export type TokenUsage = {
  input: number
  output: number
  reasoning: number
  cache: {
    read: number
    write: number
  }
}

export type MessagePath = {
  cwd: string
  root: string
}

export type MessageError = {
  name?: string
  message?: string
  data?: {
    message?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export type BaseMessage = {
  id: string
  sessionID: string
  role: "user" | "assistant" | string
  time: {
    created: number
    completed?: number
    [key: string]: unknown
  }
  agent: string
  [key: string]: unknown
}

export type UserMessage = BaseMessage & {
  role: "user"
  model?: MessageModelRef
  variant?: string
}

export type AssistantMessage = BaseMessage & {
  role: "assistant"
  parentID?: string
  modelID: string
  providerID: string
  mode: string
  path: MessagePath
  cost: number
  tokens: TokenUsage
  finish?: string
  error?: MessageError
}

export type Message = UserMessage | AssistantMessage

export type TextSourceRef = {
  start: number
  end: number
  value: string
}

export type TextPart = {
  id: string
  sessionID: string
  messageID: string
  type: "text"
  text: string
  synthetic?: boolean
  ignored?: boolean
  source?: {
    text?: TextSourceRef
    [key: string]: unknown
  }
  [key: string]: unknown
}

export type FilePart = {
  id: string
  sessionID: string
  messageID: string
  type: "file"
  filename?: string
  mime: string
  url?: string
  source?: {
    type?: string
    path?: string
    text?: TextSourceRef
    [key: string]: unknown
  }
  [key: string]: unknown
}

export type AgentPart = {
  id: string
  sessionID: string
  messageID: string
  type: "agent"
  name: string
  [key: string]: unknown
}

export type ReasoningPart = {
  id: string
  sessionID: string
  messageID: string
  type: "reasoning"
  text: string
  [key: string]: unknown
}

export type ToolPart = {
  id: string
  sessionID: string
  messageID: string
  type: "tool"
  tool: string
  callID: string
  state: {
    status: "pending" | "completed" | "error" | string
    input?: Record<string, unknown>
    output?: string
    error?: string
    metadata?: Record<string, any>
    [key: string]: unknown
  }
  [key: string]: unknown
}

export type CompactionPart = {
  id: string
  sessionID: string
  messageID: string
  type: "compaction"
  [key: string]: unknown
}

export type Part = TextPart | FilePart | AgentPart | ReasoningPart | ToolPart | CompactionPart

export type Event<TType extends string = string, TProperties = Record<string, any>> = {
  type: TType
  properties: TProperties
}

export type ClientResult<T> = Promise<{
  data?: T
  error?: unknown
}>

export type MessageWithParts = {
  info: Message
  parts: Part[]
}

export type UserInputHistoryEntry = {
  text: string
  createdAt?: number
}

export type RuntimeUsage = {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cache_creation_tokens: number
  cache_read_tokens: number
  is_estimated: boolean
}

export type SessionPromptInput = {
  sessionID?: string
  messageID?: string
  agent?: string
  variant?: string
  parts?: Part[]
  model?: string | AgentModelRef
  providerID?: string
  modelID?: string
}

export type SessionCommandInput = {
  sessionID?: string
  command: string
  arguments?: string
  messageID?: string
  agent?: string
  variant?: string
  model?: string | AgentModelRef
  providerID?: string
  modelID?: string
}

export type SessionShellInput = {
  sessionID?: string
  messageID?: string
  command?: string
  agent?: string
  variant?: string
  model?: string | AgentModelRef
  providerID?: string
  modelID?: string
}

export type SessionUpgradeDryRunResult = {
  status: "dry_run"
  mode: "file-store"
  upgraded: boolean
  hasCheckpoint: boolean
  classification: string
  blockers: Array<Record<string, unknown>>
  canUpgrade: boolean
  plannedHeads: Record<string, number>
  upgrade: Record<string, unknown> | null
  checkpointMarker: string | null
}

export type SessionUpgradeApplyResult = {
  status: "applied" | "already_upgraded" | "rejected"
  mode: "file-store"
  dryRun: SessionUpgradeDryRunResult
  result?: Record<string, unknown>
  verification?: {
    classification: string
    blockers: Array<Record<string, unknown>>
  }
}

export type TuiRuntimeClient = {
  session: {
    list(input?: Record<string, unknown>, options?: Record<string, unknown>): ClientResult<Session[]>
    create(input?: Record<string, unknown>, options?: Record<string, unknown>): ClientResult<Session>
    get(input?: { sessionID?: string }, options?: Record<string, unknown>): ClientResult<Session>
    messages(input?: { sessionID?: string; limit?: number }, options?: Record<string, unknown>): ClientResult<MessageWithParts[]>
    userInputs(input?: { sessionID?: string; limit?: number }, options?: Record<string, unknown>): ClientResult<UserInputHistoryEntry[]>
    todo(input?: { sessionID?: string }, options?: Record<string, unknown>): ClientResult<Todo[]>
    diff(input?: { sessionID?: string }, options?: Record<string, unknown>): ClientResult<Array<{ path: string; hunks: string }>>
    status(input?: Record<string, unknown>, options?: Record<string, unknown>): ClientResult<Record<string, SessionStatus>>
    share(input?: { sessionID?: string }, options?: Record<string, unknown>): ClientResult<Session>
    unshare(input?: { sessionID?: string }, options?: Record<string, unknown>): ClientResult<Session>
    summarize(input?: { sessionID?: string }, options?: Record<string, unknown>): ClientResult<unknown>
    abort(input?: { sessionID?: string }, options?: Record<string, unknown>): ClientResult<unknown>
    revert(input?: { sessionID?: string; messageID?: string }, options?: Record<string, unknown>): ClientResult<Session>
    unrevert(input?: { sessionID?: string }, options?: Record<string, unknown>): ClientResult<Session>
    update(input?: { sessionID?: string; title?: string }, options?: Record<string, unknown>): ClientResult<Session>
    delete(input?: { sessionID?: string }, options?: Record<string, unknown>): ClientResult<unknown>
    fork(input?: { sessionID?: string; messageID?: string }, options?: Record<string, unknown>): ClientResult<Session>
    prompt(input: SessionPromptInput, options?: Record<string, unknown>): ClientResult<MessageWithParts>
    command(input: SessionCommandInput, options?: Record<string, unknown>): ClientResult<unknown>
    shell(input: SessionShellInput, options?: Record<string, unknown>): ClientResult<unknown>
    upgradeDryRun(input?: { sessionID?: string }, options?: Record<string, unknown>): ClientResult<SessionUpgradeDryRunResult>
    upgradeApply(input?: { sessionID?: string }, options?: Record<string, unknown>): ClientResult<SessionUpgradeApplyResult>
  }
  permission: {
    reply(input: { requestID: string; reply: string; message?: string }, options?: Record<string, unknown>): ClientResult<unknown>
  }
  question: {
    reply(input: { requestID: string; answers: QuestionAnswer[] }, options?: Record<string, unknown>): ClientResult<unknown>
    reject(input: { requestID: string }, options?: Record<string, unknown>): ClientResult<unknown>
  }
  actor?: {
    surface(input?: { sessionID?: string }, options?: Record<string, unknown>): ClientResult<ActorSurfaceProjectionData | null>
    messages(
      input?: { sessionID?: string; laneID?: string; actorID?: string; limit?: number },
      options?: Record<string, unknown>,
    ): ClientResult<MessageWithParts[]>
    select(
      input: { sessionID?: string; laneID?: string; actorID?: string },
      options?: Record<string, unknown>,
    ): ClientResult<ActorSurfaceProjectionData | null>
    cancel(
      input: { sessionID?: string; actorID: string; turnID?: string },
      options?: Record<string, unknown>,
    ): ClientResult<ActorSurfaceProjectionData | null>
    send(
      input: { sessionID?: string; laneID?: string; actorID?: string; text: string },
      options?: Record<string, unknown>,
    ): ClientResult<ActorSurfaceProjectionData | null>
  }
  provider: {
    list(input?: Record<string, unknown>, options?: Record<string, unknown>): ClientResult<ProviderListResponse>
    auth(input?: Record<string, unknown>, options?: Record<string, unknown>): ClientResult<Record<string, ProviderAuthMethod[]>>
    oauth: {
      authorize(input: { providerID: string; method: number }, options?: Record<string, unknown>): ClientResult<ProviderAuthAuthorization>
      callback(input: { providerID: string; method: number; code?: string }, options?: Record<string, unknown>): ClientResult<unknown>
    }
  }
  config: {
    get(input?: Record<string, unknown>, options?: Record<string, unknown>): ClientResult<Config>
    providers(
      input?: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): ClientResult<{ providers: Provider[]; default: Record<string, string>; connected: string[] }>
  }
  app: {
    agents(input?: Record<string, unknown>, options?: Record<string, unknown>): ClientResult<Agent[]>
  }
  find: {
    files(input?: Record<string, unknown>, options?: Record<string, unknown>): ClientResult<unknown[]>
    text(input?: Record<string, unknown>, options?: Record<string, unknown>): ClientResult<unknown[]>
    symbols(input?: Record<string, unknown>, options?: Record<string, unknown>): ClientResult<unknown[]>
  }
  mcp: {
    status(input?: Record<string, unknown>, options?: Record<string, unknown>): ClientResult<Record<string, McpStatus>>
    connect(input: { name: string }, options?: Record<string, unknown>): ClientResult<unknown>
    disconnect(input: { name: string }, options?: Record<string, unknown>): ClientResult<unknown>
  }
  formatter: {
    status(input?: Record<string, unknown>, options?: Record<string, unknown>): ClientResult<FormatterStatus[]>
  }
  vcs: {
    get(input?: Record<string, unknown>, options?: Record<string, unknown>): ClientResult<VcsInfo | undefined>
  }
  path: {
    get(input?: Record<string, unknown>, options?: Record<string, unknown>): ClientResult<Path>
  }
  command: {
    list(input?: Record<string, unknown>, options?: Record<string, unknown>): ClientResult<Command[]>
  }
  experimental: {
    resource: {
      list(input?: Record<string, unknown>, options?: Record<string, unknown>): ClientResult<Record<string, McpResource>>
    }
  }
  instance: {
    dispose(input?: Record<string, unknown>, options?: Record<string, unknown>): ClientResult<unknown>
  }
  auth: {
    set(
      input: {
        providerID: string
        auth: {
          type: string
          key?: string
          [key: string]: unknown
        }
      },
      options?: Record<string, unknown>,
    ): ClientResult<unknown>
  }
  tui: {
    appendPrompt(input: { text: string }, options?: Record<string, unknown>): ClientResult<unknown>
    openHelp(input?: Record<string, unknown>, options?: Record<string, unknown>): ClientResult<unknown>
    openSessions(input?: Record<string, unknown>, options?: Record<string, unknown>): ClientResult<unknown>
    openThemes(input?: Record<string, unknown>, options?: Record<string, unknown>): ClientResult<unknown>
    openModels(input?: Record<string, unknown>, options?: Record<string, unknown>): ClientResult<unknown>
    submitPrompt(input?: Record<string, unknown>, options?: Record<string, unknown>): ClientResult<unknown>
    clearPrompt(input?: Record<string, unknown>, options?: Record<string, unknown>): ClientResult<unknown>
    executeCommand(input: { command: string }, options?: Record<string, unknown>): ClientResult<unknown>
    showToast(
      input: { message: string; title?: string; variant?: "info" | "success" | "warning" | "error"; duration?: number },
      options?: Record<string, unknown>,
    ): ClientResult<unknown>
    control: {
      next(input?: Record<string, unknown>, options?: Record<string, unknown>): ClientResult<unknown>
      response(input?: Record<string, unknown>, options?: Record<string, unknown>): ClientResult<unknown>
    }
    publish(input?: Record<string, unknown>, options?: Record<string, unknown>): ClientResult<unknown>
  }
}

export type TuiRuntimeEventStream = {
  on?: (handler: (event: Event) => void) => () => void
  subscribe: (input: {}, options?: { signal?: AbortSignal }) => Promise<{ stream: AsyncGenerator<Event, void, unknown> }>
  listen: (handler: (event: CustomEvent<{ detail: Event }>) => void) => () => void
  emit: (event: Event) => void
}

export type TuiRuntimeSdk = {
  client: TuiRuntimeClient
  event: TuiRuntimeEventStream & {
    on: {
      (handler: (event: Event) => void): () => void
      <TType extends Event["type"]>(type: TType, handler: (event: Extract<Event, { type: TType }> | Event) => void): () => void
    }
  }
  url: string
}
