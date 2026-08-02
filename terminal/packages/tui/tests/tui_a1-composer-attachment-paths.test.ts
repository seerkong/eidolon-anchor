import { describe, expect, it } from "bun:test"
import * as pasteModel from "../src/app/tui_a1/features/composer/model/paste"

type ParseAttachmentPathPaste = (
  payload: string,
  options: {
    platform: "win32" | "posix"
    isFile: (candidate: string) => boolean
  },
) => string[] | null

function attachmentPathParser(): ParseAttachmentPathPaste {
  const parser = (pasteModel as Record<string, unknown>).parseAttachmentPathPaste
  expect(parser, "paste model must export parseAttachmentPathPaste").toBeFunction()
  return parser as ParseAttachmentPathPaste
}

function parseExisting(payload: string, platform: "win32" | "posix", existing: string[]): string[] | null {
  return attachmentPathParser()(payload, {
    platform,
    isFile: (candidate) => existing.includes(candidate),
  })
}

describe("tui_a1 composer attachment path paste", () => {
  it("recognizes a Windows drive path", () => {
    const candidate = String.raw`C:\Users\Ada\diagram.png`

    expect(parseExisting(candidate, "win32", [candidate])).toEqual([candidate])
  })

  it("removes terminal quotes around Windows drive and UNC paths containing spaces", () => {
    const drivePath = String.raw`C:\Users\Ada Lovelace\diagram one.png`
    const uncPath = String.raw`\\server\shared files\team notes.md`
    const payload = `"${drivePath}" "${uncPath}"`

    expect(parseExisting(payload, "win32", [drivePath, uncPath])).toEqual([drivePath, uncPath])
  })

  it("recognizes POSIX paths and decodes file URIs without accessing the filesystem itself", () => {
    const posixPath = "/tmp/project/report.pdf"
    const uriPath = "/tmp/project/meeting notes.md"

    expect(parseExisting(posixPath, "posix", [posixPath])).toEqual([posixPath])
    expect(parseExisting("file:///tmp/project/meeting%20notes.md", "posix", [uriPath])).toEqual([uriPath])
  })

  it("normalizes a Windows file URI", () => {
    const windowsPath = String.raw`C:\Users\Ada Lovelace\diagram.png`

    expect(
      parseExisting("file:///C:/Users/Ada%20Lovelace/diagram.png", "win32", [windowsPath]),
    ).toEqual([windowsPath])
  })

  it("recognizes multiple newline-delimited files as one all-or-nothing attachment paste", () => {
    const first = "/tmp/one.md"
    const second = "/tmp/two.png"

    expect(parseExisting(`${first}\n${second}`, "posix", [first, second])).toEqual([first, second])
  })

  it("falls back to ordinary text when any token is not an existing file", () => {
    const payload = "Please review /tmp/real.md before lunch"
    const visited: string[] = []
    const result = attachmentPathParser()(payload, {
      platform: "posix",
      isFile(candidate) {
        visited.push(candidate)
        return candidate === "/tmp/real.md"
      },
    })

    expect(result).toBeNull()
    expect(payload).toBe("Please review /tmp/real.md before lunch")
  })

  it("falls back atomically when a multi-file paste contains one missing path", () => {
    const first = "/tmp/exists.md"
    const missing = "/tmp/missing.png"

    expect(parseExisting(`${first}\n${missing}`, "posix", [first])).toBeNull()
  })
})
