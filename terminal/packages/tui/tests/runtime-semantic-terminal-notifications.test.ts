import { afterEach, describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

import {
  __emitAsyncRuntimeDetachedActorDoneForTest,
  __sendRuntimeCoordinationForTest,
  __setLlmAdapterFactoryForTest,
  configureTuiRuntime,
  disposeTuiRuntimeBridge,
  getTuiRuntimeBridge,
} from "../src/runtime/bridge/TuiRuntime"

function makeTempWorkdir(): string {
  const dir = path.join(
    os.tmpdir(),
    `tui-stream-notify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  fs.mkdirSync(path.join(dir, ".eidolon", "agents"), { recursive: true })
  fs.mkdirSync(path.join(dir, ".eidolon", "mcp"), { recursive: true })
  return dir
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error("Timed out waiting for condition")
}

afterEach(() => {
  __setLlmAdapterFactoryForTest(null)
})

describe("TuiRuntime semantic terminal notifications", () => {
  it("surfaces detached background results through notifications", async () => {
    const sessionKey = `semantic-terminal-notify-${Date.now()}`
    const workdir = makeTempWorkdir()
    configureTuiRuntime({
      workDir: workdir,
      adapter: "openai",
      model: "gpt-4o-mini",
      debug: false,
      mcp: false,
    })

    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream() {
        async function* stream() {
          yield { choices: [{ delta: { content: "idle" } }] } as any
        }
        return { stream: stream() }
      },
    }))

    try {
      const runtime = await getTuiRuntimeBridge(sessionKey)
      expect(runtime).toBeTruthy()
      await runtime!.turn("hello")

      const notifications: Array<{ text: string; category?: string }> = []
      const sub = runtime!.subscribeNotifications((notification) => {
        notifications.push({
          text: String(notification.text ?? ""),
          category: notification.category,
        })
      })

      expect(
        __emitAsyncRuntimeDetachedActorDoneForTest(
          sessionKey,
          {
            taskId: "bg-1",
            kind: "bash",
            status: "completed",
            outputText: "background done",
          },
        ),
      ).toBe(true)

      await waitFor(() => notifications.length >= 1)
      expect(notifications.some((entry) => entry.category === "result" && entry.text.includes("bg-1: background done"))).toBe(true)

      sub.unsubscribe()
    } finally {
      await disposeTuiRuntimeBridge(sessionKey)
    }
  })

  it("renders coordination control events when they are queued into runtime inbox before a turn", async () => {
    const sessionKey = `semantic-terminal-inbox-${Date.now()}`
    const workdir = makeTempWorkdir()
    configureTuiRuntime({
      workDir: workdir,
      adapter: "openai",
      model: "gpt-4o-mini",
      debug: false,
      mcp: false,
    })

    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream() {
        async function* stream() {
          yield { choices: [{ delta: { content: "idle" } }] } as any
        }
        return { stream: stream() }
      },
    }))

    try {
      const runtime = await getTuiRuntimeBridge(sessionKey)
      expect(runtime).toBeTruthy()
      await runtime!.turn("hello")

      expect(await __sendRuntimeCoordinationForTest({
        sessionKey,
        from: "planner",
        coordination: "plan_approval",
        kind: "plan_request",
        payload: { plan: "review this plan" },
        defer: true,
      })).toBe(true)
      expect(await __sendRuntimeCoordinationForTest({
        sessionKey,
        from: "worker-1",
        coordination: "shutdown",
        kind: "shutdown_request",
        payload: { reason: "maintenance" },
        defer: true,
      })).toBe(true)

      const controls: string[] = []
      const chunks: string[] = []
      const output = await runtime!.turn("continue", {
        onControl: (control) => {
          controls.push(control.category ?? "")
        },
        onChunk: (chunk) => {
          chunks.push(chunk)
        },
      })

      expect(controls).toContain("questionnaire")
      expect(controls).toContain("notice")
      expect(chunks.join("")).toContain("Plan approval")
      expect(chunks.join("")).toContain("pending")
      expect(chunks.join("")).toContain("Shutdown request")
      expect(chunks.join("")).toContain("worker-1")
      expect(output).toContain("Plan approval")
    } finally {
      await disposeTuiRuntimeBridge(sessionKey)
    }
  })
})
