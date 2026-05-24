export type DiffFileSummary = {
  filename: string
  additions: number
  deletions: number
}

function cleanFilename(filename: string | undefined, fallbackFilename?: string) {
  const candidate = (filename || fallbackFilename || "unknown").replace(/^[ab]\//, "")
  return candidate || "unknown"
}

type MutableDiffFileSummary = {
  filename?: string
  additions: number
  deletions: number
}

function createSummary(filename?: string): MutableDiffFileSummary {
  return {
    filename,
    additions: 0,
    deletions: 0,
  }
}

function finalizeSummary(
  summaries: DiffFileSummary[],
  current: MutableDiffFileSummary | undefined,
  fallbackFilename?: string,
) {
  if (!current) return
  if (current.additions === 0 && current.deletions === 0) return

  summaries.push({
    filename: cleanFilename(current.filename, fallbackFilename),
    additions: current.additions,
    deletions: current.deletions,
  })
}

function summarizeUnifiedDiff(diffText: string, fallbackFilename?: string): DiffFileSummary[] {
  const lines = diffText.split("\n")
  const summaries: DiffFileSummary[] = []
  let current: MutableDiffFileSummary | undefined
  let pendingOldFilename: string | undefined

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      finalizeSummary(summaries, current, fallbackFilename)
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
      current = createSummary(match?.[2] || match?.[1] || fallbackFilename)
      pendingOldFilename = undefined
      continue
    }

    if (line.startsWith("--- ")) {
      const filename = line.slice(4).trim()
      pendingOldFilename = filename !== "/dev/null" ? filename : undefined
      if (!current) current = createSummary(pendingOldFilename || fallbackFilename)
      continue
    }

    if (line.startsWith("+++ ")) {
      const filename = line.slice(4).trim()
      if (!current) current = createSummary(fallbackFilename)
      current.filename = filename !== "/dev/null" ? filename : pendingOldFilename || current.filename
      continue
    }

    if (line.startsWith("@@")) {
      if (!current) current = createSummary(fallbackFilename)
      continue
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      if (!current) current = createSummary(fallbackFilename)
      current.additions += 1
      continue
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      if (!current) current = createSummary(fallbackFilename)
      current.deletions += 1
    }
  }

  finalizeSummary(summaries, current, fallbackFilename)
  return summaries
}

export function summarizeDiffText(diffText: string, fallbackFilename?: string): DiffFileSummary[] {
  if (!diffText.trim()) return []
  return summarizeUnifiedDiff(diffText, fallbackFilename)
}
