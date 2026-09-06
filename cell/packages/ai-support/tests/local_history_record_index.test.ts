import { afterEach, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendXnlRecord } from "@cell/ai-file-store-logic";
import { createLocalHistoryRecordIndex, LocalHistoryIndexError } from "../src/conversation/LocalHistoryRecordIndex";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "history-record-index-"));
  directories.push(directory);
  return join(directory, "history.xnl");
}

async function append(filePath: string, sequence: number, generationId = "g1", messageId?: string) {
  await appendXnlRecord({
    filePath, tag: "HistoryMessage",
    metadata: { id: `record-${sequence}`, actorKey: "main", generationId, sequence, messageId },
    body: [{ kind: "text", tag: "content", text: `body-${sequence}` }],
  });
}

it("preserves repeated physical versions and retains only metadata and ranges", async () => {
  const filePath = await fixture();
  await append(filePath, 0, "g1", "message-0");
  await append(filePath, 0, "g2", "message-0");
  await append(filePath, 0, "g2", "message-0");
  await append(filePath, 1);
  const prepared = await createLocalHistoryRecordIndex().prepare(filePath);
  expect(prepared.entries).toHaveLength(4);
  expect(prepared.entries.map((entry) => entry.generationId)).toEqual(["g1", "g2", "g2", "g1"]);
  expect(prepared.entries.map((entry) => entry.physicalRevision)).toEqual([0, 1, 2, 3]);
  expect(prepared.entries[3]!.messageId).toBe("record-1");
  expect(prepared.entries.map((entry) => entry.hasMessageId)).toEqual([true, true, true, false]);
  expect(prepared.observedBytes).toBeGreaterThan(0);
  expect(prepared.cacheHit).toBe(false);
  expect(JSON.stringify(prepared)).not.toContain("body-");
  expect(Object.isFrozen(prepared.entries)).toBe(true);
  expect(Object.keys(prepared.entries[0]!).sort()).toEqual([
    "actorKey", "createdReason", "endOffset", "generationId", "hasMessageId", "messageId", "physicalRevision", "recordId", "sequence", "startOffset",
  ]);
  for (const entry of prepared.entries) expect(entry.endOffset).toBeGreaterThan(entry.startOffset);
});

it("coalesces concurrent preparation and invalidates on append", async () => {
  const filePath = await fixture();
  await append(filePath, 0);
  const index = createLocalHistoryRecordIndex();
  expect(await index.getPrepared(filePath)).toBeNull();
  const results = await Promise.all([index.prepare(filePath), index.prepare(filePath), index.prepare(filePath)]);
  expect(results.filter((result) => !result.cacheHit)).toHaveLength(1);
  expect(results[0]!.entries).toBe(results[1]!.entries);
  expect(results.filter((result) => result.cacheHit).every((result) => result.observedBytes === 0)).toBe(true);
  expect((await index.getPrepared(filePath))?.observedBytes).toBe(0);
  await append(filePath, 1);
  expect(await index.getPrepared(filePath)).toBeNull();
  const updated = await index.prepare(filePath);
  expect(updated.cacheHit).toBe(false);
  expect(updated.entries).toHaveLength(2);
  expect(updated.sourceSignature).not.toBe(results[0]!.sourceSignature);
});

it("retains bounded generation envelopes separately from bodies and rejects contradictory membership lineage", async () => {
  const filePath = await fixture();
  const metadata = { id: "r0", generationId: "g", actorKey: "main", actorId: "actor", sessionId: "session", predecessorGenerationIds: ["prior"] };
  await appendXnlRecord({ filePath, tag: "HistoryMessage", metadata,
    body: [{ kind: "text", tag: "Content", text: "private body" }] });
  const index = createLocalHistoryRecordIndex();
  const prepared = await index.prepare(filePath);
  expect(prepared.generations).toEqual([{ generationId: "g", actorKey: "main", actorId: "actor", sessionId: "session", predecessorGenerationIds: ["prior"] }]);
  expect(JSON.stringify(prepared)).not.toContain("private body");
  expect(Object.isFrozen(prepared.generations)).toBe(true);
  await appendXnlRecord({ filePath, tag: "HistoryMessage", metadata: { ...metadata, id: "r1", predecessorGenerationIds: ["other"] } });
  await expect(index.prepare(filePath)).rejects.toThrow("conversation_history_index_lineage_metadata_conflict");
});

it("legacy empty generation envelopes retain ancestry without creating message rows", async () => {
  const filePath = await fixture();
  await appendXnlRecord({ filePath, tag: "history-generation", metadata: { id: "empty" },
    body: [{ kind: "data", tag: "generation", attributes: {
      generationId: "empty", actorKey: "main", actorId: "actor", sessionId: "session", predecessorGenerationIds: [], messages: [],
    } }] });
  const prepared = await createLocalHistoryRecordIndex().prepare(filePath);
  expect(prepared.entries).toHaveLength(0);
  expect(prepared.generations).toEqual([{ generationId: "empty", actorKey: "main", actorId: "actor", sessionId: "session", predecessorGenerationIds: [] }]);
});

it("evicts the least recently used source and clear invalidates pending work", async () => {
  const files = await Promise.all([fixture(), fixture(), fixture()]);
  for (const filePath of files) await append(filePath, 0);
  const index = createLocalHistoryRecordIndex();
  await index.prepare(files[0]!);
  await index.prepare(files[1]!);
  await index.prepare(files[0]!);
  await index.prepare(files[2]!);
  expect((await index.prepare(files[0]!)).cacheHit).toBe(true);
  expect((await index.prepare(files[1]!)).cacheHit).toBe(false);
  index.clear();
  const pending = index.prepare(files[0]!);
  index.clear();
  await expect(pending).rejects.toThrow("conversation_history_index_preparation_invalidated");
  expect((await index.prepare(files[0]!)).cacheHit).toBe(false);
});

it("yields during multi-batch preparation and does not cache invalidated scans", async () => {
  const filePath = await fixture();
  for (let sequence = 0; sequence < 130; sequence += 1) await append(filePath, sequence);
  const index = createLocalHistoryRecordIndex();
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 0);
  try {
    const prepared = await index.prepare(filePath);
    expect(prepared.entries).toHaveLength(130);
    expect(ticks).toBeGreaterThan(0);
  } finally {
    clearInterval(timer);
  }
  index.clear();
  const pending = index.prepare(filePath);
  const clearTimer = setInterval(() => index.clear(), 0);
  try {
    await expect(pending).rejects.toThrow("conversation_history_index_preparation_invalidated");
  } finally {
    clearInterval(clearTimer);
  }
  expect(await index.getPrepared(filePath)).toBeNull();
  expect((await index.prepare(filePath)).cacheHit).toBe(false);
});

it("rejects a record beyond the bounded scan budget", async () => {
  const filePath = await fixture();
  await appendXnlRecord({
    filePath, tag: "HistoryMessage",
    metadata: { id: "large", actorKey: "main", generationId: "g1", sequence: 0 },
    body: [{ kind: "text", tag: "content", text: "x".repeat(8 * 1024 * 1024) }],
  });
  const index = createLocalHistoryRecordIndex();
  const error = await index.prepare(filePath).catch((error: unknown) => error);
  expect(error).toBeInstanceOf(LocalHistoryIndexError);
  expect((error as LocalHistoryIndexError).code).toBe("record_exceeds_budget");
  expect((error as LocalHistoryIndexError).message).toBe("conversation_history_index_record_exceeds_budget");
  expect(await index.getPrepared(filePath)).toBeNull();
});

it("bounds every retained identity before caching metadata", async () => {
  for (const field of ["id", "actorKey", "generationId", "messageId"]) {
    const filePath = await fixture();
    await appendXnlRecord({
      filePath, tag: "HistoryMessage",
      metadata: { id: "record", actorKey: "main", generationId: "g1", messageId: "message", [field]: "x".repeat(4097) },
    });
    const index = createLocalHistoryRecordIndex();
    const error = await index.prepare(filePath).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(LocalHistoryIndexError);
    expect((error as LocalHistoryIndexError).code).toBe("identity_too_large");
    expect(await index.getPrepared(filePath)).toBeNull();
  }
  const filePath = await fixture();
  await append(filePath, 0, "x".repeat(4096));
  expect((await createLocalHistoryRecordIndex().prepare(filePath)).entries[0]!.generationId).toHaveLength(4096);
});

it("evicts a deleted source and returns a cache miss", async () => {
  const filePath = await fixture();
  await append(filePath, 0);
  const index = createLocalHistoryRecordIndex();
  await index.prepare(filePath);
  await rm(filePath);
  expect(await index.getPrepared(filePath)).toBeNull();
  await append(filePath, 1);
  expect(await index.getPrepared(filePath)).toBeNull();
  expect((await index.prepare(filePath)).entries[0]!.recordId).toBe("record-1");
});
