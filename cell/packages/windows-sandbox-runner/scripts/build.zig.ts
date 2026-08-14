#!/usr/bin/env bun
/**
 * Build the Zig Windows sandbox runner and setup helpers.
 *
 * Runs `zig build` in the package dir, then copies the two executables into
 * `dist/`. The `EIDOLON_ZIG` env var overrides the zig executable path.
 */

import { copyFileSync, mkdirSync } from "fs"
import { join, resolve } from "path"

const packageRoot = resolve(import.meta.dir, "..")
const zigExe = process.env.EIDOLON_ZIG || "zig"

const proc = Bun.spawn([zigExe, "build"], {
  cwd: packageRoot,
  stdio: ["ignore", "inherit", "inherit"],
})

const exitCode = await proc.exited
if (exitCode !== 0) {
  console.error(`zig build failed (exit ${exitCode})`)
  process.exit(exitCode)
}

const zigOutBin = join(packageRoot, "zig-out", "bin")
const distDir = join(packageRoot, "dist")
mkdirSync(distDir, { recursive: true })

const targets = [
  "eidolon-windows-sandbox-runner.exe",
  "eidolon-windows-sandbox-setup.exe",
]
for (const name of targets) {
  copyFileSync(join(zigOutBin, name), join(distDir, name))
  console.log(`  built ${join(distDir, name)}`)
}
console.log("Zig sandbox helpers built.")
