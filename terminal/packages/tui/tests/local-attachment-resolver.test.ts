import { describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createLocalAttachmentResolver, isLocalAttachmentFile } from "../src/support/attachment-resolver"

async function withTempFile(
  name: string,
  content: string | Uint8Array,
  run: (filePath: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "eidolon-attachment-"))
  const filePath = path.join(root, name)
  try {
    await writeFile(filePath, content)
    await run(filePath)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("local TUI attachment resolver", () => {
  it("snapshots a UTF-8 text file without retaining its absolute path", async () => {
    await withTempFile("notes with spaces.md", "hello attachment", async (filePath) => {
      const resolved = await createLocalAttachmentResolver().resolve({
        type: "file_reference",
        path: filePath,
        filename: "notes with spaces.md",
        mime: "text/plain",
      })

      expect(resolved).toMatchObject({
        type: "text",
        text: "hello attachment",
        filename: "notes with spaces.md",
      })
      expect("sourceDigest" in resolved ? resolved.sourceDigest : "").toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(JSON.stringify(resolved)).not.toContain(filePath)
    })
  })

  it("sniffs PNG bytes instead of trusting the Composer MIME hint", async () => {
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("image-payload"),
    ])
    await withTempFile("dropped image.bin", png, async (filePath) => {
      const resolved = await createLocalAttachmentResolver().resolve({
        type: "file_reference",
        path: filePath,
        filename: "dropped image.bin",
        mime: "text/plain",
      })

      expect(resolved).toMatchObject({
        type: "image",
        mime: "image/png",
        filename: "dropped image.bin",
        size: png.byteLength,
      })
      expect("dataUrl" in resolved ? resolved.dataUrl : "").toBe(
        `data:image/png;base64,${png.toString("base64")}`,
      )
      expect(JSON.stringify(resolved)).not.toContain(filePath)
    })
  })

  it("fails closed for binary files and redacts the absolute path from errors", async () => {
    await withTempFile("private.bin", new Uint8Array([0x00, 0xff, 0x01]), async (filePath) => {
      let message = ""
      try {
        await createLocalAttachmentResolver().resolve({
          type: "file_reference",
          path: filePath,
          filename: "private.bin",
        })
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message).toBe("attachment_unsupported_binary:private.bin")
      expect(message).not.toContain(filePath)
    })
  })

  it("owns synchronous path classification in terminal support and enforces bounded reads", async () => {
    await withTempFile("large.txt", "0123456789", async (filePath) => {
      expect(isLocalAttachmentFile(filePath)).toBe(true)
      expect(isLocalAttachmentFile(path.dirname(filePath))).toBe(false)

      await expect(createLocalAttachmentResolver({ maxImageBytes: 4, maxTextBytes: 4 }).resolve({
        type: "file_reference",
        path: filePath,
        filename: "large.txt",
      })).rejects.toThrow("attachment_too_large:large.txt")
    })
  })

  it("is injected by both shipping TUI entry points", async () => {
    const mainSource = await Bun.file(path.resolve(import.meta.dir, "../src/entry/tui_a1-main.ts")).text()
    const threadSource = await Bun.file(path.resolve(import.meta.dir, "../src/entry/thread.ts")).text()
    expect(mainSource).toContain("attachmentResolver: createLocalAttachmentResolver()")
    expect(mainSource).toContain("isAttachmentFile: isLocalAttachmentFile")
    expect(threadSource).toContain("attachmentResolver: createLocalAttachmentResolver()")
    expect(threadSource).toContain("isAttachmentFile: isLocalAttachmentFile")
  })
})
