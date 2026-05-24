import { describe, expect, it } from "bun:test"
import {
  buildRuntimePromptParts,
  normalizePromptInfoForSubmit,
} from "../src/app/tui_a1/features/composer/model/prompt-parts"
import { buildPromptInfoFromParts } from "../src/app/tui_a1/features/message/model/session-helpers"

describe("tui_a1 prompt parts", () => {
  it("builds runtime parts by replacing structured placeholders with their real parts", () => {
    const prompt = {
      input: "Review @planner src/app.ts please",
      parts: [
        {
          type: "agent" as const,
          name: "planner",
          source: {
            start: 7,
            end: 15,
            value: "@planner",
          },
        },
        {
          type: "file" as const,
          mime: "text/plain",
          filename: "src/app.ts",
          source: {
            type: "file",
            path: "/tmp/project/src/app.ts",
            text: {
              start: 16,
              end: 26,
              value: "src/app.ts",
            },
          },
        },
      ],
    }

    const parts = buildRuntimePromptParts({
      prompt,
      sessionID: "ses_1",
      messageID: "msg_1",
    })

    expect(parts.map((part) => part.type)).toEqual(["text", "agent", "text", "file", "text"])
    expect(parts[0]).toMatchObject({ type: "text", text: "Review " })
    expect(parts[1]).toMatchObject({ type: "agent", name: "planner" })
    expect(parts[2]).toMatchObject({ type: "text", text: " " })
    expect(parts[3]).toMatchObject({
      type: "file",
      filename: "src/app.ts",
      source: {
        path: "/tmp/project/src/app.ts",
      },
    })
    expect(parts[4]).toMatchObject({ type: "text", text: " please" })
  })

  it("rebuilds prompt info from structured runtime parts", () => {
    const prompt = buildPromptInfoFromParts([
      {
        id: "part_1",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "text",
        text: "Summarize ",
        synthetic: false,
        ignored: false,
      },
      {
        id: "part_2",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "agent",
        name: "reviewer",
        source: {
          start: 10,
          end: 19,
          value: "@reviewer",
        },
      },
      {
        id: "part_3",
        sessionID: "ses_1",
        messageID: "msg_1",
        type: "file",
        mime: "text/plain",
        filename: "notes.md",
        source: {
          path: "/tmp/notes.md",
          text: {
            start: 20,
            end: 28,
            value: "notes.md",
          },
        },
      },
    ])

    expect(prompt.input).toBe("Summarize ")
    expect(prompt.parts).toHaveLength(2)
    expect(prompt.parts[0]).toMatchObject({ type: "agent", name: "reviewer" })
    expect(prompt.parts[1]).toMatchObject({ type: "file", filename: "notes.md" })
  })

  it("promotes typed agent mentions into structured prompt parts on submit", () => {
    const prompt = normalizePromptInfoForSubmit(
      {
        input: "Review @planner src/app.ts",
        parts: [
          {
            type: "file",
            mime: "text/plain",
            filename: "src/app.ts",
            source: {
              type: "file",
              path: "/tmp/project/src/app.ts",
              text: {
                start: 16,
                end: 26,
                value: "src/app.ts",
              },
            },
          },
        ],
      },
      ["planner", "reviewer"],
    )

    expect(prompt.parts).toHaveLength(2)
    expect(prompt.parts[0]).toMatchObject({
      type: "agent",
      name: "planner",
      source: {
        start: 7,
        end: 15,
        value: "@planner",
      },
    })
    expect(prompt.parts[1]).toMatchObject({
      type: "file",
      filename: "src/app.ts",
    })
  })

  it("keeps direct slash input in the structured pipeline without splitting command text", () => {
    const prompt = normalizePromptInfoForSubmit(
      {
        input: "  /actor create reviewer  ",
        parts: [],
      },
      ["reviewer"],
    )

    expect(prompt.parts).toEqual([
      {
        type: "text",
        text: "/actor create reviewer",
        source: {
          text: {
            start: 2,
            end: 24,
            value: "/actor create reviewer",
          },
        },
      },
    ])
  })
})
