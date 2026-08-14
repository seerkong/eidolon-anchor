import { afterEach, describe, expect, it } from "bun:test"
import os from "node:os"
import path from "node:path"
import fs from "node:fs"

import { maybeWarnWindowsSandbox } from "../src/entry/thread"

let tempRoot: string | null = null

afterEach(() => {
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true })
    tempRoot = null
  }
})

describe("maybeWarnWindowsSandbox", () => {
  it("is a no-op on non-Windows platforms", () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-warn-"))
    const originalPlatform = process.platform
    Object.defineProperty(process, "platform", { value: "linux", configurable: true })
    try {
      // Should not throw and should not attempt any runner resolution.
      expect(() => maybeWarnWindowsSandbox(tempRoot!, false)).not.toThrow()
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true })
    }
  })

  it("is a no-op when the user explicitly bypasses approvals/sandbox", () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-warn-"))
    const originalPlatform = process.platform
    Object.defineProperty(process, "platform", { value: "win32", configurable: true })
    try {
      expect(() => maybeWarnWindowsSandbox(tempRoot!, true)).not.toThrow()
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true })
    }
  })

  it("does not throw on Windows when the runner is absent", () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-warn-"))
    const originalPlatform = process.platform
    Object.defineProperty(process, "platform", { value: "win32", configurable: true })
    try {
      expect(() => maybeWarnWindowsSandbox(tempRoot!, false)).not.toThrow()
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true })
    }
  })
})
