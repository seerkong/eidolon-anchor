import { describe, expect, it } from "bun:test"
import { resolve } from "node:path"

describe("canonical structured input public contract", () => {
  it("exports canonical normalization and text projection helpers", async () => {
    const composer = await import("@shared/composer") as Record<string, unknown>

    expect(composer).toHaveProperty("normalizeInputContent")
    expect(composer).toHaveProperty("projectInputContentText")
  })

  it("exports the injected AttachmentResolverPort contract owner", async () => {
    const contracts = await import("@cell/ai-core-contract") as Record<string, unknown>

    expect(contracts).toHaveProperty("AttachmentResolverPort")
  })

  it("allows persisted ChatMessage content to recover canonical parts as well as legacy strings", async () => {
    const dtoSource = await Bun.file(
      resolve(import.meta.dir, "../../../../shared/packages/composer/src/modules/LLM/DTO.ts"),
    ).text()

    expect(dtoSource).toContain("content: string | InputContentPart[];")
  })
})
