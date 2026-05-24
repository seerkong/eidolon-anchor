import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import type { StdInnerLogic } from "depa-processor"
import {
  stdMakeIdentityInnerConfig,
  stdMakeIdentityInnerInput,
  stdMakeIdentityInnerRuntime,
  stdMakeIdentityOuterOutput,
  stdMakeNullOuterComputed,
} from "depa-processor"
import { authorizeLocalToolCall } from "@cell/ai-organ-logic/permissions/LocalPermissionRuntime"
import { buildMultiFileUnifiedDiff, encodeFileEditResult } from "../_file-editing"
import { resolveToolPath } from "../_shared"
import type { ApplyPatchInnerConfig, ApplyPatchInnerInput, ApplyPatchInnerOutput, ApplyPatchInnerRuntime } from "./InnerTypes"

export const makeApplyPatchOuterComputed = stdMakeNullOuterComputed
export const makeApplyPatchInnerRuntime = stdMakeIdentityInnerRuntime
export const makeApplyPatchInnerInput = stdMakeIdentityInnerInput
export const makeApplyPatchInnerConfig = stdMakeIdentityInnerConfig
export const makeApplyPatchOuterOutput = stdMakeIdentityOuterOutput

type PatchPath = {
  raw: string
  absolute: string
}

type PatchHunk = {
  oldLines: string[]
  newLines: string[]
}

type PatchOp =
  | { kind: "add"; file: PatchPath; lines: string[] }
  | { kind: "delete"; file: PatchPath }
  | { kind: "update"; file: PatchPath; moveTo?: PatchPath; hunks: PatchHunk[] }

type FileSnapshot = {
  filePath: string
  before: string
  after: string
}

function summarizePatchLine(text: string, maxChars = 80): string {
  const compact = text.replace(/\s+/g, " ").trim()
  if (!compact) return ""
  if (compact.length <= maxChars) return compact
  return `${compact.slice(0, Math.max(0, maxChars - 1))}…`
}

function buildMissingHunkMessage(lines: string[], target: string[], filePath: string): string {
  const trimmedTarget = target
    .map((line) => line.trim())
    .filter(Boolean)
  const firstMeaningfulLine = trimmedTarget[0]
  if (firstMeaningfulLine && lines.some((line) => line.includes(firstMeaningfulLine))) {
    const preview = summarizePatchLine(firstMeaningfulLine)
    return preview
      ? `update hunk not found in ${filePath}; a similar line exists (${JSON.stringify(preview)}) but the full block does not match exactly`
      : `update hunk not found in ${filePath}; a similar line exists but the full block does not match exactly`
  }
  return `update hunk not found in ${filePath}`
}

function buildAmbiguousHunkMessage(target: string[], filePath: string): string {
  const firstMeaningfulLine = target
    .map((line) => line.trim())
    .find(Boolean)
  const preview = firstMeaningfulLine ? summarizePatchLine(firstMeaningfulLine) : ""
  return preview
    ? `update hunk is ambiguous in ${filePath}; multiple similar blocks match ${JSON.stringify(preview)}`
    : `update hunk is ambiguous in ${filePath}`
}

function primaryPatchFilePath(ops: PatchOp[]): string | undefined {
  if (ops.length !== 1) return undefined
  const [op] = ops
  if (op.kind === "add" || op.kind === "delete") return op.file.raw
  return op.moveTo?.raw ?? op.file.raw
}

function buildApplyPatchFailureSuggestions(detail: string): string[] {
  const normalized = detail.toLowerCase()
  if (normalized.includes("hunk not found")) {
    return [
      "Read the target file again and copy the exact current hunk, including unchanged context lines.",
      "Reduce the patch to a smaller single-hunk change after confirming the current file contents.",
      "If the file changed since the patch was drafted, rebuild the patch from a fresh read before retrying.",
    ]
  }
  if (normalized.includes("ambiguous")) {
    return [
      "Read the file again and include more unchanged context so the target hunk is unique.",
      "Reduce the patch to a smaller single-location change instead of patching repeated similar blocks.",
      "If multiple similar blocks exist, patch one exact block at a time after a fresh reread.",
    ]
  }
  if (normalized.includes("*** begin patch") || normalized.includes("unrecognized patch directive") || normalized.includes("patch must")) {
    return [
      "Use the exact apply_patch envelope with *** Begin Patch and *** End Patch.",
      "For updates, include a matching *** Update File line and at least one @@ hunk.",
      "If formatting keeps failing, reread the target file and rebuild a smaller patch from scratch.",
    ]
  }
  return [
    "Read the target file again and copy the exact current hunk before retrying.",
    "Reduce the patch to a smaller single-file or single-hunk change.",
    "If the target block moved or changed, rebuild the patch from a fresh read of the file.",
  ]
}

function normalizePatchTarget(workdir: string, filePath: string): PatchPath {
  const trimmed = filePath.trim()
  if (!trimmed) {
    throw new Error(`invalid patch path: ${filePath}`)
  }
  return {
    raw: trimmed,
    absolute: resolveToolPath(workdir, trimmed),
  }
}

function parsePatch(patchText: string, workdir: string): PatchOp[] {
  const lines = patchText.replace(/\r\n/g, "\n").split("\n")
  if (lines[0] !== "*** Begin Patch") {
    throw new Error("patch must start with *** Begin Patch")
  }
  const ops: PatchOp[] = []
  let i = 1

  while (i < lines.length) {
    const line = lines[i]
    if (line === "*** End Patch") {
      return ops
    }
    if (line.startsWith("*** Add File: ")) {
      const file = normalizePatchTarget(workdir, line.slice("*** Add File: ".length))
      i += 1
      const content: string[] = []
      while (i < lines.length && !lines[i].startsWith("*** ")) {
        const row = lines[i] ?? ""
        if (row === "*** End of File") {
          i += 1
          continue
        }
        if (!row.startsWith("+")) throw new Error(`add file lines must start with + (${file.raw})`)
        content.push(row.slice(1))
        i += 1
      }
      ops.push({ kind: "add", file, lines: content })
      continue
    }
    if (line.startsWith("*** Delete File: ")) {
      ops.push({ kind: "delete", file: normalizePatchTarget(workdir, line.slice("*** Delete File: ".length)) })
      i += 1
      continue
    }
    if (line.startsWith("*** Update File: ")) {
      const file = normalizePatchTarget(workdir, line.slice("*** Update File: ".length))
      i += 1
      let moveTo: PatchPath | undefined
      if (i < lines.length && lines[i].startsWith("*** Move to: ")) {
        moveTo = normalizePatchTarget(workdir, lines[i].slice("*** Move to: ".length))
        i += 1
      }
      const hunks: Array<{ oldLines: string[]; newLines: string[] }> = []
      while (i < lines.length && !lines[i].startsWith("*** ")) {
        if (!lines[i].startsWith("@@")) {
          i += 1
          continue
        }
        i += 1
        const oldLines: string[] = []
        const newLines: string[] = []
        while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("*** ")) {
          const row = lines[i] ?? ""
          if (row === "*** End of File") {
            i += 1
            continue
          }
          if (row.startsWith("-")) {
            oldLines.push(row.slice(1))
          } else if (row.startsWith("+")) {
            newLines.push(row.slice(1))
          } else if (row.startsWith(" ")) {
            oldLines.push(row.slice(1))
            newLines.push(row.slice(1))
          } else if (row.length === 0) {
            oldLines.push("")
            newLines.push("")
          }
          i += 1
        }
        hunks.push({ oldLines, newLines })
      }
      ops.push({ kind: "update", file, moveTo, hunks })
      continue
    }
    throw new Error(`unrecognized patch directive: ${line}`)
  }

  throw new Error("patch must end with *** End Patch")
}

async function applyAdd(op: Extract<PatchOp, { kind: "add" }>): Promise<FileSnapshot> {
  const abs = op.file.absolute
  await mkdir(path.dirname(abs), { recursive: true })
  const after = op.lines.join("\n")
  await writeFile(abs, after, "utf-8")
  return {
    filePath: op.file.raw,
    before: "",
    after,
  }
}

async function applyDelete(op: Extract<PatchOp, { kind: "delete" }>): Promise<FileSnapshot> {
  const abs = op.file.absolute
  const before = await readFile(abs, "utf-8")
  await rm(abs, { force: true })
  return {
    filePath: op.file.raw,
    before,
    after: "",
  }
}

function detectDominantNewline(content: string): "\n" | "\r\n" {
  return content.includes("\r\n") ? "\r\n" : "\n"
}

function restoreNewlineStyle(content: string, newline: "\n" | "\r\n"): string {
  return newline === "\n" ? content : content.replace(/\n/g, "\r\n")
}

function findLineBlock(lines: string[], target: string[], startIndex: number): number {
  if (target.length === 0) return startIndex
  for (let index = Math.max(0, startIndex); index <= lines.length - target.length; index += 1) {
    let matched = true
    for (let offset = 0; offset < target.length; offset += 1) {
      if (lines[index + offset] !== target[offset]) {
        matched = false
        break
      }
    }
    if (matched) return index
  }
  return -1
}

function hasAnotherLineBlock(lines: string[], target: string[], firstIndex: number): boolean {
  if (target.length === 0) return false
  return findLineBlock(lines, target, firstIndex + 1) >= 0
}

function applyHunksToText(content: string, hunks: PatchHunk[], filePath: string): string {
  const normalizedContent = content.replace(/\r\n/g, "\n")
  const dominantNewline = detectDominantNewline(content)
  let lines = normalizedContent.split("\n")
  let cursor = 0

  for (const hunk of hunks) {
    const found = findLineBlock(lines, hunk.oldLines, cursor)
    const start = found >= 0 ? found : findLineBlock(lines, hunk.oldLines, 0)
    if (start < 0) {
      throw new Error(buildMissingHunkMessage(lines, hunk.oldLines, filePath))
    }
    if (found < 0 && hasAnotherLineBlock(lines, hunk.oldLines, start)) {
      throw new Error(buildAmbiguousHunkMessage(hunk.oldLines, filePath))
    }
    lines.splice(start, hunk.oldLines.length, ...hunk.newLines)
    cursor = start + hunk.newLines.length
  }

  return restoreNewlineStyle(lines.join("\n"), dominantNewline)
}

async function applyUpdate(op: Extract<PatchOp, { kind: "update" }>): Promise<FileSnapshot[]> {
  const abs = op.file.absolute
  const before = await readFile(abs, "utf-8")
  const after = applyHunksToText(before, op.hunks, op.file.raw)

  if (op.moveTo && op.moveTo.absolute !== abs) {
    await mkdir(path.dirname(op.moveTo.absolute), { recursive: true })
    await writeFile(op.moveTo.absolute, after, "utf-8")
    await rm(abs, { force: true })
    return [
      {
        filePath: op.file.raw,
        before,
        after: "",
      },
      {
        filePath: op.moveTo.raw,
        before: "",
        after,
      },
    ]
  }

  await writeFile(abs, after, "utf-8")
  return [
    {
      filePath: op.file.raw,
      before,
      after,
    },
  ]
}

function ensurePatchPermissions(runtime: ApplyPatchInnerRuntime, ops: PatchOp[]): string | null {
  for (const op of ops) {
    const targets =
      op.kind === "update" && op.moveTo
        ? [op.file.raw, op.moveTo.raw]
        : [op.file.raw]
    for (const filePath of targets) {
      const permission = authorizeLocalToolCall(runtime, "apply_patch", { filePath })
      if (!permission.ok) {
        return permission.output
      }
    }
  }
  return null
}

export const applyPatchCoreLogic: StdInnerLogic<
  ApplyPatchInnerRuntime,
  ApplyPatchInnerInput,
  ApplyPatchInnerConfig,
  ApplyPatchInnerOutput
> = async (runtime, input, _config) => {
  const workdir = runtime.vm.outerCtx.workDir
  if (typeof workdir !== "string" || !workdir.trim()) return "Error: workDir not configured"
  const patchText = String(input?.patchText ?? "")
  if (!patchText.trim()) return "Error: patchText is required"
  let ops: PatchOp[] = []

  try {
    ops = parsePatch(patchText, workdir)
    const permissionError = ensurePatchPermissions(runtime, ops)
    if (permissionError) return permissionError

    const snapshots: FileSnapshot[] = []
    for (const op of ops) {
      if (op.kind === "add") snapshots.push(await applyAdd(op))
      if (op.kind === "delete") snapshots.push(await applyDelete(op))
      if (op.kind === "update") snapshots.push(...(await applyUpdate(op)))
    }
    return encodeFileEditResult({
      message: `Patch applied successfully (${ops.length} operation${ops.length === 1 ? "" : "s"}).`,
      diff: buildMultiFileUnifiedDiff(snapshots),
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const filePath = primaryPatchFilePath(ops)
    return encodeFileEditResult({
      message: filePath
        ? `Patch could not be applied to ${filePath}: ${detail}`
        : `Patch could not be applied: ${detail}`,
      filePath,
      error: "patch_failed",
      detail,
      suggestions: buildApplyPatchFailureSuggestions(detail),
    })
  }
}
