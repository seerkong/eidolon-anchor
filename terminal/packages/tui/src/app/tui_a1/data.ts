import type { Message, Part, ToolPart } from "@terminal/core/AIAgent"

export type TuiA1ToolState = "running" | "done"

export const tuiModelSourcePriority = [
  "user-explicit",
  "cli-arg",
  "agent-memory",
  "agent-default",
  "runtime-config",
  "recent",
  "provider-default",
] as const

export type TuiModelSource = (typeof tuiModelSourcePriority)[number]

export type TuiModelRef = {
  providerID: string
  modelID: string
}

export type TuiModelCandidate = TuiModelRef & {
  source: TuiModelSource
}

export type TuiEffectiveModel = TuiModelCandidate

export type TuiA1Selection = {
  agent: string
  providerID: string
  modelID: string
  modelSource?: TuiModelSource
}

export const defaultTuiA1Selection: TuiA1Selection = {
  agent: "build",
  providerID: "",
  modelID: "",
  modelSource: undefined,
}

type TuiA1TextMessage = {
  id: string
  kind: "user"
  text: string
  createdAt: number
  completedAt?: number
  label?: string
  mode?: string
  selection?: TuiA1Selection
}

type TuiA1AssistantTextMessage = {
  id: string
  kind: "assistant"
  text: string
  createdAt: number
  completedAt?: number
  parentID?: string
  label?: string
  mode?: string
  streaming?: boolean
  selection?: TuiA1Selection
}

type TuiA1SummaryToolMessage = {
  id: string
  kind: "tool"
  source: "summary"
  tool: string
  createdAt: number
  completedAt?: number
  status: TuiA1ToolState
  summary: string
  input?: Record<string, string | number | boolean>
}

type TuiA1RuntimeToolMessage = {
  id: string
  kind: "tool"
  source: "runtime-part"
  tool: string
  createdAt: number
  completedAt?: number
  input: Record<string, any>
  metadata: Record<string, any>
  output?: string
  part: ToolPart
}

export type TuiA1Message =
  | TuiA1TextMessage
  | TuiA1AssistantTextMessage
  | TuiA1SummaryToolMessage
  | TuiA1RuntimeToolMessage

export function formatTuiA1AgentName(agent: string): string {
  return agent
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

export function formatTuiA1Selection(selection: TuiA1Selection): string {
  return `${formatTuiA1AgentName(selection.agent)} · ${selection.providerID}/${selection.modelID}`
}

export function resolveTuiEffectiveModel(candidates: Array<TuiModelCandidate | undefined>): TuiEffectiveModel | undefined {
  for (const source of tuiModelSourcePriority) {
    const candidate = candidates.find((item) => item?.source === source)
    if (!candidate) continue
    if (!candidate.providerID || !candidate.modelID) continue
    return {
      source: candidate.source,
      providerID: candidate.providerID,
      modelID: candidate.modelID,
    }
  }
  return undefined
}

export function selectionModelCandidate(selection: TuiA1Selection): TuiModelCandidate | undefined {
  if (!selection.providerID || !selection.modelID) return undefined
  const source = selection.modelSource
  if (!source) return undefined
  return {
    source,
    providerID: selection.providerID,
    modelID: selection.modelID,
  }
}

export function attachSelectionToMessages(
  messages: TuiA1Message[],
  selection: TuiA1Selection,
): TuiA1Message[] {
  return messages.map((message) =>
    message.kind === "assistant" && !message.selection
      ? {
          ...message,
          selection,
        }
      : message,
  )
}

export function createRuntimePlaceholderMessages(selection: TuiA1Selection, connecting = false): TuiA1Message[] {
  return [
    {
      id: connecting ? "runtime-connecting" : "runtime-ready",
      kind: "assistant",
      createdAt: Date.now(),
      selection,
      text: connecting
        ? "正在连接本地 runtime，并准备真实会话上下文。"
        : "已连接本地 runtime。发送一条消息即可开始真实对话。",
    },
  ]
}

function isTextPart(part: Part): part is Extract<Part, { type: "text" }> {
  return part.type === "text"
}

function isDisplayableTextPart(part: Part): part is Extract<Part, { type: "text" }> {
  return isTextPart(part) && !part.synthetic && !part.ignored
}

function isToolPart(part: Part): part is ToolPart {
  return part.type === "tool"
}

function asRecord(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, any>
}

function runtimeMessageSelection(message: Message): TuiA1Selection | undefined {
  if (message.role === "assistant") {
    if (!message.providerID || !message.modelID) return undefined
    return {
      agent: message.agent ?? defaultTuiA1Selection.agent,
      providerID: message.providerID,
      modelID: message.modelID,
      modelSource: "runtime-config",
    }
  }

  if (message.role === "user" && message.model) {
    return {
      agent: message.agent ?? defaultTuiA1Selection.agent,
      providerID: message.model.providerID,
      modelID: message.model.modelID,
      modelSource: "runtime-config",
    }
  }

  return undefined
}

export function inferSelectionFromRuntimeMessages(messages: Message[]): TuiA1Selection | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!message) continue
    const selection = runtimeMessageSelection(message)
    if (selection) return selection
  }
  return undefined
}

export function runtimeMessagesToTuiA1Messages(
  messages: Message[],
  partsByMessage: Record<string, Part[]>,
): TuiA1Message[] {
  return messages.flatMap((message) => {
    const parts = partsByMessage[message.id] ?? []
    const selection = runtimeMessageSelection(message)
    const displayableText = parts.filter(isDisplayableTextPart).map((part) => part.text).join("")

    if (message.role !== "assistant") {
      return [
        {
          id: message.id,
          kind: "user",
          createdAt: message.time.created,
          completedAt: message.time.completed,
          text: displayableText,
          selection,
        } satisfies TuiA1Message,
      ]
    }

    const hasToolParts = parts.some(isToolPart)
    const items: TuiA1Message[] = []
    let bufferedText = ""
    let textSegment = 0

    const flushAssistantText = () => {
      if (!bufferedText) return
      items.push({
        id: !hasToolParts && textSegment === 0 ? message.id : `${message.id}:text:${textSegment}`,
        kind: "assistant",
        createdAt: message.time.created,
        completedAt: message.time.completed,
        parentID: message.parentID,
        text: bufferedText,
        mode: message.mode,
        streaming: !message.time.completed,
        selection,
      } satisfies TuiA1Message)
      bufferedText = ""
      textSegment += 1
    }

    for (const part of parts) {
      if (isDisplayableTextPart(part)) {
        bufferedText += part.text
        continue
      }

      flushAssistantText()

      if (!isToolPart(part)) continue

      items.push({
        id: part.id,
        kind: "tool",
        source: "runtime-part",
        createdAt: message.time.created,
        completedAt: message.time.completed,
        tool: part.tool,
        input: asRecord(part.state.input),
        metadata: asRecord(part.state.metadata),
        output: typeof part.state.output === "string" ? part.state.output : undefined,
        part,
      } satisfies TuiA1Message)
    }

    flushAssistantText()

    if (items.length === 0) {
      items.push({
        id: message.id,
        kind: "assistant",
        createdAt: message.time.created,
        completedAt: message.time.completed,
        parentID: message.parentID,
        text: "",
        mode: message.mode,
        streaming: !message.time.completed,
        selection,
      } satisfies TuiA1Message)
    }

    return items
  })
}

export const initialMessages: TuiA1Message[] = [
  {
    id: "m-1",
    kind: "assistant",
    createdAt: Date.now() - 1000 * 60 * 18,
    label: "TuiA1",
    text: "这是一个最小原型 TUI。\n\n它基于 OpenTUI Solid demo，不接真实 runtime，只保留消息浏览、输入、滚动和底栏状态语言。",
  },
  {
    id: "m-2",
    kind: "user",
    createdAt: Date.now() - 1000 * 60 * 17,
    text: "我需要一个新的 terminal agent 壳层原型。",
  },
  {
    id: "m-3",
    kind: "tool",
    source: "summary",
    createdAt: Date.now() - 1000 * 60 * 16,
    tool: "update_plan",
    status: "done",
    summary: "抽离 tui_a1 shell，保留消息卡片风格，替换旧 prompt。",
    input: {
      scope: "tui-shell",
      mode: "tui_a1",
    },
  },
  {
    id: "m-4",
    kind: "assistant",
    createdAt: Date.now() - 1000 * 60 * 15,
    text: "已切换为独立 tuiA1 路线。\n\n下面这块消息区域用于验证滚动、流式输出和卡片视觉；底部输入框可直接发起本地模拟对话。",
  },
  {
    id: "m-5",
    kind: "user",
    createdAt: Date.now() - 1000 * 60 * 13,
    text: "我希望消息卡片保留目前风格，但不要再依赖旧 runtime。",
  },
  {
    id: "m-6",
    kind: "assistant",
    createdAt: Date.now() - 1000 * 60 * 12,
    text: "可以。原型会只保留三件事：消息浏览、输入框和底栏忙碌信标。\n\n这样能把问题收缩到纯 TUI 壳层。",
  },
  {
    id: "m-7",
    kind: "tool",
    source: "summary",
    createdAt: Date.now() - 1000 * 60 * 11,
    tool: "refactor.shell",
    status: "done",
    summary: "消息卡片从旧 renderer 抽取为 tuiA1 专用组件。",
    input: {
      cards: true,
      runtime: false,
    },
  },
  {
    id: "m-8",
    kind: "assistant",
    createdAt: Date.now() - 1000 * 60 * 10,
    text: "新的消息区现在应当天然可滚动，而且一启动就有足够历史可以验证 sticky scroll 与历史翻页。",
  },
  {
    id: "m-9",
    kind: "user",
    createdAt: Date.now() - 1000 * 60 * 8,
    text: "底部输入框请重写，不要沿用旧版那条复杂 prompt。",
  },
  {
    id: "m-10",
    kind: "assistant",
    createdAt: Date.now() - 1000 * 60 * 7,
    text: "已改成更简单的 multiline composer。\n\n`Enter` 发送，`Alt+Enter` 换行，同时保留本地模拟流式回复。",
  },
  {
    id: "m-11",
    kind: "tool",
    source: "summary",
    createdAt: Date.now() - 1000 * 60 * 6,
    tool: "scroll.verify",
    status: "done",
    summary: "加入 tui_a1 scroll smoke test，直接验证鼠标滚轮能推动消息区 scrollTop。",
    input: {
      mouse: true,
      history: true,
    },
  },
  {
    id: "m-12",
    kind: "assistant",
    createdAt: Date.now() - 1000 * 60 * 5,
    text: "如果你的终端对鼠标滚轮处理不稳定，也可以试试 `PageUp`、`PageDown`、`Home`、`End` 来翻历史。",
  },
]

const replyTemplates = [
  "这个原型不会调用 LLM。我会把你的输入回显为本地模拟回复，并用流式文本测试 sticky scroll 行为。",
  "当前目标是证明三个点：最新 OpenTUI 可启动、消息卡片结构可复用、输入与底栏信标可以独立于旧 runtime 工作。",
  "如果你继续输入，我会追加一条 tool 卡片，然后生成一段 assistant 流式回复，方便验证滚动、定位和底栏 busy 状态。",
]

export function buildLocalReply(prompt: string): string {
  const normalized = prompt.trim()
  const template = replyTemplates[normalized.length % replyTemplates.length] ?? replyTemplates[0]!

  return `${template}\n\nLocal echo:\n${normalized}`
}
