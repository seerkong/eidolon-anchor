import { describe, expect, it } from "bun:test"
import * as extmarkModel from "../src/app/tui_a1/features/composer/model/extmarks"
import * as promptPartsModel from "../src/app/tui_a1/features/composer/model/prompt-parts"
import { movePromptHistoryCursor } from "../src/app/tui_a1/features/composer/model/prompt-history"
import type { PromptInfo } from "../src/app/tui_a1/features/composer/model/prompt-info"

type AttachmentEdit = {
  key: "backspace" | "delete"
  cursorOffset: number
  selection?: { start: number; end: number }
}

type AtomicAttachmentDeletion = (prompt: PromptInfo, edit: AttachmentEdit) => {
  prompt: PromptInfo
  deletedPartIndexes: number[]
}

type CanonicalPromptPartCount = (prompt: PromptInfo) => number

function atomicAttachmentDeletion(): AtomicAttachmentDeletion {
  const helper = (extmarkModel as Record<string, unknown>).deleteAttachmentBlocksFromPrompt
  expect(helper, "extmark model must export deleteAttachmentBlocksFromPrompt").toBeFunction()
  return helper as AtomicAttachmentDeletion
}

function canonicalPromptPartCount(): CanonicalPromptPartCount {
  const helper = (promptPartsModel as Record<string, unknown>).countCanonicalPromptParts
  expect(helper, "prompt parts model must export countCanonicalPromptParts").toBeFunction()
  return helper as CanonicalPromptPartCount
}

function filePart(input: string, virtualText: string, path: string): PromptInfo["parts"][number] {
  const start = input.indexOf(virtualText)
  if (start < 0) throw new Error(`fixture is missing ${virtualText}`)
  return {
    type: "file",
    mime: path.endsWith(".png") ? "image/png" : "text/plain",
    filename: virtualText.slice(4),
    source: {
      type: "file",
      path,
      text: {
        start,
        end: start + virtualText.length,
        value: virtualText,
      },
    },
  }
}

function attachmentPrompt(): PromptInfo {
  const input = "left @fs:first.png middle @fs:second.md right"
  return {
    input,
    parts: [
      filePart(input, "@fs:first.png", "/tmp/first.png"),
      filePart(input, "@fs:second.md", "/tmp/second.md"),
    ],
  }
}

function rangeOf(prompt: PromptInfo, index: number): { start: number; end: number } {
  const part = prompt.parts[index]
  if (!part || part.type !== "file" || !part.source?.text) throw new Error(`missing file part ${index}`)
  return part.source.text
}

describe("tui_a1 composer atomic attachment editing", () => {
  it("Backspace at an attachment block tail removes the whole block and preserves its neighbors", () => {
    const original = attachmentPrompt()
    const firstRange = rangeOf(original, 0)
    const result = atomicAttachmentDeletion()(original, {
      key: "backspace",
      cursorOffset: firstRange.end,
    })

    expect(result.deletedPartIndexes).toEqual([0])
    expect(result.prompt.input).toBe("left  middle @fs:second.md right")
    expect(result.prompt.input).not.toContain("first.png")
    expect(result.prompt.parts).toHaveLength(1)
    expect(result.prompt.parts[0]).toMatchObject({ type: "file", filename: "second.md" })
    expect(rangeOf(result.prompt, 0).start).toBe(result.prompt.input.indexOf("@fs:second.md"))
    expect(original.parts).toHaveLength(2)
  })

  it("Delete at an attachment block head removes the whole block", () => {
    const original = attachmentPrompt()
    const secondRange = rangeOf(original, 1)
    const result = atomicAttachmentDeletion()(original, {
      key: "delete",
      cursorOffset: secondRange.start,
    })

    expect(result.deletedPartIndexes).toEqual([1])
    expect(result.prompt.input).toBe("left @fs:first.png middle  right")
    expect(result.prompt.input).not.toContain("second.md")
    expect(result.prompt.parts).toHaveLength(1)
  })

  it("deleting a selection that intersects an attachment expands to the complete block", () => {
    const original = attachmentPrompt()
    const firstRange = rangeOf(original, 0)
    const result = atomicAttachmentDeletion()(original, {
      key: "delete",
      cursorOffset: firstRange.start + 3,
      selection: {
        start: firstRange.start + 3,
        end: firstRange.end - 2,
      },
    })

    expect(result.deletedPartIndexes).toEqual([0])
    expect(result.prompt.input).not.toContain("@fs:first.png")
    expect(result.prompt.input).toContain("@fs:second.md")
    expect(result.prompt.parts.map((part) => part.type === "file" && part.filename)).toEqual(["second.md"])
  })

  it("deleting a selection spanning multiple attachments removes every covered block without orphan parts", () => {
    const original = attachmentPrompt()
    const firstRange = rangeOf(original, 0)
    const secondRange = rangeOf(original, 1)
    const result = atomicAttachmentDeletion()(original, {
      key: "delete",
      cursorOffset: firstRange.start,
      selection: {
        start: firstRange.start,
        end: secondRange.end,
      },
    })

    expect(result.deletedPartIndexes).toEqual([0, 1])
    expect(result.prompt.input).toBe("left  right")
    expect(result.prompt.parts).toEqual([])
  })

  it("derives the visible parts count from canonical parts immediately after deletion", () => {
    const original = attachmentPrompt()
    expect(canonicalPromptPartCount()(original)).toBe(2)

    const result = atomicAttachmentDeletion()(original, {
      key: "backspace",
      cursorOffset: rangeOf(original, 1).end,
    })

    expect(canonicalPromptPartCount()(result.prompt)).toBe(1)
  })

  it("restores attachment parts from history before an atomic edit and leaves history immutable", () => {
    const historicalPrompt = attachmentPrompt()
    const state = {
      index: 0,
      draft: undefined,
      history: [historicalPrompt],
    }
    const restored = movePromptHistoryCursor(state, -1, { input: "draft", parts: [] })

    expect(restored.prompt).toEqual(historicalPrompt)
    expect(restored.prompt).not.toBe(historicalPrompt)
    expect(canonicalPromptPartCount()(restored.prompt!)).toBe(2)

    const edited = atomicAttachmentDeletion()(restored.prompt!, {
      key: "delete",
      cursorOffset: rangeOf(restored.prompt!, 0).start,
    })

    expect(canonicalPromptPartCount()(edited.prompt)).toBe(1)
    expect(state.history[0].parts).toHaveLength(2)
  })
})
