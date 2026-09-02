import {
  configureSessionRuntime,
  disposeSessionRuntimeBridge,
  getSessionRuntimeBridge,
} from "@terminal/organ/AIAgent/TerminalRuntime"
import { makeSessionKey } from "@terminal/core/AIAgent"
import type { TuiControl } from "@terminal/core/AIAgent/TuiStreamEvents"
import type { ConversationSessionForkResult } from "@cell/ai-organ-contract"

export type HeadlessTurnOptions = {
  workDir: string
  input: string
  sessionKey?: string
  adapter?: string
  model?: string
  timeoutSeconds?: number
  debug?: boolean
  mcp?: boolean
  storage?: { logs?: boolean; files?: boolean }
  onChunk?: (chunk: string) => void | Promise<void>
}

export type HeadlessConversationForkOptions = {
  workDir: string
  sourceSessionId: string
  targetSessionId?: string
  messageId?: string
  adapter?: string
  model?: string
  debug?: boolean
  mcp?: boolean
  occurredAt?: string
}

export async function readHeadlessInput(prompt?: string): Promise<string | undefined> {
  const piped = !process.stdin.isTTY ? await Bun.stdin.text() : undefined
  if (!prompt) {
    return piped
  }
  return piped ? `${piped}\n${prompt}` : prompt
}

function shouldEmitHeadlessCategory(category?: string): boolean {
  return category === undefined
    || category === "assist"
    || category === "quote"
    || category === "questionnaire"
    || category === "error"
}

function resolveHeadlessCategory(control: TuiControl): string | undefined {
  if (control.cmd !== "NewMessage") return undefined
  return control.category
}

export async function runHeadlessTurn(options: HeadlessTurnOptions): Promise<string> {
  configureSessionRuntime({
    workDir: options.workDir,
    adapter: options.adapter,
    model: options.model,
    timeoutSeconds: options.timeoutSeconds,
    debug: options.debug,
    mcp: options.mcp,
    entryType: "headless",
    storage: options.storage,
  })

  const sessionKey = options.sessionKey?.trim() || makeSessionKey()
  const runtime = await getSessionRuntimeBridge(sessionKey)
  if (!runtime) {
    throw new Error("Runtime unavailable: failed to initialize model adapter from configuration")
  }

  try {
    let activeCategory: string | undefined
    let filteredOutput = ""
    const rawOutput = await runtime.turn(options.input, {
      timeoutSeconds: options.timeoutSeconds,
      onControl: (control) => {
        const category = resolveHeadlessCategory(control)
        if (category !== undefined) activeCategory = category
      },
      onChunk: async (chunk) => {
        if (!shouldEmitHeadlessCategory(activeCategory)) return
        filteredOutput += chunk
        await options.onChunk?.(chunk)
      },
    })
    return filteredOutput || rawOutput
  } finally {
    await disposeSessionRuntimeBridge(sessionKey)
  }
}

/**
 * Headless projection of the same Conversation-owned fork command used by the
 * TUI. It does not load or copy rendered messages and returns the domain
 * receipt/rejection unchanged.
 */
export async function runHeadlessConversationFork(
  options: HeadlessConversationForkOptions,
): Promise<ConversationSessionForkResult> {
  configureSessionRuntime({
    workDir: options.workDir,
    adapter: options.adapter,
    model: options.model,
    debug: options.debug,
    mcp: options.mcp,
    entryType: "headless",
  })

  const runtime = await getSessionRuntimeBridge(options.sourceSessionId)
  if (!runtime?.forkConversationSession) {
    throw new Error("Conversation fork capability is unavailable")
  }
  try {
    return await runtime.forkConversationSession({
      schemaVersion: "conversation.session-fork-command/v1",
      sourceSessionId: options.sourceSessionId,
      targetSessionId: options.targetSessionId?.trim() || makeSessionKey(),
      selector: options.messageId
        ? { kind: "through_committed_message", messageId: options.messageId }
        : { kind: "current_head" },
      occurredAt: options.occurredAt ?? new Date().toISOString(),
    })
  } finally {
    await disposeSessionRuntimeBridge(options.sourceSessionId)
  }
}
