import { spawnSync } from "node:child_process"
import { readdirSync } from "node:fs"
import path from "node:path"

const preload = "./src/entry/preload.ts"
const baseArgs = ["test", "--preload", preload, "--max-concurrency", "1"]
const patterns = Bun.argv.slice(2)

function collectTestFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory()) return collectTestFiles(entryPath)
      if (!entry.isFile()) return []
      if (!entry.name.endsWith(".test.ts") && !entry.name.endsWith(".test.tsx")) return []
      return [entryPath]
    })
    .sort((a, b) => a.localeCompare(b))
}

function runTest(args: string[]) {
  const result = spawnSync("bun", args, {
    cwd: process.cwd(),
    stdio: "inherit",
  })

  if (result.error) {
    throw result.error
  }

  return result.status ?? 1
}

if (patterns.length === 0) {
  for (const testFile of collectTestFiles("./tests")) {
    const exitCode = runTest([...baseArgs, testFile])
    if (exitCode !== 0) {
      process.exit(exitCode)
    }
  }
  process.exit(0)
}

for (const pattern of patterns) {
  const exitCode = runTest([...baseArgs, pattern])
  if (exitCode !== 0) {
    process.exit(exitCode)
  }
}
