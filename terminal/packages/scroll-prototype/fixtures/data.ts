export interface FixtureRow {
  id: string
  sequence: number
  revision: number
  text: string
}

export interface FixtureOptions {
  sourceCount: number
  tailLines: number
  shape: "log" | "chat"
}

export function fixtureRange(start: number, count: number, options: FixtureOptions): FixtureRow[] {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(count) || start < 0 || count < 0) {
    throw new Error("Invalid fixture range")
  }
  if (!Number.isSafeInteger(options.sourceCount) || options.sourceCount < 0 ||
    !Number.isSafeInteger(options.tailLines) || options.tailLines < 0) {
    throw new Error("Invalid fixture options")
  }
  const end = Math.min(options.sourceCount, start + count)
  return Array.from({ length: Math.max(0, end - start) }, (_, offset) => {
    const sequence = start + offset
    const lines = sequence === options.sourceCount - 1 ? options.tailLines : 2
    const header = options.shape === "chat" ? `# Card ${sequence}` : `LOG ${sequence}`
    return {
      id: `row-${sequence}`,
      sequence,
      revision: 0,
      text: `${header}\n${Array.from({ length: lines }, (_, line) => `line-${line} 中文宽字符 abcdef`).join("\n")}\nEND-${sequence}`,
    }
  })
}
