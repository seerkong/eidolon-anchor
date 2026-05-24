import os from "os"
import path from "path"
import fs from "fs"
import { Global } from "../global"
import { JsonlAppendOnlySink } from "./jsonl-log-sink"

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR"

type LogInitOptions = {
  print?: boolean
  dev?: boolean
  level?: LogLevel
  filePath?: string
}

type LogCreateOptions = {
  service?: string
}

function defaultLogPath(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  return path.join(Global.Path.state, "logs", `tui-${process.pid}-${timestamp}.jsonl`)
}

export class Log {
  static Default = new Log()

  private static initialized = false
  private static print = false
  private static level: LogLevel = "INFO"
  private static filePath = defaultLogPath()
  private static sink = new JsonlAppendOnlySink(Log.filePath)

  private service?: string

  static create(input?: LogCreateOptions): Log {
    return new Log(input?.service)
  }

  static async init(input?: LogInitOptions): Promise<void> {
    if (input?.filePath) {
      Log.filePath = input.filePath
    }
    if (typeof input?.print === "boolean") {
      Log.print = input.print
    } else {
      Log.print = true
    }
    if (input?.level) {
      Log.level = input.level
    }

    const dir = path.dirname(Log.filePath)
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {}

    Log.sink = new JsonlAppendOnlySink(Log.filePath)
    Log.initialized = true
  }

  static path(): string {
    return Log.filePath
  }

  static async flush(): Promise<void> {
    await Log.sink.flush()
  }

  constructor(service?: string) {
    this.service = service
  }

  debug(...args: unknown[]): void {
    this.write("DEBUG", args)
  }

  info(...args: unknown[]): void {
    this.write("INFO", args)
  }

  warn(...args: unknown[]): void {
    this.write("WARN", args)
  }

  error(...args: unknown[]): void {
    this.write("ERROR", args)
  }

  time(label?: string) {
    const start = Date.now()
    return {
      dispose: () => {
        const duration = Date.now() - start
        if (label) {
          this.debug(`${label} ${duration}ms`)
        }
      },
      [Symbol.dispose]: () => {
        const duration = Date.now() - start
        if (label) {
          this.debug(`${label} ${duration}ms`)
        }
      },
    }
  }

  child(input?: LogCreateOptions): Log {
    const name = [this.service, input?.service].filter(Boolean).join(":")
    return new Log(name || this.service)
  }

  private write(level: LogLevel, args: unknown[]): void {
    if (!Log.initialized) return
    if (!this.shouldWrite(level)) return

    const timestamp = new Date().toISOString()
    const service = this.service ? ` [${this.service}]` : ""
    const { message, data } = this.buildRecordPayload(args)
    const line = `${timestamp} ${level}${service} ${message}`

    Log.sink.append({
      timestamp,
      level,
      service: this.service,
      message,
      data,
      line,
    })

    if (Log.print) {
      switch (level) {
        case "DEBUG":
          console.debug(line)
          break
        case "INFO":
          console.info(line)
          break
        case "WARN":
          console.warn(line)
          break
        case "ERROR":
          console.error(line)
          break
      }
    }
  }

  private stringify(value: unknown): string {
    if (typeof value === "string") return value
    if (value instanceof Error) return value.stack ?? value.message
    if (Array.isArray(value)) return JSON.stringify(value)
    if (typeof value === "object" && value !== null) {
      try {
        return JSON.stringify(value)
      } catch {
        return String(value)
      }
    }
    return String(value)
  }

  private normalizeJsonValue(value: unknown, seen = new WeakSet<object>()): unknown {
    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
      }
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.normalizeJsonValue(item, seen))
    }
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]"
      seen.add(value)
      const result: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value)) {
        result[key] = this.normalizeJsonValue(item, seen)
      }
      return result
    }
    return value
  }

  private buildRecordPayload(args: unknown[]): { message: string; data?: unknown } {
    if (args.length === 0) {
      return { message: "" }
    }

    if (args.length === 1) {
      const single = args[0]
      return {
        message: this.stringify(single),
        data: this.normalizeJsonValue(single),
      }
    }

    const [head, ...tail] = args
    if (typeof head === "string") {
      return {
        message: tail.length === 1 ? head : `${head} ${tail.map((item) => this.stringify(item)).join(" ")}`,
        data: tail.length === 1 ? this.normalizeJsonValue(tail[0]) : this.normalizeJsonValue(tail),
      }
    }

    return {
      message: args.map((item) => this.stringify(item)).join(" "),
      data: this.normalizeJsonValue(args),
    }
  }

  private shouldWrite(level: LogLevel): boolean {
    const weights: Record<LogLevel, number> = {
      DEBUG: 10,
      INFO: 20,
      WARN: 30,
      ERROR: 40,
    }
    return weights[level] >= weights[Log.level]
  }
}

export const log = new Log()
