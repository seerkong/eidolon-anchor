import fs from "fs/promises"
import os from "os"
import path from "path"

type JsonlLogEntry = {
  timestamp: string
  level: "DEBUG" | "INFO" | "WARN" | "ERROR"
  service?: string
  message: string
  data?: unknown
  line: string
}

function createJsonReplacer() {
  const seen = new WeakSet<object>()
  return (_key: string, value: unknown) => {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      }
    }
    if (typeof value === "object" && value !== null) {
      if (seen.has(value as object)) {
        return "[Circular]"
      }
      seen.add(value as object)
    }
    return value
  }
}

export class JsonlAppendOnlySink {
  private readonly filePath: string
  private buffer: JsonlLogEntry[] = []
  private scheduled = false
  private flushing: Promise<void> | null = null

  constructor(filePath: string) {
    this.filePath = filePath
  }

  append(entry: JsonlLogEntry): void {
    this.buffer.push(entry)
    if (this.flushing || this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      void this.flush()
    })
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing
    this.flushing = this.flushBuffered()
    try {
      await this.flushing
    } finally {
      this.flushing = null
    }
  }

  private async flushBuffered(): Promise<void> {
    if (this.buffer.length === 0) return

    await fs.mkdir(path.dirname(this.filePath), { recursive: true })

    while (this.buffer.length > 0) {
      const batch = this.buffer
      this.buffer = []
      const text = batch.map((entry) => JSON.stringify(entry, createJsonReplacer())).join(os.EOL) + os.EOL
      await fs.appendFile(this.filePath, text, "utf8")
    }
  }
}
