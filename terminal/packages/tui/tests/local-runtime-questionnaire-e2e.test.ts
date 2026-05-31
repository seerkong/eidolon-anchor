import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "bun:test"
import type { Event, Part } from "@terminal/core/AIAgent"
import { __setLlmAdapterFactoryForTest, configureTuiRuntime, disposeTuiRuntimeBridge } from "../src/runtime/bridge/TuiRuntime"
import { createTuiRuntimeClient } from "../src/runtime/client/TuiRuntimeClient"

const originalHome = process.env.HOME

function createTempProject() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-anchor-tui-q-"))
  fs.mkdirSync(path.join(workDir, ".eidolon", "agents"), { recursive: true })
  fs.mkdirSync(path.join(workDir, ".eidolon", "mcp"), { recursive: true })
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-anchor-home-q-"))
  fs.mkdirSync(path.join(homeDir, ".eidolon"), { recursive: true })
  fs.writeFileSync(
    path.join(homeDir, ".eidolon", "llm-provider.json"),
    JSON.stringify(
      {
        providers: [
          {
            name: "openai",
            baseURL: "https://api.openai.com/v1",
            apiKey: "test-key",
            models: [{ name: "gpt-4o-mini", context: 128000, output: 8192 }],
          },
        ],
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(
    path.join(homeDir, ".eidolon", "agent-preset.json"),
    JSON.stringify(
      {
        preset: "default",
        presets: {
          default: {
            main: {
              model: "openai/gpt-4o-mini",
            },
          },
        },
      },
      null,
      2,
    ),
  )
  process.env.HOME = homeDir
  return { workDir, homeDir }
}

afterEach(() => {
  __setLlmAdapterFactoryForTest(null)
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
})

function findLastMessage(messages: any[], role: string) {
  return [...messages].reverse().find((message) => message?.role === role)
}

function findToolMessage(messages: any[], toolCallId: string) {
  return messages.find((message) => message?.role === "tool" && message?.tool_call_id === toolCallId)
}

describe("TuiRuntimeClient local-runtime questionnaire e2e", () => {
  it("shows the questionnaire request and resumes assistant output after replying", async () => {
    const { workDir, homeDir } = createTempProject()
    configureTuiRuntime({
      workDir,
      adapter: "openai",
      model: "gpt-4o-mini",
      debug: false,
      mcp: false,
    })

    const sessionID = `local-runtime-q-${Date.now()}`

    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream(options: any) {
        const messages = Array.isArray(options?.messages) ? options.messages : []
        const firstSystem = String(messages[0]?.content ?? "")

        if (firstSystem.startsWith("QUESTIONNAIRE_ANSWER_PARSER_V2")) {
          async function* parserStream() {
            yield {
              choices: [
                {
                  delta: {
                    content: JSON.stringify({
                      status: "ok",
                      answers: { q1: true },
                      errors: [],
                    }),
                  },
                },
              ],
            } as any
          }
          return { stream: parserStream() }
        }

        const lastUser = String(findLastMessage(messages, "user")?.content ?? "")
        const questionnaireTool = findToolMessage(messages, "tc-q-1")

        async function* stream() {
          if (lastUser.includes("ask questionnaire") && !questionnaireTool) {
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
            return
          }

          if (questionnaireTool) {
            yield { choices: [{ delta: { content: "assistant after questionnaire" } }] } as any
            return
          }

          yield { choices: [{ delta: { content: "ok" } }] } as any
        }

        return { stream: stream() }
      },
    }))

    try {
      const sdk = createTuiRuntimeClient({
        mode: "local-runtime",
        directory: workDir,
      })

      const events: Event[] = []
      const unsub = sdk.event.on((event) => events.push(event))

      await sdk.client.session.prompt({
        sessionID,
        parts: [{ id: "p1", type: "text", text: "ask questionnaire" } as Part],
      })
      await new Promise((resolve) => setTimeout(resolve, 20))

      const asked = events.find((event) => event.type === "question.asked") as Event<"question.asked"> | undefined
      expect(asked?.properties).toMatchObject({
        id: "q-1",
        sessionID,
      })

      await sdk.client.question.reply({
        requestID: "q-1",
        answers: [["Yes"]],
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      unsub()

      const replied = events.find((event) => event.type === "question.replied") as Event<"question.replied"> | undefined
      expect(replied?.properties).toMatchObject({
        sessionID,
        requestID: "q-1",
      })

      const messages = await sdk.client.session.messages({ sessionID })
      const texts = (messages.data ?? []).flatMap((entry) =>
        (entry.parts ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])),
      )

      expect(texts).toContain("ask questionnaire")
      expect(texts).toContain("Q1: A")
      expect(texts).toContain("assistant after questionnaire")
    } finally {
      await disposeTuiRuntimeBridge(sessionID)
      fs.rmSync(workDir, { recursive: true, force: true })
      fs.rmSync(homeDir, { recursive: true, force: true })
    }
  })

  it("rehydrates a pending questionnaire when continuing an existing session", async () => {
    const { workDir, homeDir } = createTempProject()
    configureTuiRuntime({
      workDir,
      adapter: "openai",
      model: "gpt-4o-mini",
      debug: false,
      mcp: false,
    })

    const sessionID = `local-runtime-q-resume-${Date.now()}`

    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream(options: any) {
        const messages = Array.isArray(options?.messages) ? options.messages : []
        const firstSystem = String(messages[0]?.content ?? "")

        if (firstSystem.startsWith("QUESTIONNAIRE_ANSWER_PARSER_V2")) {
          async function* parserStream() {
            yield {
              choices: [
                {
                  delta: {
                    content: JSON.stringify({
                      status: "ok",
                      answers: { q1: true },
                      errors: [],
                    }),
                  },
                },
              ],
            } as any
          }
          return { stream: parserStream() }
        }

        const lastUser = String(findLastMessage(messages, "user")?.content ?? "")
        const questionnaireTool = findToolMessage(messages, "tc-q-1")

        async function* stream() {
          if (lastUser.includes("ask questionnaire") && !questionnaireTool) {
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
            return
          }

          if (questionnaireTool) {
            yield { choices: [{ delta: { content: "assistant after resume reply" } }] } as any
            return
          }

          yield { choices: [{ delta: { content: "ok" } }] } as any
        }

        return { stream: stream() }
      },
    }))

    try {
      const sdk1 = createTuiRuntimeClient({
        mode: "local-runtime",
        directory: workDir,
      })
      await sdk1.client.session.prompt({
        sessionID,
        parts: [{ id: "p1", type: "text", text: "ask questionnaire" } as Part],
      })

      const sdk2 = createTuiRuntimeClient({
        mode: "local-runtime",
        directory: workDir,
      })
      const events: Event[] = []
      const unsub = sdk2.event.on((event) => events.push(event))

      await sdk2.client.session.messages({ sessionID })
      await new Promise((resolve) => setTimeout(resolve, 20))

      const asked = events.find((event) => event.type === "question.asked") as Event<"question.asked"> | undefined
      expect(asked?.properties).toMatchObject({
        id: "q-1",
        sessionID,
      })

      await sdk2.client.question.reply({
        requestID: "q-1",
        answers: [["Yes"]],
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      unsub()

      const messages = await sdk2.client.session.messages({ sessionID })
      const texts = (messages.data ?? []).flatMap((entry) =>
        (entry.parts ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])),
      )

      expect(texts).toContain("Q1: A")
      expect(texts).toContain("assistant after resume reply")
    } finally {
      await disposeTuiRuntimeBridge(sessionID)
      fs.rmSync(workDir, { recursive: true, force: true })
      fs.rmSync(homeDir, { recursive: true, force: true })
    }
  })

  it("continues with assistant output after a multi-question travel intake reply", async () => {
    const { workDir, homeDir } = createTempProject()
    configureTuiRuntime({
      workDir,
      adapter: "openai",
      model: "gpt-4o-mini",
      debug: false,
      mcp: false,
    })

    const sessionID = `local-runtime-q-travel-${Date.now()}`

    __setLlmAdapterFactoryForTest(async () => ({
      type: "openai" as const,
      async createStream(options: any) {
        const messages = Array.isArray(options?.messages) ? options.messages : []
        const firstSystem = String(messages[0]?.content ?? "")

        if (firstSystem.startsWith("QUESTIONNAIRE_ANSWER_PARSER_V2")) {
          const parserInput = JSON.parse(String(messages[1]?.content ?? "{}"))
          async function* parserStream() {
            yield {
              choices: [
                {
                  delta: {
                    content: JSON.stringify({
                      status: "ok",
                      answers: {
                        days: parserInput.rawText?.includes("7天") ? "7天" : "",
                        style: "自然风光",
                      },
                      errors: [],
                    }),
                  },
                },
              ],
            } as any
          }
          return { stream: parserStream() }
        }

        const lastUser = String(findLastMessage(messages, "user")?.content ?? "")
        const questionnaireTool = findToolMessage(messages, "tc-travel-1")
        const toolContent = String(questionnaireTool?.content ?? "")

        async function* stream() {
          if (lastUser.includes("帮我规划云南旅游") && !questionnaireTool) {
            yield {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "tc-travel-1",
                        type: "function",
                        function: {
                          name: "Questionnaire",
                          arguments: JSON.stringify({
                            questionnaireId: "travel-q-1",
                            title: "云南旅行 intake",
                            intro: "请先回答几个关键条件。",
                            suspendPolicy: "pause_all",
                            questions: [
                              {
                                id: "days",
                                prompt: "你计划玩几天？",
                                type: "text",
                                required: true,
                              },
                              {
                                id: "style",
                                prompt: "你更偏好哪种旅行风格？",
                                type: "single_select",
                                required: true,
                                choices: ["轻松慢游", "自然风光", "古城人文"],
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
            return
          }

          if (questionnaireTool && toolContent.includes("\"days\":\"7天\"") && toolContent.includes("\"style\":\"自然风光\"")) {
            yield { choices: [{ delta: { content: "基于你的回答，我建议云南 7 天自然风光路线：昆明 1 天，大理 2 天，丽江 2 天，香格里拉 2 天。" } }] } as any
            return
          }

          yield { choices: [{ delta: { content: "ok" } }] } as any
        }

        return { stream: stream() }
      },
    }))

    try {
      const sdk = createTuiRuntimeClient({
        mode: "local-runtime",
        directory: workDir,
      })

      const events: Event[] = []
      const unsub = sdk.event.on((event) => events.push(event))

      await sdk.client.session.prompt({
        sessionID,
        parts: [{ id: "p1", type: "text", text: "帮我规划云南旅游" } as Part],
      })
      await new Promise((resolve) => setTimeout(resolve, 20))

      const asked = events.find((event) => event.type === "question.asked") as Event<"question.asked"> | undefined
      expect(asked?.properties).toMatchObject({
        id: "travel-q-1",
        sessionID,
      })

      await sdk.client.question.reply({
        requestID: "travel-q-1",
        answers: [["7天"], ["自然风光"]],
      })
      await new Promise((resolve) => setTimeout(resolve, 40))
      unsub()

      const messages = await sdk.client.session.messages({ sessionID })
      const texts = (messages.data ?? []).flatMap((entry) =>
        (entry.parts ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])),
      )

      expect(texts).toContain("帮我规划云南旅游")
      expect(texts).toContain("Q1: A 7天\nQ2: B")
      expect(texts.some((text) => text.includes("云南 7 天自然风光路线"))).toBe(true)
    } finally {
      await disposeTuiRuntimeBridge(sessionID)
      fs.rmSync(workDir, { recursive: true, force: true })
      fs.rmSync(homeDir, { recursive: true, force: true })
    }
  })
})
