import { createHash } from "node:crypto";

import type {
  ActorDurableMaterial,
  ActorDurableMaterialIndex,
  ActorDurableMaterialIndexInput,
} from "@cell/ai-core-contract/runtime/ActorDurableMaterial";

function fail(reason: string): never {
  throw new Error(`ACTOR_DURABLE_MATERIAL_INVALID: ${reason}`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalBase64(value: string, label: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    fail(`${label}.bytes must be canonical base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail(`${label}.bytes must be canonical base64`);
  return bytes;
}

export function normalizeActorDurableMaterialIndex(
  input: ActorDurableMaterialIndexInput | null | undefined,
): ActorDurableMaterialIndex {
  if (input === undefined || input === null) return Object.freeze({});
  if (typeof input !== "object" || Array.isArray(input)) fail("index must be an object");
  const normalized: Record<string, ActorDurableMaterial> = {};
  for (const digest of Object.keys(input).sort()) {
    if (!/^[a-f0-9]{64}$/.test(digest)) fail(`index key ${digest} must be a sha256 digest`);
    const raw = input[digest];
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(`${digest} must be an object`);
    const record = raw as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    if (keys.join("\0") !== ["bytes", "digest", "encoding", "mediaType", "schemaVersion"].sort().join("\0")) {
      fail(`${digest} must have the exact closed material shape`);
    }
    if (record.schemaVersion !== "eidolon.actor-durable-material/v1") fail(`${digest}.schemaVersion is unsupported`);
    if (record.digest !== digest) fail(`${digest}.digest must equal its index key`);
    if (record.encoding !== "base64") fail(`${digest}.encoding must be base64`);
    if (typeof record.mediaType !== "string" || !record.mediaType.trim()) fail(`${digest}.mediaType is required`);
    if (typeof record.bytes !== "string") fail(`${digest}.bytes must be a string`);
    const bytes = canonicalBase64(record.bytes, digest);
    if (sha256(bytes) !== digest) fail(`${digest}.digest does not address bytes`);
    normalized[digest] = Object.freeze({
      schemaVersion: "eidolon.actor-durable-material/v1",
      digest,
      encoding: "base64",
      mediaType: record.mediaType,
      bytes: record.bytes,
    });
  }
  return Object.freeze(normalized);
}

export function createActorDurableMaterial(
  input: string | Uint8Array,
  mediaType = "application/octet-stream",
): ActorDurableMaterial {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = sha256(bytes);
  return Object.freeze({
    schemaVersion: "eidolon.actor-durable-material/v1",
    digest,
    encoding: "base64",
    mediaType,
    bytes: Buffer.from(bytes).toString("base64"),
  });
}

export function readActorDurableMaterialBytes(
  owner: { durableMaterials: ActorDurableMaterialIndex },
  digest: string,
): Uint8Array {
  const normalized = normalizeActorDurableMaterialIndex(owner.durableMaterials);
  const material = normalized[digest];
  if (!material) throw new Error(`ACTOR_DURABLE_MATERIAL_NOT_FOUND: ${digest}`);
  return Buffer.from(material.bytes, "base64");
}

export function readActorDurableMaterialText(
  owner: { durableMaterials: ActorDurableMaterialIndex },
  digest: string,
): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(readActorDurableMaterialBytes(owner, digest));
}
