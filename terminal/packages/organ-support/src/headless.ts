import {
  configureTerminalRuntime,
  disposeTuiRuntimeBridge,
  getTuiRuntimeBridge,
} from "@terminal/organ/AIAgent/TerminalRuntime"
import { makeSessionKey } from "@terminal/core/AIAgent"
import type { TuiControl } from "@terminal/core/AIAgent/TuiStreamEvents"

export type HeadlessTurnOptions = {
  workDir: string
  input: string
  sessionKey?: string
  adapter?: string
  model?: string
  timeoutSeconds?: number
  debug?: boolean
  mcp?: boolean
  onChunk?: (chunk: string) => void | Promise<void>
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
  configureTerminalRuntime({
    workDir: options.workDir,
    adapter: options.adapter,
    model: options.model,
    timeoutSeconds: options.timeoutSeconds,
    debug: options.debug,
    mcp: options.mcp,
  })

  const sessionKey = options.sessionKey?.trim() || makeSessionKey()
  const runtime = await getTuiRuntimeBridge(sessionKey)
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
    await disposeTuiRuntimeBridge(sessionKey)
  }
}
