import { describe, expect, it } from "bun:test"
import type { PermissionRequest, Question } from "@terminal/core/AIAgent"
import {
  buildStructuredQuestionAnswers,
  formatPermissionReply,
  renderPermissionDetails,
  renderPermissionSummary,
  resolveQuestionAnswers,
  summarizePermissionHistory,
  summarizeQuestionHistory,
} from "../src/app/tui_a1/features/approval/approval-utils"

function createPermissionRequest(overrides?: Partial<PermissionRequest>): PermissionRequest {
  return {
    id: "perm_1",
    sessionID: "ses_1",
    permission: "bash",
    always: ["*"],
    metadata: {
      command: "ls -la",
      description: "inspect workspace",
    },
    ...overrides,
  }
}

describe("tui_a1 approval utils", () => {
  it("keeps unanswered question groups empty instead of auto-filling a fallback option", () => {
    const questions: Question[] = [
      {
        header: "mode",
        question: "Execution mode",
        options: [{ label: "safe" }, { label: "full" }],
      },
      {
        header: "scope",
        question: "Scope",
        options: [{ label: "repo" }, { label: "file" }],
      },
    ]

    const resolved = resolveQuestionAnswers(questions, [["safe"]])

    expect(resolved).toEqual([["safe"], []])
  })

  it("renders richer permission summary and details for bash requests", () => {
    const request = createPermissionRequest()

    expect(renderPermissionSummary(request)).toBe("ls -la")
    expect(renderPermissionDetails(request)).toEqual([
      "description: inspect workspace",
      "command: ls -la",
      "allow-once scope: *",
    ])
  })

  it("formats approval history summaries from the chosen reply", () => {
    const request = createPermissionRequest()

    expect(formatPermissionReply("once")).toBe("Allowed once")
    expect(formatPermissionReply("always")).toBe("Allowed always")
    expect(formatPermissionReply("reject")).toBe("Rejected")
    expect(summarizePermissionHistory(request, "once")).toBe("Allowed once · ls -la")
  })

  it("summarizes questionnaire answers without inventing missing selections", () => {
    const summary = summarizeQuestionHistory(
      {
        id: "q_1",
        sessionID: "ses_1",
        questions: [
          {
            header: "mode",
            question: "Execution mode",
            options: [{ label: "safe" }, { label: "full" }],
          },
          {
            header: "scope",
            question: "Scope",
            options: [{ label: "repo" }, { label: "file" }],
          },
        ],
      },
      [["safe"], []],
    )

    expect(summary).toBe("Answered 1/2 · mode: safe · scope: (no answer)")
    expect(
      summarizeQuestionHistory(
        {
          id: "q_2",
          sessionID: "ses_1",
          questions: [
            {
              header: "mode",
              question: "Execution mode",
              options: [{ label: "safe" }],
            },
          ],
        },
        [],
        true,
      ),
    ).toBe("Rejected · Execution mode")
  })

  it("builds structured questionnaire answers keyed by question id or header", () => {
    expect(
      buildStructuredQuestionAnswers(
        {
          id: "q_3",
          sessionID: "ses_1",
          questions: [
            {
              id: "timing",
              header: "Q1",
              question: "When",
              options: [{ label: "Soon" }],
            } as Question,
            {
              header: "Q2",
              question: "What style",
              options: [{ label: "Nature" }],
              multiple: true,
            },
          ],
        },
        [["7 days"], ["Nature", "Food"]],
      ),
    ).toEqual({
      timing: "7 days",
      Q2: ["Nature", "Food"],
    })
  })

  it("derives external directory detail from patterns when metadata is absent", () => {
    const request = createPermissionRequest({
      permission: "external_directory",
      patterns: ["/tmp/workspace/*"],
      metadata: {},
    })

    expect(renderPermissionDetails(request)).toContain("directory: /tmp/workspace")
  })
})
