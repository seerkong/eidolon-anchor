import { createHash } from "node:crypto"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
if (args.length !== 2 || args[0] !== "--from") throw new Error("Usage: bun run prepare:holon-candidates --from <tarball-directory>")
const source = path.resolve(args[1]!)
const lock = JSON.parse(await readFile(path.join(root, "holon-candidates.json"), "utf8")) as {
  schema: string; packages: { name: string; version: string; sha256: string }[]
}
if (lock.schema !== "eidolon.holon-candidates/v1") throw new Error("Unsupported Holon candidate lock")
// Validate the entire input before replacing any generated candidate package.
const inputs = await Promise.all(lock.packages.map(async item => {
  if (!/^[a-z][a-z0-9.-]+$/.test(item.name) || !/^\d+\.\d+\.\d+$/.test(item.version)) throw new Error("Invalid candidate identity")
  const filename = `${item.name}-${item.version}.tgz`
  const bytes = await readFile(path.join(source, filename))
  if (createHash("sha256").update(bytes).digest("hex") !== item.sha256) throw new Error(`Candidate digest mismatch: ${item.name}`)
  return { ...item, filename, bytes }
}))
const cache = path.join(root, ".tmp/g8-candidates")
await mkdir(path.join(cache, "tarballs"), { recursive: true })
for (const item of inputs) {
  const tarball = path.join(cache, "tarballs", item.filename)
  await writeFile(tarball, item.bytes)
  const list = Bun.spawn(["tar", "-tzf", tarball], { stdout: "pipe", stderr: "pipe" })
  const [exitCode, paths] = await Promise.all([list.exited, new Response(list.stdout).text()])
  if (exitCode !== 0 || paths.trim().split("\n").some(name => !name.startsWith("package/") || name.split("/").includes(".."))) throw new Error(`Invalid tarball paths: ${item.name}`)
  const directory = path.join(cache, "packages", item.name)
  await rm(directory, { recursive: true, force: true })
  await mkdir(directory, { recursive: true })
  const extract = Bun.spawn(["tar", "-xzf", tarball, "--strip-components=1", "-C", directory], { stdout: "ignore", stderr: "pipe" })
  if (await extract.exited !== 0) throw new Error(`Candidate extraction failed: ${item.name}`)
  const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"))
  if (manifest.name !== item.name || manifest.version !== item.version) throw new Error(`Candidate manifest mismatch: ${item.name}`)
}
process.stdout.write(`${JSON.stringify({ candidatePackages: inputs.length, verified: true, next: "bun install --frozen-lockfile" })}\n`)
