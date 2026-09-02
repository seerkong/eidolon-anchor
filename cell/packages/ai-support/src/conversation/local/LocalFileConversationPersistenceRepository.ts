import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  unlink,
} from "node:fs/promises";

import type {
  ActorHistoryGenerationData,
  ActorPromptGenerationData,
  ConversationArtifactRefsSnapshot,
  ConversationForkAuthoritySnapshot,
  ConversationForkInitializationGeneration,
  ConversationForkInitializationHead,
  ConversationHistoryIndexSnapshot,
  ConversationProviderContextTransitionGeneration,
  ConversationProviderContextTransitionHead,
  ConversationPersistenceRepository,
  ConversationPersistenceRepositoryFactory,
  ConversationPromptIndexSnapshot,
  ConversationSessionIndexSnapshot,
} from "@cell/ai-organ-contract";
import { CONVERSATION_PERSISTENCE_SCHEMA_VERSION } from "@cell/ai-organ-contract";
import {
  appendXnlRecord,
  readSessionAttachmentAsset,
  readXnlRecords,
  writeSessionAttachmentAsset,
  type XnlAppendDataRecordBody,
  type XnlDataRecordBodyItem,
  type XnlRecordBodyItem,
} from "@cell/ai-file-store-logic";
import type { InputContentPart } from "@shared/composer";
import {
  getLocalConversationPaths,
} from "./LocalConversationPaths";
import { readJsonBestEffort, writeJsonAtomically } from "./LocalConversationJson";

const HISTORY_GENERATION_RECORD_TAG = "history-generation";
const HISTORY_GENERATION_BODY_TAG = "generation";
const HISTORY_MESSAGE_RECORD_TAG = "HistoryMessage";
const PROMPT_GENERATION_RECORD_TAG = "PromptGeneration";
const LEGACY_PROMPT_GENERATION_RECORD_TAG = "prompt-generation";
const LEGACY_PROMPT_GENERATION_BODY_TAG = "generation";

type XnlConversationRecord = Awaited<ReturnType<typeof readXnlRecords>>[number];
type PromptBasisRef = NonNullable<ActorPromptGenerationData["basis"]["basisRefs"]>[number];

function isXnlDataRecordBodyItemWithTag(tag: string): (item: XnlRecordBodyItem) => item is XnlDataRecordBodyItem {
  return (item): item is XnlDataRecordBodyItem => item.kind === "data" && item.tag === tag;
}

const QUOTED_XNL_FIELD = /([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"/g;
const conversationXnlWriteQueues = new Map<string, Promise<unknown>>();
const providerContextTransitionQueues = new Map<string, Promise<unknown>>();
const conversationForkInitializationQueues = new Map<string, Promise<unknown>>();
const conversationAuthorityLeaseQueues = new Map<string, Promise<unknown>>();
const conversationAuthorityLeaseScope = new AsyncLocalStorage<ReadonlySet<string>>();

async function withProviderContextTransitionLock<T>(sessionDir: string, task: () => Promise<T>): Promise<T> {
  const previous = providerContextTransitionQueues.get(sessionDir) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  providerContextTransitionQueues.set(sessionDir, current);
  try {
    return await current;
  } finally {
    if (providerContextTransitionQueues.get(sessionDir) === current) {
      providerContextTransitionQueues.delete(sessionDir);
    }
  }
}

async function withConversationForkInitializationLock<T>(sessionDir: string, task: () => Promise<T>): Promise<T> {
  const previous = conversationForkInitializationQueues.get(sessionDir) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  conversationForkInitializationQueues.set(sessionDir, current);
  try {
    return await current;
  } finally {
    if (conversationForkInitializationQueues.get(sessionDir) === current) {
      conversationForkInitializationQueues.delete(sessionDir);
    }
  }
}

export type LocalProviderContextTransitionFaultPoint =
  | "after-stage-create"
  | "after-stage-write"
  | "after-stage-fsync"
  | "after-stage-publish"
  | "before-head-cas"
  | "after-head-cas";

export type LocalConversationForkInitializationFaultPoint =
  | "after-stage-create"
  | "after-stage-write"
  | "after-stage-fsync"
  | "after-stage-publish"
  | "after-claim-cas"
  | "after-journal-publish"
  | "before-authority-publish"
  | "after-authority-publish"
  | "after-head-cas";

export type LocalFileConversationPersistenceRepositoryOptions = Readonly<{
  providerContextTransitionFault?: (point: LocalProviderContextTransitionFaultPoint) => void;
  conversationForkInitializationFault?: (point: LocalConversationForkInitializationFaultPoint) => void;
}>;

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort(codeUnitCompare).map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  )).join(",")}}`;
}

export function digestConversationProviderContextTransitionGeneration(
  transition: Omit<ConversationProviderContextTransitionGeneration, "transitionId">,
): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(transition), "utf8").digest("hex")}`;
}

export function digestConversationForkInitializationGeneration(
  generation: Omit<ConversationForkInitializationGeneration, "transactionId">,
): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(generation), "utf8").digest("hex")}`;
}

function digestConversationForkTargetAuthority(
  generation: ConversationForkInitializationGeneration,
): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson({
    historyIndex: generation.historyIndex,
    promptIndex: generation.promptIndex,
    sessionIndex: generation.sessionIndex,
    artifactRefs: generation.artifactRefs,
    historyGenerations: generation.historyGenerations,
    promptGenerations: generation.promptGenerations,
    childProviderEpochReceipt: generation.childProviderEpochReceipt,
  }), "utf8").digest("hex")}`;
}

function digestConversationForkAuthoritySnapshot(
  snapshot: ConversationForkAuthoritySnapshot,
): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(JSON.parse(JSON.stringify(snapshot))), "utf8").digest("hex")}`;
}

function providerTransitionPaths(sessionDir: string) {
  const root = path.join(getLocalConversationPaths(sessionDir).rootDir, "provider-context-transitions");
  return {
    root,
    generations: path.join(root, "generations"),
    journal: path.join(root, "journal.json"),
    head: path.join(root, "head.json"),
  };
}

function forkInitializationPaths(sessionDir: string) {
  const root = path.join(getLocalConversationPaths(sessionDir).rootDir, "fork-initializations");
  return {
    root,
    generations: path.join(root, "generations"),
    claim: path.join(root, "claim.json"),
    journal: path.join(root, "journal.json"),
    head: path.join(root, "head.json"),
  };
}

function contextAssetActorKey(asset: import("@cell/ai-organ-contract").LocalConversationContextAssetData): string | null {
  const explicit = asset.providerContextFact?.actorKey
    ?? asset.providerContextFactCandidate?.actorKey
    ?? asset.projectionFact?.actorKey
    ?? asset.toolResultDeliveryFact?.actorKey
    ?? asset.messageDeliveryFact?.actorKey;
  if (explicit) return explicit;
  if (asset.replayCheckpoint && asset.source.kind === "note") {
    return asset.source.ownerId ?? null;
  }
  return null;
}

function mergeActorScopedTransitionSnapshots(params: {
  actorKey: string;
  transition: ConversationProviderContextTransitionGeneration;
  currentHistory: ConversationHistoryIndexSnapshot;
  currentPrompt: ConversationPromptIndexSnapshot;
  currentSession: ConversationSessionIndexSnapshot;
  currentArtifacts: ConversationArtifactRefsSnapshot;
}) {
  const { actorKey, transition } = params;
  const targetHistoryEntries = Object.fromEntries(Object.entries(transition.historyIndex.generations)
    .filter(([, entry]) => entry.actorKey === actorKey));
  const targetLineages = Object.fromEntries(Object.entries(transition.historyIndex.lineages)
    .filter(([, entry]) => entry.actorKey === actorKey));
  const targetPromptEntries = Object.fromEntries(Object.entries(transition.promptIndex.generations)
    .filter(([, entry]) => entry.actorKey === actorKey));
  const nextAssets = [
    ...(params.currentSession.session.contextAssets ?? []).filter((asset) => contextAssetActorKey(asset) !== actorKey),
    ...(transition.sessionIndex.session.contextAssets ?? []).filter((asset) => contextAssetActorKey(asset) === actorKey),
  ];
  const touchedOwners = new Set([actorKey, ...Object.keys(targetHistoryEntries), ...Object.keys(targetPromptEntries)]);
  const nextHistoryHead = transition.historyIndex.heads[actorKey];
  const nextPromptHead = transition.promptIndex.heads[actorKey];
  return {
    historyIndex: {
      ...params.currentHistory,
      heads: nextHistoryHead
        ? { ...params.currentHistory.heads, [actorKey]: nextHistoryHead }
        : Object.fromEntries(Object.entries(params.currentHistory.heads).filter(([key]) => key !== actorKey)),
      lineages: {
        ...Object.fromEntries(Object.entries(params.currentHistory.lineages).filter(([, entry]) => entry.actorKey !== actorKey)),
        ...targetLineages,
      },
      generations: {
        ...Object.fromEntries(Object.entries(params.currentHistory.generations).filter(([, entry]) => entry.actorKey !== actorKey)),
        ...targetHistoryEntries,
      },
      updatedAt: transition.historyIndex.updatedAt,
    },
    promptIndex: {
      ...params.currentPrompt,
      heads: nextPromptHead
        ? { ...params.currentPrompt.heads, [actorKey]: nextPromptHead }
        : Object.fromEntries(Object.entries(params.currentPrompt.heads).filter(([key]) => key !== actorKey)),
      generations: {
        ...Object.fromEntries(Object.entries(params.currentPrompt.generations).filter(([, entry]) => entry.actorKey !== actorKey)),
        ...targetPromptEntries,
      },
      updatedAt: transition.promptIndex.updatedAt,
    },
    sessionIndex: {
      ...params.currentSession,
      session: {
        ...params.currentSession.session,
        actorBindings: {
          ...params.currentSession.session.actorBindings,
          [actorKey]: transition.sessionIndex.session.actorBindings[actorKey]!,
        },
        contextAssets: nextAssets,
        contextAssetRegistry: {
          version: params.currentSession.version,
          assetIds: nextAssets.map((asset) => asset.assetId),
          updatedAt: transition.createdAt,
        },
        updatedAt: transition.sessionIndex.session.updatedAt,
      },
      updatedAt: transition.sessionIndex.updatedAt,
    },
    artifactRefs: {
      ...params.currentArtifacts,
      refs: [
        ...params.currentArtifacts.refs.filter((ref) => !touchedOwners.has(ref.ownerId)),
        ...transition.artifactRefs.refs.filter((ref) => touchedOwners.has(ref.ownerId)),
      ],
      updatedAt: transition.artifactRefs.updatedAt,
    },
  };
}

async function assertRealDirectoryOrMissing(directoryPath: string): Promise<void> {
  try {
    const stat = await lstat(directoryPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`provider_context_transition_symlink_or_non_directory:${directoryPath}`);
    }
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function fsyncDirectory(directoryPath: string): Promise<void> {
  const handle = await open(directoryPath, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensureDurableDirectory(directoryPath: string): Promise<void> {
  await assertRealDirectoryOrMissing(directoryPath);
  const parent = path.dirname(directoryPath);
  await mkdir(directoryPath, { recursive: true });
  await assertRealDirectoryOrMissing(directoryPath);
  await fsyncDirectory(parent);
}

async function writeDurableReplace(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  await ensureDurableDirectory(directory);
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const handle = await open(tempPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, filePath);
  await fsyncDirectory(directory);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

async function acquireConversationAuthorityFileLease(sessionDir: string): Promise<() => Promise<void>> {
  // Locks live beside session directories rather than inside the target
  // Conversation directory. Fork can therefore acquire source+target in a
  // stable global order without making an uncommitted child visible.
  const rootDir = path.join(path.dirname(sessionDir), ".conversation-authority-locks");
  const lockName = createHash("sha256").update(path.resolve(sessionDir)).digest("hex");
  const lockPath = path.join(rootDir, `${lockName}.lock`);
  await ensureDurableDirectory(rootDir);
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const token = randomUUID();
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ token, pid: process.pid, acquiredAt: new Date().toISOString() })}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fsyncDirectory(rootDir);
      return async () => {
        try {
          const owner = await readJsonExact<{ token?: string }>(lockPath);
          if (owner.token === token) await unlink(lockPath);
        } catch (error: any) {
          if (error?.code !== "ENOENT") throw error;
        }
        await fsyncDirectory(rootDir);
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const observed = await lstat(lockPath);
        const owner = await readJsonExact<{ pid?: number }>(lockPath);
        if (!processIsAlive(Number(owner.pid))) {
          const current = await lstat(lockPath);
          if (current.dev === observed.dev && current.ino === observed.ino) {
            await unlink(lockPath);
          }
          continue;
        }
      } catch (readError: any) {
        if (readError?.code === "ENOENT") continue;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error("conversation_authority_lease_timeout");
}

async function withConversationAuthorityProcessLease<T>(
  sessionDir: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = conversationAuthorityLeaseQueues.get(sessionDir) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const release = await acquireConversationAuthorityFileLease(sessionDir);
    try {
      return await action();
    } finally {
      await release();
    }
  });
  conversationAuthorityLeaseQueues.set(sessionDir, current);
  try {
    return await current;
  } finally {
    if (conversationAuthorityLeaseQueues.get(sessionDir) === current) {
      conversationAuthorityLeaseQueues.delete(sessionDir);
    }
  }
}

async function readJsonExact<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

function zeroIso(): string {
  return new Date(0).toISOString();
}

function createDefaultHistoryIndex(sessionId: string): ConversationHistoryIndexSnapshot {
  return {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId,
    heads: {},
    lineages: {},
    generations: {},
    updatedAt: zeroIso(),
  };
}

function createDefaultPromptIndex(sessionId: string): ConversationPromptIndexSnapshot {
  return {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId,
    heads: {},
    generations: {},
    updatedAt: zeroIso(),
  };
}

function createDefaultSessionIndex(sessionId: string): ConversationSessionIndexSnapshot {
  return {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId,
    session: {
      version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
      sessionId,
      activeActorKey: null,
      actorBindings: {},
      contextAssetRegistry: null,
      contextAssets: [],
      activeSelection: null,
      createdAt: zeroIso(),
      updatedAt: zeroIso(),
    },
    lineage: null,
    updatedAt: zeroIso(),
  };
}

function createDefaultArtifactRefs(sessionId: string): ConversationArtifactRefsSnapshot {
  return {
    version: CONVERSATION_PERSISTENCE_SCHEMA_VERSION,
    sessionId,
    refs: [],
    updatedAt: zeroIso(),
  };
}

function omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined));
}

type DurableAttachmentPart = {
  type: "text" | "image";
  assetId: string;
  kind: "text" | "image";
  mime: string;
  filename?: string;
  sourceDigest?: string;
  size: number;
  digest: string;
};

function safeMetadataText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, maxLength);
  return normalized || undefined;
}

function safeFilename(value: unknown): string | undefined {
  const text = safeMetadataText(value, 255);
  if (!text) return undefined;
  return text.split(/[\\/]/).at(-1) || undefined;
}

function safeSourceDigest(value: unknown): string | undefined {
  const text = safeMetadataText(value, 128);
  return text && /^[A-Za-z0-9:_-]+$/.test(text) ? text : undefined;
}

function decodeImageDataUrl(part: Record<string, unknown>): Buffer {
  const dataUrl = typeof part.dataUrl === "string" ? part.dataUrl : "";
  const match = /^data:([^;,]{1,128});base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
  if (!match || match[1] !== part.mime) {
    throw new Error("attachment_asset_integrity_error: invalid image data URL");
  }
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.toString("base64").replace(/=+$/, "") !== match[2].replace(/=+$/, "")) {
    throw new Error("attachment_asset_integrity_error: invalid image base64");
  }
  return bytes;
}

async function externalizeStructuredContent(
  sessionDir: string,
  content: InputContentPart[],
): Promise<Record<string, unknown>[]> {
  const durable: Record<string, unknown>[] = [];
  for (const rawPart of content) {
    const part = rawPart as InputContentPart & Record<string, unknown>;
    if (part.type === "file_reference") {
      throw new Error("attachment_asset_integrity_error: local file reference reached durable history");
    }
    if (part.type === "text" && !part.filename && !part.sourceDigest) {
      durable.push({ type: "text", text: part.text });
      continue;
    }

    const bytes = part.type === "image" ? decodeImageDataUrl(part) : Buffer.from(part.text, "utf8");
    const asset = await writeSessionAttachmentAsset({ sessionDir, bytes });
    durable.push(omitUndefined({
      type: part.type,
      assetId: asset.assetId,
      kind: part.type,
      mime: part.type === "image" ? safeMetadataText(part.mime, 128) : "text/plain; charset=utf-8",
      filename: safeFilename(part.filename),
      sourceDigest: safeSourceDigest(part.sourceDigest),
      size: asset.size,
      digest: asset.digest,
    }));
  }
  return durable;
}

function isDurableAttachmentPart(value: unknown): value is DurableAttachmentPart {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const part = value as Partial<DurableAttachmentPart>;
  return (part.type === "text" || part.type === "image")
    && part.kind === part.type
    && typeof part.assetId === "string"
    && typeof part.digest === "string"
    && typeof part.mime === "string"
    && typeof part.size === "number";
}

export async function hydrateStructuredContent(
  sessionDir: string,
  content: unknown[],
): Promise<InputContentPart[]> {
  const hydrated: InputContentPart[] = [];
  for (const rawPart of content) {
    if (isDurableAttachmentPart(rawPart)) {
      const bytes = await readSessionAttachmentAsset({
        sessionDir,
        assetId: rawPart.assetId,
        digest: rawPart.digest,
        size: rawPart.size,
      });
      if (rawPart.type === "image") {
        hydrated.push(omitUndefined({
          type: "image",
          mime: rawPart.mime,
          dataUrl: `data:${rawPart.mime};base64,${bytes.toString("base64")}`,
          filename: safeFilename(rawPart.filename),
          sourceDigest: safeSourceDigest(rawPart.sourceDigest),
          size: bytes.byteLength,
        }) as InputContentPart);
      } else {
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw new Error(`attachment_asset_integrity_error: ${rawPart.assetId}`);
        }
        hydrated.push(omitUndefined({
          type: "text",
          text,
          filename: safeFilename(rawPart.filename),
          sourceDigest: safeSourceDigest(rawPart.sourceDigest),
        }) as InputContentPart);
      }
      continue;
    }
    if (rawPart && typeof rawPart === "object" && !Array.isArray(rawPart)) {
      const part = rawPart as Record<string, unknown>;
      if (part.assetId || part.digest) {
        throw new Error("attachment_asset_integrity_error: malformed asset reference");
      }
      if (part.type === "text" && typeof part.text === "string") {
        hydrated.push(omitUndefined({
          type: "text",
          text: part.text,
          filename: safeFilename(part.filename),
          sourceDigest: safeMetadataText(part.sourceDigest, 128),
        }) as InputContentPart);
        continue;
      }
      if (part.type === "image" && typeof part.mime === "string" && typeof part.dataUrl === "string") {
        const bytes = decodeImageDataUrl(part);
        hydrated.push(omitUndefined({
          type: "image",
          mime: safeMetadataText(part.mime, 128),
          dataUrl: part.dataUrl,
          filename: safeFilename(part.filename),
          sourceDigest: safeMetadataText(part.sourceDigest, 128),
          size: bytes.byteLength,
        }) as InputContentPart);
        continue;
      }
    }
    throw new Error("attachment_asset_integrity_error: invalid structured history part");
  }
  return hydrated;
}

async function hydrateHistoryGenerationAssets(
  sessionDir: string,
  generation: ActorHistoryGenerationData,
): Promise<ActorHistoryGenerationData> {
  for (const entry of generation.messages) {
    if (Array.isArray(entry.message.content)) {
      entry.message.content = await hydrateStructuredContent(sessionDir, entry.message.content as unknown[]);
    }
  }
  return generation;
}

function readQuotedXnlFields(line: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of line.matchAll(QUOTED_XNL_FIELD)) {
    fields[match[1]] = match[2];
  }
  return fields;
}

async function scanExistingHistoryRecordIds(params: {
  filePath: string;
  generationId: string;
}): Promise<Set<string>> {
  const ids = new Set<string>();
  if (!fs.existsSync(params.filePath)) return ids;
  const lines = readline.createInterface({
    input: fs.createReadStream(params.filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      if (!line.startsWith(`<${HISTORY_MESSAGE_RECORD_TAG} `)) continue;
      const fields = readQuotedXnlFields(line);
      if (fields.generationId !== params.generationId || !fields.id) continue;
      ids.add(fields.id);
    }
  } finally {
    lines.close();
  }
  return ids;
}

async function scanExistingPromptGenerationIds(filePath: string): Promise<Set<string>> {
  const ids = new Set<string>();
  if (!fs.existsSync(filePath)) return ids;
  const lines = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      if (!line.startsWith(`<${PROMPT_GENERATION_RECORD_TAG} `)) continue;
      const fields = readQuotedXnlFields(line);
      if (fields.id) ids.add(fields.id);
    }
  } finally {
    lines.close();
  }
  return ids;
}

async function queueConversationXnlWrite<T>(
  queueKey: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = conversationXnlWriteQueues.get(queueKey) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(action);
  conversationXnlWriteQueues.set(queueKey, next);
  try {
    return await next;
  } finally {
    if (conversationXnlWriteQueues.get(queueKey) === next) {
      conversationXnlWriteQueues.delete(queueKey);
    }
  }
}

function xnlRecordToHistoryGeneration(record: XnlConversationRecord): ActorHistoryGenerationData | null {
  const bodyItem = record.body.find((item) => item.kind === "data" && item.tag === HISTORY_GENERATION_BODY_TAG)
    ?? record.body.find((item) => item.kind === "data");
  if (!bodyItem || bodyItem.kind !== "data" || !bodyItem.attributes) return null;
  return bodyItem.attributes as ActorHistoryGenerationData;
}

function historyMessageRecordToCommittedMessage(
  record: XnlConversationRecord,
): ActorHistoryGenerationData["messages"][number] | null {
  const legacyMessage = record.attributes.message;
  const message = historyMessageRecordToMessage(record)
    ?? (legacyMessage && typeof legacyMessage === "object" && !Array.isArray(legacyMessage)
      ? legacyMessage as ActorHistoryGenerationData["messages"][number]["message"]
      : null);
  if (!message) return null;
  return {
    recordId: String(record.metadata.id ?? ""),
    actorKey: String(record.metadata.actorKey ?? ""),
    actorId: String(record.metadata.actorId ?? ""),
    committedAt: Number(record.metadata.committedAt ?? 0),
    message: message as ActorHistoryGenerationData["messages"][number]["message"],
    sourceRecords: Array.isArray(record.attributes.sourceRecords)
      ? record.attributes.sourceRecords as ActorHistoryGenerationData["messages"][number]["sourceRecords"]
      : undefined,
  };
}

function historyMessageRecordToMessage(
  record: XnlConversationRecord,
): ActorHistoryGenerationData["messages"][number]["message"] | null {
  const orderedBlocks = [...record.body]
    .filter((block) => block.kind === "text" || block.kind === "data")
    .sort((left, right) => Number(left.metadata?.index ?? 0) - Number(right.metadata?.index ?? 0));
  if (orderedBlocks.length === 0) return null;

  const role = String(record.metadata.role ?? "");
  if (!role) return null;
  const message: ActorHistoryGenerationData["messages"][number]["message"] = {
    role,
    content: "",
  };
  if (typeof record.metadata.messageId === "string" && record.metadata.messageId) {
    message.messageId = record.metadata.messageId;
  }
  if (typeof record.metadata.name === "string") message.name = record.metadata.name;
  if (typeof record.metadata.startAt === "number") message.startAt = record.metadata.startAt;
  if (typeof record.metadata.endAt === "number") message.endAt = record.metadata.endAt;

  const contentParts: string[] = [];
  let structuredContent: ActorHistoryGenerationData["messages"][number]["message"]["content"] | undefined;
  for (const block of orderedBlocks) {
    if (block.kind === "text" && block.tag === "Think") {
      message.reasoningContent = block.text;
      continue;
    }
    if (block.kind === "data" && block.tag === "Think" && typeof block.attributes?.text === "string") {
      message.reasoningContent = block.attributes.text;
      continue;
    }
    if (block.kind === "text" && block.tag === "Content") {
      contentParts.push(block.text);
      continue;
    }
    if (block.kind === "data" && block.tag === "Content" && typeof block.attributes?.text === "string") {
      contentParts.push(block.attributes.text);
      continue;
    }
    if (block.kind === "data" && block.tag === "StructuredContent") {
      const parts = block.attributes?.parts;
      if (Array.isArray(parts)) {
        structuredContent = parts as ActorHistoryGenerationData["messages"][number]["message"]["content"];
      }
      continue;
    }
    if (block.kind === "data" && block.tag === "ToolCall") {
      const toolCallId = String(block.metadata?.toolCallId ?? "");
      const name = String(block.metadata?.name ?? "");
      if (!toolCallId || !name) continue;
      message.toolCalls ??= [];
      message.toolCalls.push({
        id: toolCallId,
        name,
        input: block.attributes?.input && typeof block.attributes.input === "object" && !Array.isArray(block.attributes.input)
          ? block.attributes.input as Record<string, unknown>
          : {},
      });
      continue;
    }
    if (block.kind === "data" && block.tag === "ToolResult") {
      const toolCallId = String(block.metadata?.toolCallId ?? "");
      if (toolCallId) {
        message.toolCallId = toolCallId;
        const toolCallIdFields = String(block.metadata?.toolCallIdFields ?? "camel");
        if (toolCallIdFields === "snake" || toolCallIdFields === "both") message.tool_call_id = toolCallId;
      }
      const output = block.attributes?.output;
      if (output && typeof output === "object" && !Array.isArray(output)) {
        const text = (output as Record<string, unknown>).text;
        message.content = typeof text === "string" ? text : "";
      } else if (typeof output === "string") {
        message.content = output;
      }
      const resultMetadata = block.attributes?.resultMetadata;
      if (resultMetadata && typeof resultMetadata === "object" && !Array.isArray(resultMetadata)) {
        message.resultMetadata = { ...(resultMetadata as Record<string, unknown>) };
      }
    }
  }
  if (structuredContent !== undefined) {
    message.content = structuredContent;
  } else if (contentParts.length > 0) {
    message.content = contentParts.join("");
  }
  return message;
}

function historyMessageRecordsToGeneration(
  generationId: string,
  records: Awaited<ReturnType<typeof readXnlRecords>>,
): ActorHistoryGenerationData | null {
  const messageRecords = records
    .filter((record) => record.tag === HISTORY_MESSAGE_RECORD_TAG && record.metadata.generationId === generationId)
    .sort((left, right) => Number(left.metadata.sequence ?? 0) - Number(right.metadata.sequence ?? 0));
  if (messageRecords.length === 0) return null;
  const dedupedByRecordId = new Map<string, XnlConversationRecord>();
  for (const record of messageRecords) {
    const recordId = String(record.metadata.id ?? "");
    if (!recordId) continue;
    dedupedByRecordId.set(recordId, record);
  }
  const dedupedRecords = [...dedupedByRecordId.values()];
  const hasCompleteSequence = dedupedRecords.every((record) => {
    const sequence = record.metadata.sequence;
    return typeof sequence === "number" && Number.isInteger(sequence) && sequence >= 0;
  });
  dedupedRecords.sort((left, right) => {
    if (hasCompleteSequence) {
      const sequenceDifference = Number(left.metadata.sequence) - Number(right.metadata.sequence);
      if (sequenceDifference !== 0) return sequenceDifference;
    } else {
      const leftCommitted = Number(left.metadata.committedAt ?? left.metadata.sequence ?? 0);
      const rightCommitted = Number(right.metadata.committedAt ?? right.metadata.sequence ?? 0);
      if (leftCommitted !== rightCommitted) return leftCommitted - rightCommitted;
    }
    return String(left.metadata.id ?? "").localeCompare(String(right.metadata.id ?? ""));
  });
  if (dedupedRecords.length === 0) return null;
  const generation = dedupedRecords[0].attributes.generation as Partial<ActorHistoryGenerationData> | undefined;
  const firstMetadata = dedupedRecords[0].metadata;
  const newestGenerationUpdatedAt = dedupedRecords.reduce<{
    value: string;
    epoch: number;
  } | null>((latest, record) => {
    const value = record.metadata.generationUpdatedAt;
    if (typeof value !== "string") return latest;
    const epoch = Date.parse(value);
    if (!Number.isFinite(epoch) || (latest && epoch <= latest.epoch)) return latest;
    return { value, epoch };
  }, null)?.value;
  const messages = dedupedRecords
    .map((record) => historyMessageRecordToCommittedMessage(record))
    .filter((message): message is ActorHistoryGenerationData["messages"][number] => Boolean(message));
  const parentGenerationId = generation?.parentGenerationId
    ?? (typeof firstMetadata.parentGenerationId === "string" ? firstMetadata.parentGenerationId : null);
  return {
    version: Number(generation?.version ?? CONVERSATION_PERSISTENCE_SCHEMA_VERSION),
    generationId,
    sessionId: String(generation?.sessionId ?? messageRecords[0].metadata.sessionId ?? ""),
    actorKey: String(generation?.actorKey ?? messageRecords[0].metadata.actorKey ?? ""),
    actorId: String(generation?.actorId ?? messageRecords[0].metadata.actorId ?? ""),
    parentGenerationId,
    predecessorGenerationIds: Array.isArray(firstMetadata.predecessorGenerationIds)
      ? firstMetadata.predecessorGenerationIds as string[]
      : Array.isArray(generation?.predecessorGenerationIds)
      ? generation.predecessorGenerationIds as string[]
      : [],
    createdReason: (generation?.createdReason ?? firstMetadata.createdReason ?? "append") as ActorHistoryGenerationData["createdReason"],
    sealed: Boolean(generation?.sealed ?? firstMetadata.sealed ?? false),
    messageCount: messages.length,
    messages,
    createdAt: String(generation?.createdAt ?? firstMetadata.generationCreatedAt ?? zeroIso()),
    updatedAt: String(newestGenerationUpdatedAt ?? generation?.updatedAt ?? zeroIso()),
  };
}

function xnlRecordToLegacyPromptGeneration(record: XnlConversationRecord): ActorPromptGenerationData | null {
  const bodyItem = record.body.find((item) => item.kind === "data" && item.tag === LEGACY_PROMPT_GENERATION_BODY_TAG)
    ?? record.body.find((item) => item.kind === "data");
  if (!bodyItem || bodyItem.kind !== "data" || !bodyItem.attributes) return null;
  return bodyItem.attributes as ActorPromptGenerationData;
}

function xnlRecordToPromptGeneration(record: XnlConversationRecord): ActorPromptGenerationData | null {
  if (record.tag === LEGACY_PROMPT_GENERATION_RECORD_TAG) return xnlRecordToLegacyPromptGeneration(record);
  if (record.tag !== PROMPT_GENERATION_RECORD_TAG) return null;

  const basisNode = record.body.find((item) => item.kind === "data" && item.tag === "Basis");
  if (!basisNode || basisNode.kind !== "data") return null;
  const basisRefs = record.body
    .filter(isXnlDataRecordBodyItemWithTag("BasisRef"))
    .sort((left, right) => Number(left.metadata?.index ?? 0) - Number(right.metadata?.index ?? 0))
    .map((item) => ({
      refKind: String(item.metadata?.kind ?? "unknown") as PromptBasisRef["refKind"],
      refId: String(item.metadata?.refId ?? ""),
      metadata: item.attributes?.metadata as Record<string, unknown> | undefined,
    }));
  const transforms = record.body
    .filter(isXnlDataRecordBodyItemWithTag("Transform"))
    .sort((left, right) => Number(left.metadata?.index ?? 0) - Number(right.metadata?.index ?? 0))
    .map((item) => ({
      transformId: String(item.metadata?.id ?? ""),
      kind: String(item.metadata?.kind ?? "overlay") as ActorPromptGenerationData["transforms"][number]["kind"],
      payload: (item.attributes?.payload ?? {}) as Record<string, unknown>,
      appliedAt: String(item.metadata?.appliedAt ?? zeroIso()),
    }));
  const materializedContextNode = record.body.find((item) => item.kind === "text" && item.tag === "MaterializedContext");
  const materializedContext = materializedContextNode?.kind === "text"
    ? materializedContextNode.metadata?.blockText === true
      ? materializedContextNode.text.replace(/\n$/, "")
      : materializedContextNode.text
    : null;
  const basis: ActorPromptGenerationData["basis"] = {
    version: Number(basisNode.metadata?.version ?? CONVERSATION_PERSISTENCE_SCHEMA_VERSION),
    basisHistoryGenerationIds: Array.isArray(basisNode.attributes?.historyGenerationIds)
      ? basisNode.attributes.historyGenerationIds as string[]
      : [],
    basisMessageRecordIds: Array.isArray(basisNode.attributes?.messageRecordIds)
      ? basisNode.attributes.messageRecordIds as string[]
      : [],
  };
  if (basisRefs.length > 0) basis.basisRefs = basisRefs;

  const generation: ActorPromptGenerationData = {
    version: Number(record.metadata.version ?? CONVERSATION_PERSISTENCE_SCHEMA_VERSION),
    promptGenerationId: String(record.metadata.id ?? ""),
    sessionId: String(record.metadata.sessionId ?? ""),
    actorKey: String(record.metadata.actorKey ?? ""),
    actorId: String(record.metadata.actorId ?? ""),
    basis,
    transforms,
    materializedContext,
    sealed: Boolean(record.metadata.sealed ?? false),
    createdAt: String(record.metadata.createdAt ?? zeroIso()),
    updatedAt: String(record.metadata.updatedAt ?? zeroIso()),
  };
  if ("basedOnPromptGenerationId" in record.metadata) {
    generation.basedOnPromptGenerationId = record.metadata.basedOnPromptGenerationId as string | null;
  }
  if ("reason" in record.metadata) {
    generation.createdReason = record.metadata.reason as ActorPromptGenerationData["createdReason"];
  }
  if ("sealedAt" in record.metadata) {
    generation.sealedAt = record.metadata.sealedAt as string | null;
  }
  if ("metadata" in record.attributes) {
    generation.metadata = record.attributes.metadata as Record<string, unknown>;
  }
  return generation;
}

async function createHistoryMessageBlocks(
  entry: ActorHistoryGenerationData["messages"][number],
  sessionDir: string,
): Promise<XnlAppendDataRecordBody> {
  const blocks: XnlAppendDataRecordBody = [];
  const nextIndex = () => blocks.length;
  const exactTextBlock = (tag: "Think" | "Content", text: string): XnlAppendDataRecordBody[number] => {
    const metadata = {
      id: `${entry.recordId}.b${nextIndex()}`,
      index: nextIndex(),
    };
    // xnl-core intentionally pretty-indents multiline TextElement bodies and
    // trims their boundary whitespace. Provider admission frontiers require
    // byte-exact History across recovery, so values affected by that display
    // normalization use a JSON-string data attribute instead. The reader keeps
    // accepting legacy TextElements for backward compatibility.
    if (text.includes("\n") || text.includes("\r") || text.trim() !== text) {
      return {
        kind: "data",
        tag,
        metadata,
        attributes: { text, textEncoding: "utf8-json-string/v1" },
      };
    }
    return { kind: "text", tag, metadata, text };
  };
  if (entry.message.reasoningContent) {
    blocks.push(exactTextBlock("Think", entry.message.reasoningContent));
  }
  if (entry.message.content && entry.message.role !== "tool") {
    if (typeof entry.message.content === "string") {
      blocks.push(exactTextBlock("Content", entry.message.content));
    } else {
      blocks.push({
        kind: "data",
        tag: "StructuredContent",
        metadata: {
          id: `${entry.recordId}.b${nextIndex()}`,
          index: nextIndex(),
        },
        attributes: {
          parts: await externalizeStructuredContent(sessionDir, entry.message.content),
        },
      });
    }
  }
  for (const toolCall of entry.message.toolCalls ?? []) {
    blocks.push({
      kind: "data",
      tag: "ToolCall",
      metadata: {
        id: `${entry.recordId}.b${nextIndex()}`,
        index: nextIndex(),
        toolCallId: toolCall.id,
        name: toolCall.name,
      },
      attributes: {
        input: toolCall.input,
      },
    });
  }
  const toolCallId = entry.message.toolCallId ?? entry.message.tool_call_id;
  if (entry.message.role === "tool" || toolCallId) {
    const toolCallIdFields = entry.message.toolCallId && entry.message.tool_call_id
      ? "both"
      : entry.message.tool_call_id ? "snake" : "camel";
    blocks.push({
      kind: "data",
      tag: "ToolResult",
      metadata: {
        id: `${entry.recordId}.b${nextIndex()}`,
        index: nextIndex(),
        toolCallId,
        toolCallIdFields,
      },
      attributes: {
        output: {
          kind: "text",
          text: typeof entry.message.content === "string" ? entry.message.content : "",
        },
        ...(entry.message.resultMetadata
          ? { resultMetadata: { ...entry.message.resultMetadata } }
          : {}),
      },
    });
  }
  return blocks;
}

function createPromptGenerationBody(
  generation: ActorPromptGenerationData,
): XnlAppendDataRecordBody {
  const body: XnlAppendDataRecordBody = [
    {
      kind: "data",
      tag: "Basis",
      metadata: {
        version: generation.basis.version,
      },
      attributes: {
        historyGenerationIds: generation.basis.basisHistoryGenerationIds,
        messageRecordIds: generation.basis.basisMessageRecordIds,
      },
    },
  ];
  for (const [index, basisRef] of (generation.basis.basisRefs ?? []).entries()) {
    body.push({
      kind: "data",
      tag: "BasisRef",
      metadata: {
        index,
        kind: basisRef.refKind,
        refId: basisRef.refId,
      },
      attributes: basisRef.metadata ? { metadata: basisRef.metadata } : undefined,
    });
  }
  for (const [index, transform] of generation.transforms.entries()) {
    body.push({
      kind: "data",
      tag: "Transform",
      metadata: {
        id: transform.transformId,
        index,
        kind: transform.kind,
        appliedAt: transform.appliedAt,
      },
      attributes: {
        payload: transform.payload,
      },
    });
  }
  if (generation.materializedContext !== null && generation.materializedContext !== undefined) {
    const usesBlockText = generation.materializedContext.includes("\n");
    body.push({
      kind: "text",
      tag: "MaterializedContext",
      metadata: omitUndefined({
        id: `${generation.promptGenerationId}.ctx`,
        blockText: usesBlockText ? true : undefined,
      }),
      text: usesBlockText ? `\n${generation.materializedContext}\n` : generation.materializedContext,
    });
  }
  return body;
}

function promptGenerationMetadata(generation: ActorPromptGenerationData): Record<string, unknown> {
  return omitUndefined({
    version: generation.version,
    id: generation.promptGenerationId,
    sessionId: generation.sessionId,
    actorKey: generation.actorKey,
    actorId: generation.actorId,
    basedOnPromptGenerationId: generation.basedOnPromptGenerationId,
    reason: generation.createdReason,
    sealed: generation.sealed,
    createdAt: generation.createdAt,
    sealedAt: generation.sealedAt,
    updatedAt: generation.updatedAt,
  });
}

function promptGenerationAttributes(generation: ActorPromptGenerationData): Record<string, unknown> {
  return omitUndefined({
    authority: {
      kind: "audit",
      recoverable: true,
      cache: false,
    },
    metadata: generation.metadata,
  });
}

export class LocalFileConversationPersistenceRepository implements ConversationPersistenceRepository {
  readonly sessionDir: string;
  private readonly knownHistoryRecordIdsByGeneration = new Map<string, Set<string>>();
  private knownPromptGenerationIds: Set<string> | null = null;
  private readonly options: LocalFileConversationPersistenceRepositoryOptions;
  private recoveringProviderContextTransition: Promise<void> | null = null;
  private recoveringConversationForkInitialization: Promise<void> | null = null;

  constructor(sessionDir: string, options: LocalFileConversationPersistenceRepositoryOptions = {}) {
    this.sessionDir = sessionDir;
    this.options = options;
  }

  async withConversationAuthorityLease<T>(action: () => Promise<T>): Promise<T> {
    const held = conversationAuthorityLeaseScope.getStore();
    const leaseKey = path.resolve(this.sessionDir);
    if (held?.has(leaseKey)) return await action();
    return await withConversationAuthorityProcessLease(this.sessionDir, async () => {
      const next = new Set(held ?? []);
      next.add(leaseKey);
      return await conversationAuthorityLeaseScope.run(next, action);
    });
  }

  private conversationForkInitializationGenerationPath(transactionId: string): string {
    if (!/^sha256:[0-9a-f]{64}$/.test(transactionId)) {
      throw new Error("conversation_fork_initialization_generation_id_invalid");
    }
    return path.join(
      forkInitializationPaths(this.sessionDir).generations,
      `${transactionId.slice("sha256:".length)}.json`,
    );
  }

  private assertForkInitializationGenerationExact(
    generation: ConversationForkInitializationGeneration,
  ): void {
    const { transactionId, ...facts } = generation;
    const targetSessionId = generation.sessionIndex.sessionId;
    const binding = generation.sessionIndex.session.actorBindings[generation.providerEpoch.childActorKey];
    if (generation.schemaVersion !== "conversation.fork-initialization-generation/v1"
      || digestConversationForkInitializationGeneration(facts) !== transactionId) {
      throw new Error("conversation_fork_initialization_generation_digest_mismatch");
    }
    if (digestConversationForkTargetAuthority(generation) !== generation.targetAuthorityDigest) {
      throw new Error("conversation_fork_target_authority_digest_mismatch");
    }
    if (!targetSessionId
      || generation.historyIndex.sessionId !== targetSessionId
      || generation.promptIndex.sessionId !== targetSessionId
      || generation.artifactRefs.sessionId !== targetSessionId
      || generation.sessionIndex.session.sessionId !== targetSessionId
      || generation.providerEpoch.childSessionId !== targetSessionId
      || generation.childProviderEpochReceipt.sessionId !== targetSessionId
      || generation.providerEpoch.childReceiptDigest !== generation.childProviderEpochReceipt.receiptDigest
      || generation.providerEpoch.childActorId !== generation.childProviderEpochReceipt.actorId
      || generation.providerEpoch.childActorKey !== generation.childProviderEpochReceipt.actorKey
      || binding?.providerEpochReceiptV2?.receiptDigest !== generation.childProviderEpochReceipt.receiptDigest
      || binding.providerEpochReceipt !== undefined
      || generation.childProviderEpochReceipt.reason !== "history_rewind_or_fork") {
      throw new Error("conversation_fork_initialization_authority_mismatch");
    }
    if (generation.mode === "create") {
      if (generation.expectedTargetAuthorityDigest !== null
        || generation.expectedTargetAuthority !== null
        || generation.childProviderEpochReceipt.epoch !== 0
        || generation.childProviderEpochReceipt.previousReceiptDigest !== null
        || generation.repairEvidence !== undefined) {
        throw new Error("conversation_fork_initialization_create_semantics_invalid");
      }
    } else {
      if (!generation.expectedTargetAuthorityDigest
        || !generation.expectedTargetAuthority
        || generation.childProviderEpochReceipt.epoch < 1
        || generation.childProviderEpochReceipt.previousReceiptDigest === null
        || !generation.repairEvidence
        || digestConversationForkAuthoritySnapshot(generation.expectedTargetAuthority)
          !== generation.expectedTargetAuthorityDigest
        || generation.repairEvidence.expectedTargetAuthorityDigest
          !== generation.expectedTargetAuthorityDigest) {
        throw new Error("conversation_fork_initialization_repair_semantics_invalid");
      }
    }
    if (generation.historyGenerations.some((entry) => entry.sessionId !== targetSessionId)
      || generation.promptGenerations.some((entry) => entry.sessionId !== targetSessionId)) {
      throw new Error("conversation_fork_initialization_cross_session_loader_edge");
    }
  }

  private async writeImmutableForkInitializationGeneration(
    generation: ConversationForkInitializationGeneration,
  ): Promise<string> {
    const paths = forkInitializationPaths(this.sessionDir);
    await ensureDurableDirectory(paths.root);
    await ensureDurableDirectory(paths.generations);
    this.options.conversationForkInitializationFault?.("after-stage-create");
    const targetPath = this.conversationForkInitializationGenerationPath(generation.transactionId);
    const body = `${JSON.stringify(generation, null, 2)}\n`;
    try {
      const existing = await readFile(targetPath, "utf8");
      if (existing !== body) throw new Error("conversation_fork_immutable_generation_conflict");
      return targetPath;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(body, "utf8");
      this.options.conversationForkInitializationFault?.("after-stage-write");
      await handle.sync();
      this.options.conversationForkInitializationFault?.("after-stage-fsync");
    } finally {
      await handle.close();
    }
    try {
      await link(tempPath, targetPath);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readFile(targetPath, "utf8");
      if (existing !== body) throw new Error("conversation_fork_immutable_generation_conflict");
    } finally {
      await unlink(tempPath).catch(() => {});
    }
    await fsyncDirectory(paths.generations);
    this.options.conversationForkInitializationFault?.("after-stage-publish");
    return targetPath;
  }

  /**
   * Durable cross-process CAS for the target Conversation authority. The
   * immutable generation is hard-linked into the single claim path, so two
   * processes can never publish different fork/repair transactions for the
   * same target even before the hydrate-gating Session/head is visible.
   *
   * The claim intentionally survives crashes. A retry of the same immutable
   * transaction continues journal recovery; a different proof fails closed.
   */
  private async claimConversationForkInitialization(
    generation: ConversationForkInitializationGeneration,
    generationPath: string,
  ): Promise<void> {
    const paths = forkInitializationPaths(this.sessionDir);
    try {
      await link(generationPath, paths.claim);
      await fsyncDirectory(paths.root);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const claimed = await readJsonExact<ConversationForkInitializationGeneration>(paths.claim);
      this.assertForkInitializationGenerationExact(claimed);
      if (claimed.transactionId !== generation.transactionId
        || claimed.targetAuthorityDigest !== generation.targetAuthorityDigest) {
        throw new Error("conversation_fork_initialization_claim_cas_conflict");
      }
    }
    this.options.conversationForkInitializationFault?.("after-claim-cas");
  }

  private forkProjectionCompatible(current: unknown, pristine: unknown, target: unknown): boolean {
    const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
    const currentDigest = digest(current);
    return currentDigest === digest(pristine) || currentDigest === digest(target);
  }

  private async loadHistoryGenerationWithoutRecovery(generationId: string): Promise<ActorHistoryGenerationData | null> {
    const paths = getLocalConversationPaths(this.sessionDir);
    const records = await readXnlRecords({ filePath: paths.historyXnlPath });
    const messageGeneration = historyMessageRecordsToGeneration(generationId, records);
    if (messageGeneration) return await hydrateHistoryGenerationAssets(this.sessionDir, messageGeneration);
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (records[index].tag !== HISTORY_GENERATION_RECORD_TAG) continue;
      const generation = xnlRecordToHistoryGeneration(records[index]);
      if (generation?.generationId === generationId) return generation;
    }
    return null;
  }

  private async loadPromptGenerationWithoutRecovery(promptGenerationId: string): Promise<ActorPromptGenerationData | null> {
    const paths = getLocalConversationPaths(this.sessionDir);
    const records = [
      ...await readXnlRecords({ filePath: paths.promptsXnlPath, tag: PROMPT_GENERATION_RECORD_TAG }),
      ...await readXnlRecords({ filePath: paths.promptsXnlPath, tag: LEGACY_PROMPT_GENERATION_RECORD_TAG }),
    ];
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const generation = xnlRecordToPromptGeneration(records[index]);
      if (generation?.promptGenerationId === promptGenerationId) return generation;
    }
    return null;
  }

  private async applyConversationForkInitialization(
    generation: ConversationForkInitializationGeneration,
  ): Promise<void> {
    this.assertForkInitializationGenerationExact(generation);
    const paths = getLocalConversationPaths(this.sessionDir);
    const forkPaths = forkInitializationPaths(this.sessionDir);
    const targetSessionId = generation.sessionIndex.sessionId;
    const currentHistory = await readJsonBestEffort(paths.historyIndexPath, createDefaultHistoryIndex(targetSessionId));
    const currentPrompt = await readJsonBestEffort(paths.promptIndexPath, createDefaultPromptIndex(targetSessionId));
    const currentSession = await readJsonBestEffort(paths.sessionIndexPath, createDefaultSessionIndex(targetSessionId));
    const currentArtifacts = await readJsonBestEffort(paths.artifactRefsPath, createDefaultArtifactRefs(targetSessionId));
    const pristineHistory = createDefaultHistoryIndex(targetSessionId);
    const pristinePrompt = createDefaultPromptIndex(targetSessionId);
    const pristineSession = createDefaultSessionIndex(targetSessionId);
    const pristineArtifacts = createDefaultArtifactRefs(targetSessionId);
    if (generation.mode === "create") {
      const compatible = this.forkProjectionCompatible(currentHistory, pristineHistory, generation.historyIndex)
        && this.forkProjectionCompatible(currentPrompt, pristinePrompt, generation.promptIndex)
        && this.forkProjectionCompatible(currentSession, pristineSession, generation.sessionIndex)
        && this.forkProjectionCompatible(currentArtifacts, pristineArtifacts, generation.artifactRefs);
      if (!compatible) throw new Error("conversation_fork_target_authority_conflict");
    } else {
      const expected = generation.expectedTargetAuthority;
      if (!expected || generation.expectedTargetAuthorityDigest === null) {
        throw new Error("conversation_fork_repair_expected_authority_missing");
      }
      const compatible = this.forkProjectionCompatible(currentHistory, expected.historyIndex, generation.historyIndex)
        && this.forkProjectionCompatible(currentPrompt, expected.promptIndex, generation.promptIndex)
        && this.forkProjectionCompatible(currentSession, expected.sessionIndex, generation.sessionIndex)
        && this.forkProjectionCompatible(currentArtifacts, expected.artifactRefs, generation.artifactRefs);
      if (!compatible) throw new Error("conversation_fork_repair_target_authority_cas_conflict");
      const [currentHistoryGenerations, currentPromptGenerations] = await Promise.all([
        Promise.all(expected.historyGenerations.map((entry) => this.loadHistoryGenerationWithoutRecovery(entry.generationId))),
        Promise.all(expected.promptGenerations.map((entry) => this.loadPromptGenerationWithoutRecovery(entry.promptGenerationId))),
      ]);
      const normalizePersisted = (value: unknown) => JSON.parse(JSON.stringify(value));
      if (canonicalJson(normalizePersisted(currentHistoryGenerations)) !== canonicalJson(expected.historyGenerations)
        || canonicalJson(normalizePersisted(currentPromptGenerations)) !== canonicalJson(expected.promptGenerations)) {
        throw new Error("conversation_fork_repair_target_xnl_cas_conflict");
      }
    }

    for (const historyGeneration of generation.historyGenerations) {
      await this.writeHistoryGeneration(historyGeneration);
    }
    for (const promptGeneration of generation.promptGenerations) {
      await this.writePromptGeneration(promptGeneration);
    }
    await writeDurableReplace(paths.historyIndexPath, generation.historyIndex);
    await writeDurableReplace(paths.promptIndexPath, generation.promptIndex);
    await writeDurableReplace(paths.artifactRefsPath, generation.artifactRefs);
    this.options.conversationForkInitializationFault?.("before-authority-publish");
    // Session publication is the hydrate/admission gate. Every load path first
    // replays a surviving journal, so a published Session is never observed
    // without its exact History, Prompt and provider receipt.
    await writeDurableReplace(paths.sessionIndexPath, generation.sessionIndex);
    this.options.conversationForkInitializationFault?.("after-authority-publish");
    await writeDurableReplace(forkPaths.head, {
      schemaVersion: "conversation.fork-initialization-head/v1",
      transactionId: generation.transactionId,
      targetAuthorityDigest: generation.targetAuthorityDigest,
      childProviderEpochReceiptDigest: generation.childProviderEpochReceipt.receiptDigest,
    } satisfies ConversationForkInitializationHead);
    this.options.conversationForkInitializationFault?.("after-head-cas");
  }

  private providerContextTransitionGenerationPath(transitionId: string): string {
    if (!/^sha256:[0-9a-f]{64}$/.test(transitionId)) {
      throw new Error("provider_context_transition_generation_id_invalid");
    }
    return path.join(
      providerTransitionPaths(this.sessionDir).generations,
      `${transitionId.slice("sha256:".length)}.json`,
    );
  }

  private assertTransitionGenerationExact(
    transition: ConversationProviderContextTransitionGeneration,
  ): void {
    const { transitionId, ...facts } = transition;
    if (transition.schemaVersion !== "conversation.provider-context-transition-generation/v1"
      || digestConversationProviderContextTransitionGeneration(facts) !== transitionId) {
      throw new Error("provider_context_transition_generation_digest_mismatch");
    }
  }

  private async writeImmutableTransitionGeneration(
    transition: ConversationProviderContextTransitionGeneration,
  ): Promise<string> {
    const paths = providerTransitionPaths(this.sessionDir);
    await ensureDurableDirectory(paths.root);
    await ensureDurableDirectory(paths.generations);
    this.options.providerContextTransitionFault?.("after-stage-create");
    const targetPath = this.providerContextTransitionGenerationPath(transition.transitionId);
    const body = `${JSON.stringify(transition, null, 2)}\n`;
    try {
      const existing = await readFile(targetPath, "utf8");
      if (existing !== body) throw new Error("provider_context_transition_immutable_generation_conflict");
      return targetPath;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(body, "utf8");
      this.options.providerContextTransitionFault?.("after-stage-write");
      await handle.sync();
      this.options.providerContextTransitionFault?.("after-stage-fsync");
    } finally {
      await handle.close();
    }
    try {
      await link(tempPath, targetPath);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const existing = await readFile(targetPath, "utf8");
      if (existing !== body) throw new Error("provider_context_transition_immutable_generation_conflict");
    } finally {
      await unlink(tempPath).catch(() => {});
    }
    await fsyncDirectory(paths.generations);
    this.options.providerContextTransitionFault?.("after-stage-publish");
    return targetPath;
  }

  private transitionActorKey(transition: ConversationProviderContextTransitionGeneration): string {
    const matches = Object.entries(transition.sessionIndex.session.actorBindings).filter(([, binding]) => (
      binding.providerEpochReceiptV2?.receiptDigest === transition.nextEpochReceiptDigest
    ));
    if (matches.length !== 1) throw new Error("provider_context_transition_generation_actor_ambiguous");
    return matches[0]![0];
  }

  private async applyProviderContextTransitionGeneration(
    transition: ConversationProviderContextTransitionGeneration,
  ): Promise<void> {
    this.assertTransitionGenerationExact(transition);
    const paths = getLocalConversationPaths(this.sessionDir);
    const actorKey = this.transitionActorKey(transition);
    const currentSession = await readJsonBestEffort(paths.sessionIndexPath, createDefaultSessionIndex(this.sessionDir));
    const currentHistory = await readJsonBestEffort(paths.historyIndexPath, createDefaultHistoryIndex(this.sessionDir));
    const currentPrompt = await readJsonBestEffort(paths.promptIndexPath, createDefaultPromptIndex(this.sessionDir));
    const currentArtifacts = await readJsonBestEffort(paths.artifactRefsPath, createDefaultArtifactRefs(this.sessionDir));
    const currentBinding = currentSession.session.actorBindings[actorKey];
    if (currentBinding?.providerEpochReceipt && currentBinding.providerEpochReceiptV2) {
      throw new Error("provider_context_dual_authority_forbidden");
    }
    const currentDigest = currentBinding?.providerEpochReceiptV2?.receiptDigest
      ?? (currentBinding?.providerEpochReceipt
        ? `sha256:${createHash("sha256").update(canonicalJson(currentBinding.providerEpochReceipt), "utf8").digest("hex")}`
        : null);
    if (currentDigest !== transition.nextEpochReceiptDigest
      && currentDigest !== transition.expectedEpochReceiptDigest) {
      throw new Error("provider_context_transition_head_cas_conflict");
    }
    if (transition.sessionIndex.session.actorBindings[actorKey]?.providerEpochReceipt) {
      throw new Error("provider_context_transition_generation_dual_authority");
    }
    for (const generation of transition.historyGenerations) await this.writeHistoryGeneration(generation);
    for (const generation of transition.promptGenerations) await this.writePromptGeneration(generation);
    const merged = mergeActorScopedTransitionSnapshots({
      actorKey,
      transition,
      currentHistory,
      currentPrompt,
      currentSession,
      currentArtifacts,
    });
    await writeDurableReplace(paths.historyIndexPath, merged.historyIndex);
    await writeDurableReplace(paths.promptIndexPath, merged.promptIndex);
    await writeDurableReplace(paths.artifactRefsPath, merged.artifactRefs);
    this.options.providerContextTransitionFault?.("before-head-cas");
    await writeDurableReplace(paths.sessionIndexPath, merged.sessionIndex);
    const transitionPaths = providerTransitionPaths(this.sessionDir);
    await writeDurableReplace(transitionPaths.head, {
      schemaVersion: "conversation.provider-context-transition-head/v1",
      transitionId: transition.transitionId,
      nextEpochReceiptDigest: transition.nextEpochReceiptDigest,
    });
    this.options.providerContextTransitionFault?.("after-head-cas");
  }

  async loadHistoryIndex(): Promise<ConversationHistoryIndexSnapshot> {
    await this.recoverConversationForkInitialization();
    await this.recoverProviderContextTransitionGeneration();
    const paths = getLocalConversationPaths(this.sessionDir);
    return await readJsonBestEffort(paths.historyIndexPath, createDefaultHistoryIndex(this.sessionDir));
  }

  async writeHistoryIndex(index: ConversationHistoryIndexSnapshot): Promise<void> {
    await this.withConversationAuthorityLease(async () => {
      const paths = getLocalConversationPaths(this.sessionDir);
      await writeJsonAtomically(paths.historyIndexPath, index);
    });
  }

  async loadHistoryGeneration(generationId: string): Promise<ActorHistoryGenerationData | null> {
    await this.recoverConversationForkInitialization();
    await this.recoverProviderContextTransitionGeneration();
    const messageGeneration = await this.loadHistoryGenerationWithoutRecovery(generationId);
    if (messageGeneration) {
      this.knownHistoryRecordIdsByGeneration.set(
        generationId,
        new Set(messageGeneration.messages.map((message) => message.recordId)),
      );
    }
    return messageGeneration;
  }

  async writeHistoryGeneration(generation: ActorHistoryGenerationData): Promise<void> {
    await this.withConversationAuthorityLease(async () => {
      const paths = getLocalConversationPaths(this.sessionDir);
      await queueConversationXnlWrite(`${paths.historyXnlPath}:${generation.generationId}`, async () => {
        const knownRecordIds = await scanExistingHistoryRecordIds({
          filePath: paths.historyXnlPath,
          generationId: generation.generationId,
        });
        this.knownHistoryRecordIdsByGeneration.set(generation.generationId, knownRecordIds);
        for (const [sequence, entry] of generation.messages.entries()) {
          if (knownRecordIds.has(entry.recordId)) continue;
          const blocks = await createHistoryMessageBlocks(entry, this.sessionDir);
          await appendXnlRecord({
            filePath: paths.historyXnlPath,
            tag: HISTORY_MESSAGE_RECORD_TAG,
            metadata: {
              version: generation.version,
              id: entry.recordId,
              sessionId: generation.sessionId,
              actorKey: entry.actorKey,
              actorId: entry.actorId,
              messageId: entry.message.messageId,
              role: entry.message.role,
              name: entry.message.name,
              startAt: entry.message.startAt,
              endAt: entry.message.endAt,
              committedAt: entry.committedAt,
              sequence,
              generationId: generation.generationId,
              parentGenerationId: generation.parentGenerationId ?? null,
              predecessorGenerationIds: generation.predecessorGenerationIds,
              createdReason: generation.createdReason,
              sealed: generation.sealed,
              messageCount: generation.messageCount,
              generationCreatedAt: generation.createdAt,
              generationUpdatedAt: generation.updatedAt,
              blockCount: blocks?.length ?? 0,
            },
            // Legacy transcript-shaped `sourceRecords` duplicate the same text already
            // stored in the block children, so they are intentionally not persisted.
            // The reader keeps accepting `sourceRecords` attributes from legacy records.
            body: blocks,
          });
          knownRecordIds.add(entry.recordId);
        }
      });
    });
  }

  async listHistoryGenerationIds(): Promise<string[]> {
    await this.recoverConversationForkInitialization();
    await this.recoverProviderContextTransitionGeneration();
    const paths = getLocalConversationPaths(this.sessionDir);
    const generationIds = new Set<string>();
    const records = await readXnlRecords({
      filePath: paths.historyXnlPath,
    });
    for (const record of records) {
      if (record.tag === HISTORY_MESSAGE_RECORD_TAG && typeof record.metadata.generationId === "string") {
        generationIds.add(record.metadata.generationId);
        continue;
      }
      if (record.tag === HISTORY_GENERATION_RECORD_TAG) {
        const generation = xnlRecordToHistoryGeneration(record);
        if (generation?.generationId) generationIds.add(generation.generationId);
      }
    }
    return [...generationIds].sort((a, b) => a.localeCompare(b));
  }

  async loadPromptIndex(): Promise<ConversationPromptIndexSnapshot> {
    await this.recoverConversationForkInitialization();
    await this.recoverProviderContextTransitionGeneration();
    const paths = getLocalConversationPaths(this.sessionDir);
    return await readJsonBestEffort(paths.promptIndexPath, createDefaultPromptIndex(this.sessionDir));
  }

  async writePromptIndex(index: ConversationPromptIndexSnapshot): Promise<void> {
    await this.withConversationAuthorityLease(async () => {
      const paths = getLocalConversationPaths(this.sessionDir);
      await writeJsonAtomically(paths.promptIndexPath, index);
    });
  }

  async loadPromptGeneration(promptGenerationId: string): Promise<ActorPromptGenerationData | null> {
    await this.recoverConversationForkInitialization();
    await this.recoverProviderContextTransitionGeneration();
    return await this.loadPromptGenerationWithoutRecovery(promptGenerationId);
  }

  async writePromptGeneration(generation: ActorPromptGenerationData): Promise<void> {
    await this.withConversationAuthorityLease(async () => {
      const paths = getLocalConversationPaths(this.sessionDir);
      await queueConversationXnlWrite(paths.promptsXnlPath, async () => {
        this.knownPromptGenerationIds = await scanExistingPromptGenerationIds(paths.promptsXnlPath);
        if (this.knownPromptGenerationIds.has(generation.promptGenerationId)) return;
        await appendXnlRecord({
          filePath: paths.promptsXnlPath,
          tag: PROMPT_GENERATION_RECORD_TAG,
          metadata: promptGenerationMetadata(generation),
          attributes: promptGenerationAttributes(generation),
          body: createPromptGenerationBody(generation),
        });
        this.knownPromptGenerationIds.add(generation.promptGenerationId);
      });
    });
  }

  async listPromptGenerationIds(): Promise<string[]> {
    await this.recoverConversationForkInitialization();
    await this.recoverProviderContextTransitionGeneration();
    const paths = getLocalConversationPaths(this.sessionDir);
    const generationIds = new Set<string>();
    const records = [
      ...await readXnlRecords({
        filePath: paths.promptsXnlPath,
        tag: PROMPT_GENERATION_RECORD_TAG,
      }),
      ...await readXnlRecords({
        filePath: paths.promptsXnlPath,
        tag: LEGACY_PROMPT_GENERATION_RECORD_TAG,
      }),
    ];
    for (const record of records) {
      const generation = xnlRecordToPromptGeneration(record);
      if (generation?.promptGenerationId) generationIds.add(generation.promptGenerationId);
    }
    return [...generationIds].sort((a, b) => a.localeCompare(b));
  }

  async loadSessionIndex(): Promise<ConversationSessionIndexSnapshot> {
    await this.recoverConversationForkInitialization();
    await this.recoverProviderContextTransitionGeneration();
    const paths = getLocalConversationPaths(this.sessionDir);
    return await readJsonBestEffort(paths.sessionIndexPath, createDefaultSessionIndex(this.sessionDir));
  }

  async writeSessionIndex(index: ConversationSessionIndexSnapshot): Promise<void> {
    await this.withConversationAuthorityLease(async () => {
      const paths = getLocalConversationPaths(this.sessionDir);
      await writeJsonAtomically(paths.sessionIndexPath, index);
    });
  }

  async loadArtifactRefs(): Promise<ConversationArtifactRefsSnapshot> {
    await this.recoverConversationForkInitialization();
    await this.recoverProviderContextTransitionGeneration();
    const paths = getLocalConversationPaths(this.sessionDir);
    return await readJsonBestEffort(paths.artifactRefsPath, createDefaultArtifactRefs(this.sessionDir));
  }

  async writeArtifactRefs(snapshot: ConversationArtifactRefsSnapshot): Promise<void> {
    await this.withConversationAuthorityLease(async () => {
      const paths = getLocalConversationPaths(this.sessionDir);
      await writeJsonAtomically(paths.artifactRefsPath, snapshot);
    });
  }

  async commitConversationForkInitialization(
    generation: ConversationForkInitializationGeneration,
  ): Promise<void> {
    await this.recoverConversationForkInitialization();
    await this.withConversationAuthorityLease(async () => withConversationForkInitializationLock(this.sessionDir, async () => {
      this.assertForkInitializationGenerationExact(generation);
      const paths = forkInitializationPaths(this.sessionDir);
      try {
        const head = await readJsonExact<ConversationForkInitializationHead>(paths.head);
        if (head.transactionId === generation.transactionId
          && head.targetAuthorityDigest === generation.targetAuthorityDigest
          && head.childProviderEpochReceiptDigest === generation.childProviderEpochReceipt.receiptDigest) {
          return;
        }
        throw new Error("conversation_fork_initialization_head_cas_conflict");
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
      const generationPath = await this.writeImmutableForkInitializationGeneration(generation);
      await this.claimConversationForkInitialization(generation, generationPath);
      await writeDurableReplace(paths.journal, {
        schemaVersion: "conversation.fork-initialization-journal/v1",
        transactionId: generation.transactionId,
        generationPath: path.basename(generationPath),
      });
      this.options.conversationForkInitializationFault?.("after-journal-publish");
      await this.applyConversationForkInitialization(generation);
      await rm(paths.journal, { force: true });
      await fsyncDirectory(paths.root);
    }));
  }

  async loadConversationForkHead(): Promise<ConversationForkInitializationHead | null> {
    await this.recoverConversationForkInitialization();
    const paths = forkInitializationPaths(this.sessionDir);
    try {
      const head = await readJsonExact<ConversationForkInitializationHead>(paths.head);
      if (head.schemaVersion !== "conversation.fork-initialization-head/v1"
        || !/^sha256:[0-9a-f]{64}$/.test(head.transactionId)
        || !/^sha256:[0-9a-f]{64}$/.test(head.targetAuthorityDigest)
        || !/^sha256:[0-9a-f]{64}$/.test(head.childProviderEpochReceiptDigest)) {
        throw new Error("conversation_fork_initialization_head_invalid");
      }
      return head;
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async loadConversationForkInitializationGeneration(
    transactionId: `sha256:${string}`,
  ): Promise<ConversationForkInitializationGeneration | null> {
    await this.recoverConversationForkInitialization();
    try {
      const generation = await readJsonExact<ConversationForkInitializationGeneration>(
        this.conversationForkInitializationGenerationPath(transactionId),
      );
      this.assertForkInitializationGenerationExact(generation);
      return generation;
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async recoverConversationForkInitialization(): Promise<void> {
    if (this.recoveringConversationForkInitialization) {
      return await this.recoveringConversationForkInitialization;
    }
    const recover = async () => this.withConversationAuthorityLease(
      async () => withConversationForkInitializationLock(this.sessionDir, async () => {
      const paths = forkInitializationPaths(this.sessionDir);
      await assertRealDirectoryOrMissing(paths.root);
      try {
        const journal = await readJsonExact<{
          schemaVersion: string;
          transactionId: string;
          generationPath: string;
        }>(paths.journal);
        if (journal.schemaVersion !== "conversation.fork-initialization-journal/v1"
          || journal.generationPath !== `${journal.transactionId.slice("sha256:".length)}.json`) {
          throw new Error("conversation_fork_initialization_journal_invalid");
        }
        const generationPath = this.conversationForkInitializationGenerationPath(journal.transactionId);
        const generation = await readJsonExact<ConversationForkInitializationGeneration>(generationPath);
        if (generation.transactionId !== journal.transactionId) {
          throw new Error("conversation_fork_initialization_journal_generation_mismatch");
        }
        await this.claimConversationForkInitialization(generation, generationPath);
        await this.applyConversationForkInitialization(generation);
        await rm(paths.journal, { force: true });
        await fsyncDirectory(paths.root);
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
      }),
    );
    this.recoveringConversationForkInitialization = recover();
    try {
      await this.recoveringConversationForkInitialization;
    } finally {
      this.recoveringConversationForkInitialization = null;
    }
  }

  async commitProviderContextTransitionGeneration(
    transition: ConversationProviderContextTransitionGeneration,
  ): Promise<void> {
    await this.recoverProviderContextTransitionGeneration();
    await this.withConversationAuthorityLease(async () => withProviderContextTransitionLock(this.sessionDir, async () => {
      this.assertTransitionGenerationExact(transition);
      const generationPath = await this.writeImmutableTransitionGeneration(transition);
      const paths = providerTransitionPaths(this.sessionDir);
      await writeDurableReplace(paths.journal, {
        schemaVersion: "conversation.provider-context-transition-journal/v1",
        transitionId: transition.transitionId,
        generationPath: path.basename(generationPath),
      });
      await this.applyProviderContextTransitionGeneration(transition);
      await rm(paths.journal, { force: true });
      await fsyncDirectory(paths.root);
    }));
  }

  async loadProviderContextTransitionHead(): Promise<ConversationProviderContextTransitionHead | null> {
    await this.recoverProviderContextTransitionGeneration();
    const paths = providerTransitionPaths(this.sessionDir);
    try {
      const head = await readJsonExact<ConversationProviderContextTransitionHead>(paths.head);
      if (head.schemaVersion !== "conversation.provider-context-transition-head/v1"
        || !/^sha256:[0-9a-f]{64}$/.test(head.transitionId)
        || !/^sha256:[0-9a-f]{64}$/.test(head.nextEpochReceiptDigest)) {
        throw new Error("provider_context_transition_head_invalid");
      }
      return head;
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
  }

  async recoverProviderContextTransitionGeneration(): Promise<void> {
    if (this.recoveringProviderContextTransition) return await this.recoveringProviderContextTransition;
    const recover = async () => this.withConversationAuthorityLease(
      async () => withProviderContextTransitionLock(this.sessionDir, async () => {
      const paths = providerTransitionPaths(this.sessionDir);
      await assertRealDirectoryOrMissing(paths.root);
      try {
        const journal = await readJsonExact<{
          schemaVersion: string;
          transitionId: string;
          generationPath: string;
        }>(paths.journal);
        if (journal.schemaVersion !== "conversation.provider-context-transition-journal/v1"
          || journal.generationPath !== `${journal.transitionId.slice("sha256:".length)}.json`) {
          throw new Error("provider_context_transition_journal_invalid");
        }
        const generationPath = this.providerContextTransitionGenerationPath(journal.transitionId);
        const transition = await readJsonExact<ConversationProviderContextTransitionGeneration>(generationPath);
        if (transition.transitionId !== journal.transitionId) {
          throw new Error("provider_context_transition_journal_generation_mismatch");
        }
        await this.applyProviderContextTransitionGeneration(transition);
        await rm(paths.journal, { force: true });
        await fsyncDirectory(paths.root);
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
      }),
    );
    this.recoveringProviderContextTransition = recover();
    try {
      await this.recoveringProviderContextTransition;
    } finally {
      this.recoveringProviderContextTransition = null;
    }
  }
}

export const LocalFileConversationPersistenceRepositoryFactory: ConversationPersistenceRepositoryFactory = {
  createRepository(sessionDir: string) {
    return new LocalFileConversationPersistenceRepository(sessionDir);
  },
};
