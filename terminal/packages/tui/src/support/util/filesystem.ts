import path from "path"

export type PathInfo = {
  state: string
  config: string
  worktree: string
  directory: string
}

export class Filesystem {
  async read(_path: string): Promise<string> {
    return ""
  }

  async write(_path: string, _data: string): Promise<void> {}

  async ensureDir(_path: string): Promise<void> {}

  static normalizePath(input: string): string {
    if (!input) return ""
    const normalized = path.normalize(input)
    if (path.isAbsolute(normalized)) {
      return path.relative(process.cwd(), normalized) || "."
    }
    return normalized
  }

  static contains(base: string, target: string): boolean {
    if (!base || !target) return false
    const basePath = path.resolve(base)
    const targetPath = path.resolve(target)
    return targetPath === basePath || targetPath.startsWith(basePath + path.sep)
  }

  static async *up(input: { targets: string[]; start: string }) {
    let current = path.resolve(input.start)
    const root = path.parse(current).root
    while (true) {
      for (const target of input.targets) {
        const candidate = path.join(current, target)
        try {
          const stat = await Bun.file(candidate).exists()
          if (stat) {
            yield candidate
          }
        } catch {
        }
      }
      if (current === root) return
      current = path.dirname(current)
    }
  }
}
