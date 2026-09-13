import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const workspaceRoot = path.resolve(import.meta.dir, "..")
const compilerRoot = process.env.HALFCODE_COMPILER_REPO
const candidateDirectory = path.join(workspaceRoot, ".tmp", "candidates", "packages")
const candidatePackageRoot = path.join(candidateDirectory, "halfcode-compiler.xnl")
const packageName = "halfcode-compiler.xnl-0.3.2-eidolon-trusted-kinds.0.tgz"

async function run(command: readonly string[], cwd: string): Promise<void> {
  const process = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" })
  if (await process.exited !== 0) throw new Error(`Command failed: ${command.join(" ")}`)
}

async function main(): Promise<void> {
  if (!compilerRoot) {
    throw new Error("HALFCODE_COMPILER_REPO must name the checked-out halfcode-compiler.xnl source repository")
  }
  await run(["bun", "run", "build:package"], compilerRoot)
  const distributionRoot = path.join(compilerRoot, "packages", "distribution")
  await run(["bun", "pm", "pack"], distributionRoot)
  const packed = (await readdir(distributionRoot)).find(name => name === packageName)
  if (!packed) throw new Error(`Expected ${packageName} after packing ${compilerRoot}`)
  const extractRoot = await mkdtemp(path.join(os.tmpdir(), "halfcode-trusted-kinds-"))
  try {
    await run(["tar", "-xzf", path.join(distributionRoot, packed), "-C", extractRoot], compilerRoot)
    await mkdir(candidateDirectory, { recursive: true })
    await rm(candidatePackageRoot, { recursive: true, force: true })
    await cp(path.join(extractRoot, "package"), candidatePackageRoot, { recursive: true })
    // The packed framework keeps build-only workspace devDependencies.  The
    // candidate is consumed as a runtime package, so prune those unavailable
    // private package names while retaining the packed production bytes.
    const manifestPath = path.join(candidatePackageRoot, "package.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>
    delete manifest.devDependencies
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  } finally {
    await rm(extractRoot, { recursive: true, force: true })
  }
  process.stdout.write(`${candidatePackageRoot}\n`)
}

if (import.meta.main) await main()
