type DiffOp = {
  type: "context" | "add" | "remove"
  line: string
}

export type FileEditResultPayload = {
  message: string
  filePath?: string
  diff?: string
  error?: string
  detail?: string
  suggestions?: string[]
  editIndex?: number
}

export type ApplyStringEditParams = {
  content: string
  oldString: string
  newString: string
  replaceAll?: boolean
}

export type ApplyStringEditSuccess = {
  ok: true
  next: string
  replacements: number
  strategy: "exact" | "normalized_newlines"
}

export type ApplyStringEditFailure = {
  ok: false
  code: "not_found"
  message: string
  detail?: string
  suggestions: string[]
}

const DEFAULT_EDIT_FAILURE_SUGGESTIONS = [
  "Read the file again and copy the exact oldString snippet, including whitespace and surrounding punctuation.",
  "If the change spans multiple lines or nearby hunks, switch to apply_patch instead of retrying edit.",
]

export function trimDiff(text: string): string {
  return text.replace(/^\n+|\n+$/g, "")
}

function splitDiffLines(text: string): string[] {
  if (!text) return []
  return text.split("\n")
}

function buildLineDiff(beforeLines: string[], afterLines: string[]): DiffOp[] {
  const beforeCount = beforeLines.length
  const afterCount = afterLines.length
  const dp = Array.from({ length: beforeCount + 1 }, () => Array<number>(afterCount + 1).fill(0))

  for (let i = beforeCount - 1; i >= 0; i -= 1) {
    for (let j = afterCount - 1; j >= 0; j -= 1) {
      if (beforeLines[i] === afterLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
  }

  const ops: DiffOp[] = []
  let i = 0
  let j = 0

  while (i < beforeCount && j < afterCount) {
    if (beforeLines[i] === afterLines[j]) {
      ops.push({ type: "context", line: beforeLines[i] })
      i += 1
      j += 1
      continue
    }
    if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "remove", line: beforeLines[i] })
      i += 1
      continue
    }
    ops.push({ type: "add", line: afterLines[j] })
    j += 1
  }

  while (i < beforeCount) {
    ops.push({ type: "remove", line: beforeLines[i] })
    i += 1
  }
  while (j < afterCount) {
    ops.push({ type: "add", line: afterLines[j] })
    j += 1
  }

  return ops
}

function formatUnifiedRange(startLine: number, count: number): string {
  if (count === 0) return `${Math.max(startLine - 1, 0)},0`
  if (count === 1) return `${startLine}`
  return `${startLine},${count}`
}

export function buildUnifiedDiff(filePath: string, before: string, after: string): string {
  if (before === after) return ""

  const contextWindow = 3
  const ops = buildLineDiff(splitDiffLines(before), splitDiffLines(after))
  const beforePrefix = [0]
  const afterPrefix = [0]

  for (const op of ops) {
    beforePrefix.push(beforePrefix[beforePrefix.length - 1] + (op.type === "add" ? 0 : 1))
    afterPrefix.push(afterPrefix[afterPrefix.length - 1] + (op.type === "remove" ? 0 : 1))
  }

  const hunks: string[] = []
  let current:
    | {
        startIndex: number
        lines: DiffOp[]
        trailingContext: number
      }
    | undefined

  const pushHunk = () => {
    if (!current) return
    const startIndex = current.startIndex
    const endIndex = startIndex + current.lines.length
    const beforeStart = beforePrefix[startIndex] + 1
    const afterStart = afterPrefix[startIndex] + 1
    const beforeCount = beforePrefix[endIndex] - beforePrefix[startIndex]
    const afterCount = afterPrefix[endIndex] - afterPrefix[startIndex]
    hunks.push(
      `@@ -${formatUnifiedRange(beforeStart, beforeCount)} +${formatUnifiedRange(afterStart, afterCount)} @@`,
      ...current.lines.map((line) => `${line.type === "context" ? " " : line.type === "remove" ? "-" : "+"}${line.line}`),
    )
    current = undefined
  }

  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index]
    if (op.type === "context") {
      if (!current) continue
      if (current.trailingContext < contextWindow) {
        current.lines.push(op)
        current.trailingContext += 1
        continue
      }
      pushHunk()
      continue
    }

    if (!current) {
      const startIndex = Math.max(0, index - contextWindow)
      current = {
        startIndex,
        lines: ops.slice(startIndex, index),
        trailingContext: 0,
      }
    }

    current.lines.push(op)
    current.trailingContext = 0
  }

  pushHunk()

  return trimDiff([`--- ${filePath}`, `+++ ${filePath}`, ...hunks].join("\n"))
}

export function buildMultiFileUnifiedDiff(entries: Array<{ filePath: string; before: string; after: string }>): string {
  return trimDiff(
    entries
      .map((entry) => buildUnifiedDiff(entry.filePath, entry.before, entry.after))
      .filter((entry) => entry.trim().length > 0)
      .join("\n\n"),
  )
}

export function encodeFileEditResult(payload: FileEditResultPayload): string {
  return JSON.stringify(payload)
}

function replaceContentExact(content: string, oldString: string, newString: string, replaceAll: boolean): ApplyStringEditSuccess | null {
  if (!content.includes(oldString)) return null
  if (replaceAll) {
    const replacements = content.split(oldString).length - 1
    return {
      ok: true,
      next: content.split(oldString).join(newString),
      replacements,
      strategy: "exact",
    }
  }
  return {
    ok: true,
    next: content.replace(oldString, newString),
    replacements: 1,
    strategy: "exact",
  }
}

function detectDominantNewline(content: string): "\n" | "\r\n" {
  if (content.includes("\r\n")) return "\r\n"
  return "\n"
}

function convertToDominantNewline(content: string, newline: "\n" | "\r\n"): string {
  if (newline === "\n") return content
  return content.replace(/\n/g, "\r\n")
}

function summarizeLine(text: string, maxChars = 80): string {
  const compact = text.replace(/\s+/g, " ").trim()
  if (!compact) return ""
  if (compact.length <= maxChars) return compact
  return `${compact.slice(0, Math.max(0, maxChars - 1))}…`
}

function buildEditFailureDetail(content: string, oldString: string): string {
  const normalizedContent = content.replace(/\r\n/g, "\n")
  const normalizedOldString = oldString.replace(/\r\n/g, "\n")
  const trimmedOldString = normalizedOldString.trim()
  if (trimmedOldString && trimmedOldString !== normalizedOldString && normalizedContent.includes(trimmedOldString)) {
    return "A similar snippet exists only after trimming whitespace; copy the exact snippet with its original indentation and newlines"
  }

  const firstMeaningfulLine = normalizedOldString
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
  if (firstMeaningfulLine && normalizedContent.includes(firstMeaningfulLine)) {
    const preview = summarizeLine(firstMeaningfulLine)
    return preview
      ? `A similar line exists (${JSON.stringify(preview)}), but the full snippet does not match exactly`
      : "A similar line exists, but the full snippet does not match exactly"
  }

  return "oldString not found exactly in file content"
}

export function applyStringEdit(params: ApplyStringEditParams): ApplyStringEditSuccess | ApplyStringEditFailure {
  const { content, oldString, newString, replaceAll = false } = params
  const exact = replaceContentExact(content, oldString, newString, replaceAll)
  if (exact) {
    return exact
  }

  const dominantNewline = detectDominantNewline(content)
  const normalizedContent = content.replace(/\r\n/g, "\n")
  const normalizedOldString = oldString.replace(/\r\n/g, "\n")
  const normalizedNewString = newString.replace(/\r\n/g, "\n")
  const normalized = replaceContentExact(normalizedContent, normalizedOldString, normalizedNewString, replaceAll)
  if (normalized) {
    return {
      ...normalized,
      next: convertToDominantNewline(normalized.next, dominantNewline),
      strategy: "normalized_newlines",
    }
  }

  return {
    ok: false,
    code: "not_found",
    message: "oldString not found exactly in file content",
    detail: buildEditFailureDetail(content, oldString),
    suggestions: [...DEFAULT_EDIT_FAILURE_SUGGESTIONS],
  }
}

export function formatEditNotFoundError(
  filePath: string,
  failure?: ApplyStringEditFailure | string,
  editIndex?: number,
): string {
  const suffix = typeof editIndex === "number" ? ` (edit #${editIndex + 1})` : ""
  const detail =
    typeof failure === "string"
      ? failure
      : typeof failure?.detail === "string" && failure.detail.trim()
        ? failure.detail
        : typeof failure?.message === "string"
          ? failure.message
          : ""
  const suggestions =
    typeof failure === "string" ? [...DEFAULT_EDIT_FAILURE_SUGGESTIONS] : [...(failure?.suggestions ?? DEFAULT_EDIT_FAILURE_SUGGESTIONS)]
  return encodeFileEditResult({
    message: detail?.trim() ? `Text not found in ${filePath}${suffix}: ${detail}` : `Text not found in ${filePath}${suffix}`,
    filePath,
    error: "not_found",
    detail: detail?.trim() ? detail : undefined,
    suggestions,
    editIndex: typeof editIndex === "number" ? editIndex + 1 : undefined,
  })
}
