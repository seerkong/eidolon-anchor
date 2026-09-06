import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { cp, lstat, mkdir, mkdtemp, readdir, realpath } from "node:fs/promises"
import { basename, join, resolve } from "node:path"

export async function fingerprintScene(directory: string) {
  const files: Array<{ path: string; bytes: number; sha256: string }> = []
  async function visit(relative = "") {
    for (const entry of (await readdir(join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(relative, entry.name)
      if (entry.isSymbolicLink()) throw new Error("Scene must not contain symlinks")
      if (entry.isDirectory()) { await visit(path); continue }
      if (!entry.isFile()) throw new Error("Scene must contain only regular files/directories")
      const hash = createHash("sha256")
      let bytes = 0
      for await (const chunk of createReadStream(join(directory, path))) { bytes += chunk.length; hash.update(chunk) }
      files.push({ path, bytes, sha256: hash.digest("hex") })
    }
  }
  await visit()
  return { files, digest: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    bytes: files.reduce((total, file) => total + file.bytes, 0) }
}

export async function copyScrollScene(sourcePath: string) {
  const source = await realpath(sourcePath)
  if (!(await lstat(join(source, "conversation/history.xnl"))).isFile()) throw new Error("Missing scene history")
  const before = await fingerprintScene(source)
  const temporaryRoot = resolve(import.meta.dir, "../.tmp")
  await mkdir(temporaryRoot, { recursive: true })
  const directory = await mkdtemp(join(temporaryRoot, "scroll-scene-"))
  const sessionID = basename(source)
  const sessionDir = join(directory, ".eidolon/sessions", sessionID)
  await cp(source, sessionDir, { recursive: true, errorOnExist: true, force: false })
  const copied = await fingerprintScene(sessionDir)
  const after = await fingerprintScene(source)
  if (before.digest !== copied.digest || before.digest !== after.digest) throw new Error("Scene changed while copying; do not use this snapshot")
  return { source, directory, sessionID, sessionDir, fingerprint: before }
}
