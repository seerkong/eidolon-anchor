import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Log } from "../src/support/util/log"

function tempLogPath(): string {
  const dir = path.join(os.tmpdir(), `eidolon-log-jsonl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, "diagnostics.jsonl")
}

describe("JSONL diagnostics log sink", () => {
  let filePath = ""

  beforeEach(async () => {
    filePath = tempLogPath()
    await Log.init({
      filePath,
      print: false,
      level: "DEBUG",
    })
  })

  afterEach(async () => {
    await Log.flush()
  })

  it("buffers log writes until flushed", async () => {
    Log.Default.info("tui.sync.listened", { sessionID: "ses_1" })

    expect(fs.existsSync(filePath)).toBe(false)

    await Log.flush()

    const text = fs.readFileSync(filePath, "utf8").trim()
    expect(text).not.toBe("")
    const record = JSON.parse(text)

    expect(record.level).toBe("INFO")
    expect(record.message).toContain("tui.sync.listened")
    expect(record.data.sessionID).toBe("ses_1")
  })

  it("appends one JSON object per line", async () => {
    Log.Default.info("first", { a: 1 })
    Log.Default.warn("second", { b: 2 })

    await Log.flush()

    const lines = fs
      .readFileSync(filePath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)

    expect(lines.length).toBe(2)

    const first = JSON.parse(lines[0]!)
    const second = JSON.parse(lines[1]!)

    expect(first.message).toContain("first")
    expect(first.data.a).toBe(1)
    expect(second.level).toBe("WARN")
    expect(second.data.b).toBe(2)
  })
})
