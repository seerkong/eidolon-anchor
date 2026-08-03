import { createHash } from "node:crypto"
import { mkdir, open, readFile } from "node:fs/promises"
import path from "node:path"

const ASSET_ID_PATTERN = /^attachment-sha256-([a-f0-9]{64})$/
const DIGEST_PATTERN = /^sha256:([a-f0-9]{64})$/
const assetWriteQueues = new Map<string, Promise<unknown>>()

export type SessionAttachmentAssetRef = Readonly<{
  assetId: string
  digest: string
  size: number
}>

function digestBytes(bytes: Uint8Array): { hex: string; digest: string } {
  const hex = createHash("sha256").update(bytes).digest("hex")
  return { hex, digest: `sha256:${hex}` }
}

function assetPath(sessionDir: string, hex: string): string {
  return path.join(sessionDir, "conversation", "assets", `${hex}.asset`)
}

function assertAssetReference(assetId: string, digest: string): string {
  const assetMatch = ASSET_ID_PATTERN.exec(assetId)
  const digestMatch = DIGEST_PATTERN.exec(digest)
  if (!assetMatch || !digestMatch || assetMatch[1] !== digestMatch[1]) {
    throw new Error("attachment_asset_integrity_error: invalid asset reference")
  }
  return assetMatch[1]
}

async function queueAssetWrite<T>(filePath: string, action: () => Promise<T>): Promise<T> {
  const previous = assetWriteQueues.get(filePath) ?? Promise.resolve()
  const write = previous.catch(() => {}).then(action)
  assetWriteQueues.set(filePath, write)
  try {
    return await write
  } finally {
    if (assetWriteQueues.get(filePath) === write) assetWriteQueues.delete(filePath)
  }
}

export async function writeSessionAttachmentAsset(params: {
  sessionDir: string
  bytes: Uint8Array
}): Promise<SessionAttachmentAssetRef> {
  const bytes = Buffer.from(params.bytes)
  const { hex, digest } = digestBytes(bytes)
  const assetId = `attachment-sha256-${hex}`
  const filePath = assetPath(params.sessionDir, hex)
  await queueAssetWrite(filePath, async () => {
    await mkdir(path.dirname(filePath), { recursive: true })
    try {
      const handle = await open(filePath, "wx")
      try {
        await handle.writeFile(bytes)
      } finally {
        await handle.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error
      const existing = await readFile(filePath)
      const existingDigest = digestBytes(existing).digest
      if (existingDigest !== digest || existing.byteLength !== bytes.byteLength) {
        throw new Error("attachment_asset_integrity_error: existing asset is corrupt")
      }
    }
  })

  return { assetId, digest, size: bytes.byteLength }
}

export async function readSessionAttachmentAsset(params: {
  sessionDir: string
  assetId: string
  digest: string
  size?: number
}): Promise<Buffer> {
  const hex = assertAssetReference(params.assetId, params.digest)
  let bytes: Buffer
  try {
    bytes = await readFile(assetPath(params.sessionDir, hex))
  } catch {
    throw new Error(`attachment_asset_missing: ${params.assetId}`)
  }
  const actual = digestBytes(bytes).digest
  if (actual !== params.digest || (params.size !== undefined && bytes.byteLength !== params.size)) {
    throw new Error(`attachment_asset_integrity_error: ${params.assetId}`)
  }
  return bytes
}
