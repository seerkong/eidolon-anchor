import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ActorHistoryGenerationData } from "@cell/ai-organ-contract";
import type { InputContentPart } from "@shared/composer";
import {
  hydrateStructuredContent,
  LocalFileConversationPersistenceRepositoryFactory,
} from "../src/conversation/local/LocalFileConversationPersistenceRepository";

const IMAGE_BYTES = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const IMAGE_BASE64 = IMAGE_BYTES.toString("base64");
const TEXT_BODY = "TOP_SECRET_ATTACHMENT_BODY\nsecond line\n";
const ABSOLUTE_SOURCE_PATH = "C:\\Users\\alice\\private\\attachment.txt";

function makeGeneration(sessionId: string): ActorHistoryGenerationData {
  const safeContent: InputContentPart[] = [
    { type: "text", text: "inspect these attachments: " },
    {
      type: "text",
      text: TEXT_BODY,
      filename: "attachment.txt",
      sourceDigest: "sha256:text-attachment-digest",
    },
    {
      type: "image",
      mime: "image/png",
      dataUrl: `data:image/png;base64,${IMAGE_BASE64}`,
      filename: "diagram.png",
      sourceDigest: "sha256:image-attachment-digest",
      size: IMAGE_BYTES.byteLength,
    },
  ];
  const contentWithUnsafeLocalMetadata = safeContent.map((part, index) =>
    index === 0 ? part : ({ ...part, source: { path: ABSOLUTE_SOURCE_PATH } } as InputContentPart),
  );

  return {
    version: 3,
    generationId: "main__asset_test",
    sessionId,
    actorKey: "main",
    actorId: "actor-main",
    parentGenerationId: null,
    predecessorGenerationIds: [],
    createdReason: "append",
    sealed: false,
    messageCount: 1,
    messages: [{
      recordId: "main__asset_test::0",
      actorKey: "main",
      actorId: "actor-main",
      committedAt: 1,
      message: { role: "user", content: contentWithUnsafeLocalMetadata },
    }],
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z",
  };
}

function walkFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    return entry.isDirectory() ? walkFiles(absolute) : [absolute];
  });
}

function findAssetFile(sessionDir: string, expectedBytes: Buffer): string {
  const match = walkFiles(sessionDir).find((candidate) => {
    if (/\.(xnl|json)$/i.test(candidate)) return false;
    return fs.readFileSync(candidate).equals(expectedBytes);
  });
  if (!match) throw new Error(`expected content-addressed attachment asset for ${expectedBytes.byteLength} bytes`);
  return match;
}

async function writeFixture(sessionDir: string) {
  const repository = LocalFileConversationPersistenceRepositoryFactory.createRepository(sessionDir);
  const generation = makeGeneration(path.basename(sessionDir));
  await repository.writeHistoryGeneration(generation);
  return { repository, generation };
}

describe("attachment asset persistence", () => {
  it("keeps legacy inline text and image snapshots readable without retaining unsafe source metadata", async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-legacy-inline-assets-"));
    try {
      await expect(hydrateStructuredContent(sessionDir, [
        {
          type: "text",
          text: TEXT_BODY,
          filename: "attachment.txt",
          sourceDigest: "sha256:legacy-text",
          source: { path: ABSOLUTE_SOURCE_PATH },
        },
        {
          type: "image",
          mime: "image/png",
          dataUrl: `data:image/png;base64,${IMAGE_BASE64}`,
          filename: "diagram.png",
          sourceDigest: "sha256:legacy-image",
          size: IMAGE_BYTES.byteLength,
          source: { path: ABSOLUTE_SOURCE_PATH },
        },
      ])).resolves.toEqual([
        {
          type: "text",
          text: TEXT_BODY,
          filename: "attachment.txt",
          sourceDigest: "sha256:legacy-text",
        },
        {
          type: "image",
          mime: "image/png",
          dataUrl: `data:image/png;base64,${IMAGE_BASE64}`,
          filename: "diagram.png",
          sourceDigest: "sha256:legacy-image",
          size: IMAGE_BYTES.byteLength,
        },
      ]);
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("externalizes image and attachment text while history round-trips through asset references", async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-attachment-assets-"));
    try {
      const { repository, generation } = await writeFixture(sessionDir);
      const raw = fs.readFileSync(path.join(sessionDir, "conversation", "history.xnl"), "utf8");

      expect(raw).toMatch(/asset[_-]?id/i);
      expect(raw).toContain("sha256:text-attachment-digest");
      expect(raw).toContain("sha256:image-attachment-digest");
      expect(raw).not.toContain(TEXT_BODY.trim());
      expect(raw).not.toContain(IMAGE_BASE64);
      expect(raw).not.toContain("data:image/png;base64");
      expect(raw).not.toContain(ABSOLUTE_SOURCE_PATH);

      findAssetFile(sessionDir, Buffer.from(TEXT_BODY, "utf8"));
      findAssetFile(sessionDir, IMAGE_BYTES);

      const recovered = await repository.loadHistoryGeneration(generation.generationId);
      expect(recovered?.messages[0]?.message.content).toEqual([
        { type: "text", text: "inspect these attachments: " },
        {
          type: "text",
          text: TEXT_BODY,
          filename: "attachment.txt",
          sourceDigest: "sha256:text-attachment-digest",
        },
        {
          type: "image",
          mime: "image/png",
          dataUrl: `data:image/png;base64,${IMAGE_BASE64}`,
          filename: "diagram.png",
          sourceDigest: "sha256:image-attachment-digest",
          size: IMAGE_BYTES.byteLength,
        },
      ]);
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("fails closed when a referenced attachment asset is missing", async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-missing-asset-"));
    try {
      const { repository, generation } = await writeFixture(sessionDir);
      fs.rmSync(findAssetFile(sessionDir, IMAGE_BYTES));

      await expect(repository.loadHistoryGeneration(generation.generationId))
        .rejects.toThrow(/asset|integrity|missing|digest/i);
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it("fails closed when a referenced attachment asset has corrupt bytes", async () => {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-corrupt-asset-"));
    try {
      const { repository, generation } = await writeFixture(sessionDir);
      fs.writeFileSync(findAssetFile(sessionDir, Buffer.from(TEXT_BODY, "utf8")), "corrupt");

      await expect(repository.loadHistoryGeneration(generation.generationId))
        .rejects.toThrow(/asset|integrity|corrupt|digest/i);
    } finally {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });
});
