import { afterEach, describe, expect, it } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"

import {
  __emitRuntimeDetachedActorDoneForTest,
  __sendRuntimeCoordinationForTest,
  __setLlmAdapterFactoryForTest,
  configureTuiRuntime,
  disposeTerminalRuntimeBridge,
  disposeTuiRuntimeBridge,
  getTerminalRuntimeBridge,
  getTuiRuntimeBridge,
} from "../src/runtime/bridge/TuiRuntime"

function makeTempWorkdir(): string {
  const dir = path.join(
    os.tmpdir(),
    `tui-semantic-terminal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  fs.mkdirSync(path.join(dir, ".eidolon", "agents"), { recursive: true })
  fs.mkdirSync(path.join(dir, ".eidolon", "mcp"), { recursive: true })
  return dir
}

afterEach(() => {
  __setLlmAdapterFactoryForTest(null)
})

describe("TuiRuntime semantic terminal smoke", () => {
  it("delivers chunks while a turn is still running", async () => {
    const sessionKey = `semantic-terminal-live-${Date.now()}`
    const workdir = makeTempWorkdir()
    configureTuiRuntime({
      workDir: workdir,
      adapter: "openai",
      model: "gpt-4o-mini",
      debug: false,
      mcp: false,
    })

    let resolveFirstYielded = () => {}
    const firstYielded = new Promise<void>((resolve) => {
      resolveFirstYielded = resolve
    })
    let releaseSecond = () => {}
    const secondReleased = new Promise<void>((resolve) => {
      releaseSecond = resolve
    })
    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream() {
        async function* stream() {
          resolveFirstYielded()
          yield { choices: [{ delta: { content: "first" } }] } as any
          await secondReleased
          yield { choices: [{ delta: { content: "second" } }] } as any
        }
        return { stream: stream() }
      },
    }))

    try {
      const runtime = await getTuiRuntimeBridge(sessionKey)
      expect(runtime).toBeTruthy()

      const chunks: string[] = []
      let settled = false
      const turnPromise = runtime!.turn("hello", {
        onChunk: (chunk) => {
          chunks.push(chunk)
        },
      }).finally(() => {
        settled = true
      })

      await firstYielded
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(settled).toBe(false)
      expect(chunks.join("")).toContain("first")
      expect(chunks.join("")).not.toContain("second")

      releaseSecond()
      const output = await turnPromise
      expect(output).toContain("firstsecond")
    } finally {
      await disposeTuiRuntimeBridge(sessionKey)
    }
  })

  it("streams controls and chunks through the semantic terminal path", async () => {
    const sessionKey = `semantic-terminal-${Date.now()}`
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
          yield { choices: [{ delta: { reasoning_content: "internal reasoning" } }] } as any
          yield { choices: [{ delta: { content: "visible answer" } }] } as any
        }
        return { stream: stream() }
      },
    }))

    try {
      const runtime = await getTuiRuntimeBridge(sessionKey)
      expect(runtime).toBeTruthy()

      const controls: string[] = []
      const chunks: string[] = []
      const output = await runtime!.turn("hello", {
        onControl: (control) => {
          controls.push(control.category ?? "")
        },
        onChunk: (chunk) => {
          chunks.push(chunk)
        },
      })

      expect(controls).toContain("think")
      expect(controls).toContain("assist")
      expect(chunks.join("")).toContain("internal reasoning")
      expect(chunks.join("")).toContain("visible answer")
      expect(output).toContain("visible answer")
    } finally {
      await disposeTuiRuntimeBridge(sessionKey)
    }
  })

  it("exposes textual projection through the terminal runtime bridge", async () => {
    const sessionKey = `semantic-terminal-textual-${Date.now()}`
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
          yield { choices: [{ delta: { reasoning_content: "internal reasoning" } }] } as any
          yield { choices: [{ delta: { content: "visible answer" } }] } as any
        }
        return { stream: stream() }
      },
    }))

    try {
      const runtime = await getTerminalRuntimeBridge(sessionKey)
      expect(runtime).toBeTruthy()

      const chunks: string[] = []
      const output = await runtime!.turn("hello", {
        onChunk: (chunk) => {
          chunks.push(chunk)
        },
      })

      expect(chunks.join("")).toContain("🤔 Think: internal reasoning")
      expect(chunks.join("")).toContain("🤖 Assist: visible answer")
      expect(output).toContain("🤖 Assist: visible answer")
    } finally {
      await disposeTerminalRuntimeBridge(sessionKey)
    }
  })

  it("streams tool-call output exactly once through the canonical semantic path", async () => {
    const sessionKey = `semantic-terminal-tool-${Date.now()}`
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
          yield {
            choices: [
              {
                delta: {
                  content:
                    "我先查询!unquote_start\n<tool_call id=\"query_order_xxx\" lang=\"javascript\">\nCustom.orderDetail(`ORDER-1234`)\n</tool_call>\n!unquote_end",
                },
              },
            ],
          } as any
        }
        return { stream: stream() }
      },
    }))

    try {
      const runtime = await getTuiRuntimeBridge(sessionKey)
      expect(runtime).toBeTruthy()

      const controls: string[] = []
      const chunks: string[] = []
      const output = await runtime!.turn("hello", {
        onControl: (control) => {
          controls.push(control.category ?? "")
        },
        onChunk: (chunk) => {
          chunks.push(chunk)
        },
      })

      expect(controls.filter((category) => category === "assist").length).toBe(1)
      expect(controls.filter((category) => category === "toolcall").length).toBe(1)
      expect(chunks.filter((chunk) => chunk === "我先查询").length).toBe(1)
      expect(chunks.some((chunk) => chunk.includes("Custom\nCustom.orderDetail(`ORDER-1234`)"))).toBe(true)
      expect(chunks.some((chunk) => chunk.includes("Custom.orderDetail\nCustom.orderDetail(`ORDER-1234`)"))).toBe(false)
      expect(output).toContain("Custom\nCustom.orderDetail(`ORDER-1234`)")
    } finally {
      await disposeTuiRuntimeBridge(sessionKey)
    }
  })

  it("renders questionnaire control events through the semantic terminal path", async () => {
    const sessionKey = `semantic-terminal-questionnaire-${Date.now()}`
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
          yield {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "tc-q-1",
                      type: "function",
                      function: {
                        name: "Questionnaire",
                        arguments: JSON.stringify({
                          questionnaireId: "q-1",
                          title: "Confirm",
                          intro: "Proceed?",
                          suspendPolicy: "pause_all",
                          questions: [
                            {
                              id: "q1",
                              prompt: "Proceed?",
                              type: "yes_no",
                              required: true,
                            },
                          ],
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          } as any
        }
        return { stream: stream() }
      },
    }))

    try {
      const runtime = await getTuiRuntimeBridge(sessionKey)
      expect(runtime).toBeTruthy()

      const controls: string[] = []
      const chunks: string[] = []
      const output = await runtime!.turn("please ask me", {
        onControl: (control) => {
          controls.push(control.category ?? "")
        },
        onChunk: (chunk) => {
          chunks.push(chunk)
        },
      })

      expect(controls).toContain("questionnaire")
      expect(chunks.join("")).toContain("Confirm")
      expect(chunks.join("")).toContain("Proceed?")
      expect(output).toContain("Confirm")
    } finally {
      await disposeTuiRuntimeBridge(sessionKey)
    }
  })

  it("renders detached background-result events during a turn", async () => {
    const sessionKey = `semantic-terminal-background-${Date.now()}`
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
          await new Promise((resolve) => setTimeout(resolve, 40))
          yield { choices: [{ delta: { content: "idle" } }] } as any
          await new Promise((resolve) => setTimeout(resolve, 40))
        }
        return { stream: stream() }
      },
    }))

    const runtime = await getTuiRuntimeBridge(sessionKey)
    expect(runtime).toBeTruthy()

    const controls: string[] = []
    const chunks: string[] = []
    const turnPromise = runtime!.turn("continue", {
      onControl: (control) => {
        controls.push(control.category ?? "")
      },
      onChunk: (chunk) => {
        chunks.push(chunk)
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(
      __emitRuntimeDetachedActorDoneForTest(sessionKey, {
        taskId: "bg-1",
        kind: "bash",
        status: "completed",
        outputText: "background done",
      }),
    ).toBe(true)

    const output = await turnPromise

    expect(controls).toContain("result")
    expect(chunks.join("")).toContain("bg-1: background done")
    expect(output).toContain("bg-1: background done")

    await disposeTuiRuntimeBridge(sessionKey)
  })

  it("renders coordination events during an active turn via runtime coordination emitter", async () => {
    const sessionKey = `semantic-terminal-protocol-live-${Date.now()}`
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
          await new Promise((resolve) => setTimeout(resolve, 60))
          yield { choices: [{ delta: { content: "idle" } }] } as any
          await new Promise((resolve) => setTimeout(resolve, 60))
        }
        return { stream: stream() }
      },
    }))

    try {
      const runtime = await getTuiRuntimeBridge(sessionKey)
      expect(runtime).toBeTruthy()

      const controls: string[] = []
      const chunks: string[] = []
      const turnPromise = runtime!.turn("continue", {
        onControl: (control) => {
          controls.push(control.category ?? "")
        },
        onChunk: (chunk) => {
          chunks.push(chunk)
        },
      })

      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(await __sendRuntimeCoordinationForTest({
        sessionKey,
        from: "planner",
        coordination: "plan_approval",
        kind: "plan_request",
        payload: { plan: "review this plan" },
        visibleNow: true,
      })).toBe(true)
      expect(await __sendRuntimeCoordinationForTest({
        sessionKey,
        from: "worker-1",
        coordination: "shutdown",
        kind: "shutdown_request",
        payload: { reason: "maintenance" },
        visibleNow: true,
      })).toBe(true)

      const output = await turnPromise

      expect(controls).toContain("questionnaire")
      expect(controls).toContain("notice")
      expect(chunks.join("")).toContain("Plan approval")
      expect(chunks.join("")).toContain("review this plan")
      expect(chunks.join("")).toContain("Shutdown request")
      expect(chunks.join("")).toContain("maintenance")
      expect(output).toContain("Plan approval")
      expect(output).toContain("Shutdown request")
    } finally {
      await disposeTuiRuntimeBridge(sessionKey)
    }
  })
})
