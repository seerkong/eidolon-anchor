import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
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

type PatchLine =
  | { type: "context"; value: string }
  | { type: "add"; value: string }
  | { type: "remove"; value: string }

type MatchMode = "exact" | "anchored_exact" | "normalized" | "fuzzy"

type PatchHunk = {
  anchors: string[]
  lines: PatchLine[]
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

type AppliedHunks = {
  next: string
  matchModes: MatchMode[]
}

type StagedPatchPlan = {
  snapshots: FileSnapshot[]
  writes: Array<{ absolute: string; content: string }>
  deletes: string[]
  touchedFiles: string[]
  touchedFilesAbsolute: string[]
  addedCount: number
  updatedCount: number
  deletedCount: number
  movedCount: number
  matchModesUsed: MatchMode[]
}

function summarizePatchLine(text: string, maxChars = 80): string {
  const compact = text.replace(/\s+/g, " ").trim()
  if (!compact) return ""
  if (compact.length <= maxChars) return compact
  return `${compact.slice(0, Math.max(0, maxChars - 1))}…`
}

function hunkOldLines(hunk: PatchHunk): string[] {
  return hunk.lines.filter((line) => line.type !== "add").map((line) => line.value)
}

function hunkNewLines(hunk: PatchHunk): string[] {
  return hunk.lines.filter((line) => line.type !== "remove").map((line) => line.value)
}

function hunkLabel(hunk: PatchHunk): string {
  return hunk.anchors.filter(Boolean).join(" -> ") || "unnamed hunk"
}

function buildMissingHunkMessage(lines: string[], target: string[], filePath: string, hunk: PatchHunk): string {
  const trimmedTarget = target
    .map((line) => line.trim())
    .filter(Boolean)
  const firstMeaningfulLine = trimmedTarget[0]
  const label = hunkLabel(hunk)
  if (firstMeaningfulLine) {
    const nearestIndex = lines.findIndex((line) => line.includes(firstMeaningfulLine) || line.trim().includes(firstMeaningfulLine))
    if (nearestIndex >= 0) {
      const preview = summarizePatchLine(lines[nearestIndex])
      return `update hunk not found in ${filePath} (${label}); expected ${JSON.stringify(summarizePatchLine(firstMeaningfulLine))}; nearest current line ${nearestIndex + 1}: ${JSON.stringify(preview)}`
    }
  }
  return `update hunk not found in ${filePath} (${label}); expected ${JSON.stringify(target.map((line) => summarizePatchLine(line)).filter(Boolean).slice(0, 3).join(" / "))}`
}

function buildAmbiguousHunkMessage(target: string[], filePath: string, hunk: PatchHunk, mode: MatchMode, count: number): string {
  const firstMeaningfulLine = target
    .map((line) => line.trim())
    .find(Boolean)
  const preview = firstMeaningfulLine ? summarizePatchLine(firstMeaningfulLine) : ""
  return preview
    ? `update hunk is ambiguous in ${filePath} (${hunkLabel(hunk)}); ${mode} matched ${count} candidate locations for ${JSON.stringify(preview)}`
    : `update hunk is ambiguous in ${filePath} (${hunkLabel(hunk)}); ${mode} matched ${count} candidate locations`
}

function primaryPatchFilePath(ops: PatchOp[]): string | undefined {
  if (ops.length !== 1) return undefined
  const [op] = ops
  if (op.kind === "add" || op.kind === "delete") return op.file.raw
  return op.moveTo?.raw ?? op.file.raw
}

function buildApplyPatchFailureSuggestions(detail: string): string[] {
  const normalized = detail.toLowerCase()
  if (normalized.includes("hunk not found") || normalized.includes("anchor not found")) {
    return [
      "Read the target file again and copy the exact current hunk, including unchanged context lines.",
      "Reduce the patch to a smaller single-hunk change after confirming the current file contents.",
      "Use a named @@ anchor such as @@ def methodName or @@ class TypeName to locate the intended region.",
      "If the file changed since the patch was drafted, rebuild the patch from a fresh read before retrying.",
    ]
  }
  if (normalized.includes("ambiguous")) {
    return [
      "Read the file again and include more unchanged context so the target hunk is unique.",
      "Add a named @@ anchor near the intended block before retrying.",
      "Reduce the patch to a smaller single-location change instead of patching repeated similar blocks.",
    ]
  }
  if (normalized.includes("*** begin patch") || normalized.includes("unrecognized patch directive") || normalized.includes("patch must")) {
    return [
      "Use the exact apply_patch envelope with *** Begin Patch and *** End Patch.",
      "For updates, include a matching *** Update File line and at least one @@ hunk unless the update only moves the file.",
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

function parseAddFile(lines: string[], index: number, file: PatchPath): { nextIndex: number; content: string[] } {
  const content: string[] = []
  let i = index
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
  return { nextIndex: i, content }
}

function parseUpdateFile(lines: string[], index: number, workdir: string, file: PatchPath): { nextIndex: number; moveTo?: PatchPath; hunks: PatchHunk[] } {
  let i = index
  let moveTo: PatchPath | undefined
  if (i < lines.length && lines[i].startsWith("*** Move to: ")) {
    moveTo = normalizePatchTarget(workdir, lines[i].slice("*** Move to: ".length))
    i += 1
  }

  const hunks: PatchHunk[] = []
  while (i < lines.length && !lines[i].startsWith("*** ")) {
    const anchors: string[] = []
    while (i < lines.length && lines[i].startsWith("@@")) {
      anchors.push(lines[i].slice(2).trim())
      i += 1
    }
    if (anchors.length === 0) {
      throw new Error(`update patch for ${file.raw} must start hunks with @@`)
    }

    const hunkLines: PatchLine[] = []
    while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("*** ")) {
      const row = lines[i] ?? ""
      if (row === "*** End of File") {
        i += 1
        continue
      }
      if (row.startsWith("-")) hunkLines.push({ type: "remove", value: row.slice(1) })
      else if (row.startsWith("+")) hunkLines.push({ type: "add", value: row.slice(1) })
      else if (row.startsWith(" ")) hunkLines.push({ type: "context", value: row.slice(1) })
      else if (row.length === 0) hunkLines.push({ type: "context", value: "" })
      else throw new Error(`invalid hunk line in ${file.raw}: ${row}`)
      i += 1
    }
    if (hunkLines.length === 0) throw new Error(`update hunk for ${file.raw} has no body lines`)
    hunks.push({ anchors, lines: hunkLines })
  }

  if (!moveTo && hunks.length === 0) throw new Error(`update patch for ${file.raw} must include at least one hunk`)
  return { nextIndex: i, moveTo, hunks }
}

function parsePatch(patchText: string, workdir: string): PatchOp[] {
  const lines = patchText.replace(/\r\n/g, "\n").split("\n")
  if (lines[0] !== "*** Begin Patch") {
    throw new Error("patch must start with *** Begin Patch")
  }
  const ops: PatchOp[] = []
  let i = 1
  let ended = false

  while (i < lines.length) {
    const line = lines[i]
    if (line === "*** End Patch") {
      ended = true
      i += 1
      break
    }
    if (line.startsWith("*** Add File: ")) {
      const file = normalizePatchTarget(workdir, line.slice("*** Add File: ".length))
      const parsed = parseAddFile(lines, i + 1, file)
      ops.push({ kind: "add", file, lines: parsed.content })
      i = parsed.nextIndex
      continue
    }
    if (line.startsWith("*** Delete File: ")) {
      ops.push({ kind: "delete", file: normalizePatchTarget(workdir, line.slice("*** Delete File: ".length)) })
      i += 1
      continue
    }
    if (line.startsWith("*** Update File: ")) {
      const file = normalizePatchTarget(workdir, line.slice("*** Update File: ".length))
      const parsed = parseUpdateFile(lines, i + 1, workdir, file)
      ops.push({ kind: "update", file, moveTo: parsed.moveTo, hunks: parsed.hunks })
      i = parsed.nextIndex
      continue
    }
    if (line.trim() === "") {
      i += 1
      continue
    }
    throw new Error(`unrecognized patch directive: ${line}`)
  }

  if (!ended) throw new Error("patch must end with *** End Patch")
  const trailing = lines.slice(i).filter((line) => line.trim().length > 0)
  if (trailing.length > 0) throw new Error("patch must not contain content after *** End Patch")
  if (ops.length === 0) throw new Error("patch must contain at least one file operation")
  return ops
}

function detectDominantNewline(content: string): "\n" | "\r\n" {
  return content.includes("\r\n") ? "\r\n" : "\n"
}

function restoreNewlineStyle(content: string, newline: "\n" | "\r\n"): string {
  return newline === "\n" ? content : content.replace(/\n/g, "\r\n")
}

function lineMatches(a: string, b: string, mode: MatchMode): boolean {
  if (mode === "exact" || mode === "anchored_exact") return a === b
  if (mode === "normalized") return a.replace(/\s+$/g, "") === b.replace(/\s+$/g, "")
  return a.replace(/\s+/g, "") === b.replace(/\s+/g, "")
}

function lineBlockMatches(lines: string[], target: string[], index: number, mode: MatchMode): boolean {
  if (target.length === 0) return true
  if (index < 0 || index + target.length > lines.length) return false
  for (let offset = 0; offset < target.length; offset += 1) {
    if (!lineMatches(lines[index + offset], target[offset], mode)) return false
  }
  return true
}

function findLineBlock(lines: string[], target: string[], startIndex: number, mode: MatchMode): number {
  if (target.length === 0) return Math.max(0, Math.min(startIndex, lines.length))
  for (let index = Math.max(0, startIndex); index <= lines.length - target.length; index += 1) {
    if (lineBlockMatches(lines, target, index, mode)) return index
  }
  return -1
}

function findAllLineBlocks(lines: string[], target: string[], startIndex: number, mode: MatchMode): number[] {
  if (target.length === 0) return [Math.max(0, Math.min(startIndex, lines.length))]
  const indexes: number[] = []
  for (let index = Math.max(0, startIndex); index <= lines.length - target.length; index += 1) {
    if (lineBlockMatches(lines, target, index, mode)) indexes.push(index)
  }
  return indexes
}

function resolveAnchorStart(lines: string[], anchors: string[], filePath: string): number {
  let start = 0
  for (const anchor of anchors) {
    if (!anchor) continue
    const found = lines.findIndex((line, index) => index >= start && line.includes(anchor))
    if (found < 0) throw new Error(`anchor not found in ${filePath}: ${anchor}`)
    start = found + 1
  }
  return start
}

function chooseUniqueFuzzyCandidate(lines: string[], oldLines: string[], start: number, mode: MatchMode, filePath: string, hunk: PatchHunk): { index: number; mode: MatchMode } | null {
  const candidates = findAllLineBlocks(lines, oldLines, start, mode)
  if (candidates.length === 1) return { index: candidates[0], mode }
  if (candidates.length > 1) throw new Error(buildAmbiguousHunkMessage(oldLines, filePath, hunk, mode, candidates.length))
  return null
}

function findHunkLocation(lines: string[], hunk: PatchHunk, cursor: number, filePath: string): { index: number; mode: MatchMode } {
  const oldLines = hunkOldLines(hunk)
  const hasAnchors = hunk.anchors.some((anchor) => anchor.length > 0)
  const anchorStart = hasAnchors ? resolveAnchorStart(lines, hunk.anchors, filePath) : cursor

  if (hasAnchors) {
    const anchored = findLineBlock(lines, oldLines, anchorStart, "anchored_exact")
    if (anchored >= 0) return { index: anchored, mode: "anchored_exact" }
  } else {
    const exactFromCursor = findLineBlock(lines, oldLines, cursor, "exact")
    if (exactFromCursor >= 0) return { index: exactFromCursor, mode: "exact" }
    const exactFromTop = findLineBlock(lines, oldLines, 0, "exact")
    if (exactFromTop >= 0) return { index: exactFromTop, mode: "exact" }
  }

  const normalized = chooseUniqueFuzzyCandidate(lines, oldLines, anchorStart, "normalized", filePath, hunk)
  if (normalized) return normalized
  const fuzzy = chooseUniqueFuzzyCandidate(lines, oldLines, anchorStart, "fuzzy", filePath, hunk)
  if (fuzzy) return fuzzy
  throw new Error(buildMissingHunkMessage(lines, oldLines, filePath, hunk))
}

function applyHunksToText(content: string, hunks: PatchHunk[], filePath: string): AppliedHunks {
  const normalizedContent = content.replace(/\r\n/g, "\n")
  const dominantNewline = detectDominantNewline(content)
  const matchModes: MatchMode[] = []
  let lines = normalizedContent.split("\n")
  let cursor = 0

  for (const hunk of hunks) {
    const oldLines = hunkOldLines(hunk)
    const newLines = hunkNewLines(hunk)
    const location = findHunkLocation(lines, hunk, cursor, filePath)
    lines.splice(location.index, oldLines.length, ...newLines)
    matchModes.push(location.mode)
    cursor = location.index + newLines.length
  }

  return { next: restoreNewlineStyle(lines.join("\n"), dominantNewline), matchModes }
}

async function maybeStat(filePath: string) {
  try {
    return await stat(filePath)
  } catch (error: any) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

function renderAddedFile(lines: string[]): string {
  if (lines.length === 0) return ""
  return `${lines.join("\n")}\n`
}

function pushUnique<T>(items: T[], item: T) {
  if (!items.includes(item)) items.push(item)
}

function addTouched(plan: StagedPatchPlan, file: PatchPath) {
  pushUnique(plan.touchedFiles, file.raw)
  pushUnique(plan.touchedFilesAbsolute, file.absolute)
}

async function ensureNoDuplicateTouchedPaths(ops: PatchOp[]) {
  const seen = new Set<string>()
  for (const op of ops) {
    const paths = op.kind === "update" && op.moveTo && op.moveTo.absolute !== op.file.absolute ? [op.file, op.moveTo] : [op.file]
    for (const file of paths) {
      const key = path.resolve(file.absolute)
      if (seen.has(key)) throw new Error(`duplicate patch path: ${file.raw}`)
      seen.add(key)
    }
  }
}

async function buildStagedPatchPlan(ops: PatchOp[]): Promise<StagedPatchPlan> {
  await ensureNoDuplicateTouchedPaths(ops)
  const plan: StagedPatchPlan = {
    snapshots: [],
    writes: [],
    deletes: [],
    touchedFiles: [],
    touchedFilesAbsolute: [],
    addedCount: 0,
    updatedCount: 0,
    deletedCount: 0,
    movedCount: 0,
    matchModesUsed: [],
  }

  for (const op of ops) {
    if (op.kind === "add") {
      const targetStat = await maybeStat(op.file.absolute)
      if (targetStat) throw new Error(`add target already exists: ${op.file.raw}`)
      const after = renderAddedFile(op.lines)
      plan.snapshots.push({ filePath: op.file.raw, before: "", after })
      plan.writes.push({ absolute: op.file.absolute, content: after })
      addTouched(plan, op.file)
      plan.addedCount += 1
      continue
    }

    if (op.kind === "delete") {
      const targetStat = await maybeStat(op.file.absolute)
      if (!targetStat) throw new Error(`delete target does not exist: ${op.file.raw}`)
      if (targetStat.isDirectory()) throw new Error(`delete target is a directory: ${op.file.raw}`)
      const before = await readFile(op.file.absolute, "utf-8")
      plan.snapshots.push({ filePath: op.file.raw, before, after: "" })
      plan.deletes.push(op.file.absolute)
      addTouched(plan, op.file)
      plan.deletedCount += 1
      continue
    }

    const sourceStat = await maybeStat(op.file.absolute)
    if (!sourceStat) throw new Error(`update target does not exist: ${op.file.raw}`)
    if (sourceStat.isDirectory()) throw new Error(`update target is a directory: ${op.file.raw}`)
    if (op.moveTo && op.moveTo.absolute !== op.file.absolute) {
      const destinationStat = await maybeStat(op.moveTo.absolute)
      if (destinationStat) throw new Error(`move destination already exists: ${op.moveTo.raw}`)
    }

    const before = await readFile(op.file.absolute, "utf-8")
    const applied = applyHunksToText(before, op.hunks, op.file.raw)
    for (const mode of applied.matchModes) pushUnique(plan.matchModesUsed, mode)

    if (op.moveTo && op.moveTo.absolute !== op.file.absolute) {
      plan.snapshots.push({ filePath: op.file.raw, before, after: "" }, { filePath: op.moveTo.raw, before: "", after: applied.next })
      plan.writes.push({ absolute: op.moveTo.absolute, content: applied.next })
      plan.deletes.push(op.file.absolute)
      addTouched(plan, op.file)
      addTouched(plan, op.moveTo)
      plan.movedCount += 1
      continue
    }

    plan.snapshots.push({ filePath: op.file.raw, before, after: applied.next })
    plan.writes.push({ absolute: op.file.absolute, content: applied.next })
    addTouched(plan, op.file)
    plan.updatedCount += 1
  }

  return plan
}

async function commitStagedPatchPlan(plan: StagedPatchPlan): Promise<void> {
  for (const write of plan.writes) {
    await mkdir(path.dirname(write.absolute), { recursive: true })
    await writeFile(write.absolute, write.content, "utf-8")
  }
  for (const filePath of plan.deletes) {
    await rm(filePath, { force: true })
  }
}

function ensurePatchPermissions(runtime: ApplyPatchInnerRuntime, ops: PatchOp[]): string | null {
  for (const op of ops) {
    const targets = op.kind === "update" && op.moveTo ? [op.file.raw, op.moveTo.raw] : [op.file.raw]
    for (const filePath of targets) {
      const permission = authorizeLocalToolCall(runtime, "apply_patch", { filePath })
      if (!permission.ok) {
        return permission.output
      }
    }
  }
  return null
}

function countOperationLabel(ops: PatchOp[]): string {
  return `${ops.length} operation${ops.length === 1 ? "" : "s"}`
}

export const applyPatchCoreLogic: StdInnerLogic<
  ApplyPatchInnerRuntime,
  ApplyPatchInnerInput,
  ApplyPatchInnerConfig,
  ApplyPatchInnerOutput
> = async (runtime, input, _config) => {
  const workdir = runtime.vm.outerCtx.workDir
  if (typeof workdir !== "string" || !workdir.trim()) return "Error: workDir not configured"
  const inputWithAlias = input as ApplyPatchInnerInput & { patch?: string }
  const patchText = String(inputWithAlias?.patchText ?? inputWithAlias?.patch ?? "")
  if (!patchText.trim()) return "Error: patchText is required"
  let ops: PatchOp[] = []

  try {
    ops = parsePatch(patchText, workdir)
    const permissionError = ensurePatchPermissions(runtime, ops)
    if (permissionError) return permissionError

    const plan = await buildStagedPatchPlan(ops)
    await commitStagedPatchPlan(plan)
    return encodeFileEditResult({
      message: `Patch applied successfully (${countOperationLabel(ops)}).`,
      ok: true,
      diff: buildMultiFileUnifiedDiff(plan.snapshots),
      touched_files: plan.touchedFiles,
      touched_files_absolute: plan.touchedFilesAbsolute,
      added_count: plan.addedCount,
      updated_count: plan.updatedCount,
      deleted_count: plan.deletedCount,
      moved_count: plan.movedCount,
      match_modes_used: plan.matchModesUsed,
      context_refresh_hint: `Files changed by apply_patch; any earlier read_file output or file context for these paths is stale. Re-read the touched files before building another patch against them.`,
    } as any)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const filePath = primaryPatchFilePath(ops)
    return encodeFileEditResult({
      message: filePath ? `Patch could not be applied to ${filePath}: ${detail}` : `Patch could not be applied: ${detail}`,
      filePath,
      error: "patch_failed",
      detail,
      suggestions: buildApplyPatchFailureSuggestions(detail),
    })
  }
}
