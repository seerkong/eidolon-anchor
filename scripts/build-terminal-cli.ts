import { mkdir } from "fs/promises"
import path from "path"

const outDir = path.resolve("dist", "terminal", "cli")
const isWindows = process.platform === "win32"
const binaryName = isWindows ? "eidolon.exe" : "eidolon"
const outFile = path.join(outDir, binaryName)

await mkdir(outDir, { recursive: true })

const proc = Bun.spawn(
  [
    "bun",
    "build",
    "--compile",
    "--target",
    "bun",
    "--outfile",
    outFile,
    path.resolve("terminal", "packages", "cli", "src", "headless-main.ts"),
  ],
  {
    cwd: path.resolve("."),
    stdio: ["ignore", "inherit", "inherit"],
  },
)

const exitCode = await proc.exited
if (exitCode !== 0) {
  process.exit(exitCode)
}
