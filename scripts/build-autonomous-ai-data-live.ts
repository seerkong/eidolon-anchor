#!/usr/bin/env bun

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const workspaceRoot = path.resolve(import.meta.dir, "..")
const entrypoint = path.join(workspaceRoot, "scripts", "run-autonomous-ai-data-live.ts")
const outfileIndex = process.argv.indexOf("--outfile")
const requestedOutput = outfileIndex >= 0 ? process.argv[outfileIndex + 1] : undefined
if (outfileIndex >= 0 && !requestedOutput) throw new Error("LIVE_RUNNER_OUTFILE_MISSING")
const outputPath = path.resolve(requestedOutput ?? ".tmp/autonomous-ai-data-live/runner.js")
const runnerSource = await readFile(entrypoint, "utf8")
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-autonomous-live-build-"))
const bundlePath = path.join(temporaryRoot, "runner.mjs")

try {
  const bundle = await Bun.build({
    entrypoints: [entrypoint],
    target: "bun",
    format: "esm",
    define: {
      AUTONOMOUS_PLANNING_LIVE_RUNNER_SOURCE: JSON.stringify(runnerSource),
    },
  })
  const bundleArtifact = bundle.outputs.find((output) => output.kind === "entry-point") ?? bundle.outputs[0]
  if (!bundle.success || !bundleArtifact) {
    throw new Error(`LIVE_RUNNER_BUNDLE_FAILED: ${bundle.logs.map(String).join("\n")}`)
  }
  await Bun.write(bundlePath, bundleArtifact)
  await mkdir(path.dirname(outputPath), { recursive: true })
  const compile = Bun.spawn([
    process.execPath,
    "build",
    "--compile",
    "--target",
    "bun",
    "--outfile",
    outputPath,
    bundlePath,
  ], {
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await compile.exited
  if (exitCode !== 0) throw new Error(`LIVE_RUNNER_COMPILE_FAILED: exit ${exitCode}`)
  process.stdout.write(`${JSON.stringify({ accepted: true, entrypoint, outputPath }, null, 2)}\n`)
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
