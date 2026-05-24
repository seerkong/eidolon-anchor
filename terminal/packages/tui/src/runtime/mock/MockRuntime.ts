import type { TuiControl } from "@terminal/core/AIAgent/TuiStreamEvents"
import type { TuiRuntimeBridge } from "../bridge/TuiRuntime"

function resolvePromptResponse(input: string): string {
  const text = input.trim()
  if (!text) {
    return "我在。你可以直接描述要处理的代码任务。"
  }

  if (text.includes("你是谁")) {
    return "我是这个终端里的 AI 助手，负责帮你分析代码、修改文件并验证结果。"
  }

  if (text.includes("hello") || text.includes("你好")) {
    return "你好，我已就绪。告诉我你要改的文件或目标行为。"
  }

  return `收到：${text}`
}

async function streamResponseChunks(
  text: string,
  onChunk: (chunk: string) => void,
  chunkSize = 12,
  delayMs = 8,
): Promise<void> {
  let cursor = 0
  while (cursor < text.length) {
    const next = text.slice(cursor, cursor + chunkSize)
    cursor += chunkSize
    onChunk(next)
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
}

function mockChunkDelayMs(): number {
  const raw = process.env.TUI_MOCK_CHUNK_DELAY_MS
  if (!raw) return 8
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return 8
  return parsed
}

export function shouldPreferMockRuntime(): boolean {
  return process.env.TUI_FORCE_MOCK_RESPONDER === "1"
}

const mockRuntimeBridge: TuiRuntimeBridge = {
  async turn(
    input: string,
    opts?: {
      timeoutSeconds?: number
      onChunk?: (chunk: string) => void | Promise<void>
      onControl?: (control: TuiControl) => void | Promise<void>
    },
  ): Promise<string> {
    const text = resolvePromptResponse(input)
    await opts?.onControl?.({ cmd: "NewMessage", category: "assist" })
    await streamResponseChunks(
      text,
      (chunk) => {
        void opts?.onChunk?.(chunk)
      },
      12,
      mockChunkDelayMs(),
    )
    return text
  },
  async abort(): Promise<void> {},
  dispose(): void {},
  subscribeNotifications() {
    return { unsubscribe() {} }
  },
}

export async function getMockRuntimeBridge(): Promise<TuiRuntimeBridge> {
  return mockRuntimeBridge
}
