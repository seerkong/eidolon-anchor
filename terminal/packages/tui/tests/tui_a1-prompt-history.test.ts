import { describe, expect, it } from "bun:test"
import {
  appendPromptHistoryEntry,
  movePromptHistoryCursor,
} from "../src/app/tui_a1/features/composer/model/prompt-history"

describe("tui_a1 prompt history", () => {
  it("captures the current draft before entering history and restores it when moving forward", () => {
    const draft = {
      input: "review @planner",
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
      ],
    }
    const state = {
      index: 0,
      draft: undefined,
      history: [
        { input: "older prompt", parts: [] },
        { input: "latest prompt", parts: [] },
      ],
    }

    const firstMove = movePromptHistoryCursor(state, -1, draft)
    expect(firstMove.prompt).toEqual({
      input: "latest prompt",
      parts: [],
    })
    expect(firstMove.nextState.draft).toEqual(draft)
    expect(firstMove.nextState.index).toBe(-1)

    const secondMove = movePromptHistoryCursor(
      firstMove.nextState,
      1,
      firstMove.prompt ?? { input: "", parts: [] },
    )
    expect(secondMove.prompt).toEqual(draft)
    expect(secondMove.nextState.index).toBe(0)
  })

  it("does not traverse beyond the oldest history entry", () => {
    const state = {
      index: -2,
      draft: { input: "draft", parts: [] },
      history: [
        { input: "older prompt", parts: [] },
        { input: "latest prompt", parts: [] },
      ],
    }

    const result = movePromptHistoryCursor(state, -1, {
      input: "older prompt",
      parts: [],
    })

    expect(result.nextState).toEqual(state)
    expect(result.prompt).toBeUndefined()
  })

  it("allows a new history traversal after submit resets the live position", () => {
    const submitted = {
      input: "latest prompt",
      parts: [],
    }
    const emptiedComposer = {
      input: "",
      parts: [],
    }
    const stateBeforeAppend = {
      index: 0,
      draft: {
        input: "stale draft",
        parts: [],
      },
      history: [
        { input: "older prompt", parts: [] },
      ],
    }
    const { nextState: stateAfterAppend } = appendPromptHistoryEntry(stateBeforeAppend, submitted)

    const result = movePromptHistoryCursor(stateAfterAppend, -1, emptiedComposer)

    expect(stateAfterAppend.draft).toBeUndefined()
    expect(result.nextState.index).toBe(-1)
    expect(result.nextState.draft).toEqual(emptiedComposer)
    expect(result.prompt).toEqual(submitted)
  })
})
