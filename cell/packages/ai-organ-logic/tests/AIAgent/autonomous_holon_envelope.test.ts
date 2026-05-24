import { describe, expect, it } from "bun:test"

import { buildAutonomousHolonEnvelope, parseAutonomousHolonEnvelope } from "@cell/ai-organ-logic/organization/autonomousHolonEnvelope"

describe("autonomous holon envelope", () => {
  it("uses the holon-first protocol tag and holonId payload field", () => {
    const text = buildAutonomousHolonEnvelope({
      kind: "member_task",
      taskId: "task-1",
      holonId: "holon-1",
      replyMode: "final",
    }, "TASK_ID=task-1\nDo the work")

    expect(text.startsWith("<autonomous_holon_task>")).toBe(true)
    expect(text.includes("<collective_task>")).toBe(false)

    const parsed = parseAutonomousHolonEnvelope(text)
    expect(parsed).not.toBeNull()
    expect(parsed?.payload).toEqual({
      kind: "member_task",
      taskId: "task-1",
      holonId: "holon-1",
      replyMode: "final",
    })
    expect(parsed?.bodyText).toBe("TASK_ID=task-1\nDo the work")
  })
})
