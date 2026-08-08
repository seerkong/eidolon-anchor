import type { AiWorkflowForm } from "@cell/ai-workflow-contract"
import {
  WorkflowResourceLoader,
  type WorkflowResourceLoadResult,
} from "../resources"
import {
  hashWorkflowSources,
  type WorkflowAuthoringStore,
} from "./WorkflowAuthoringStore"

export type WorkflowAuthoringDiff = {
  path: string
  changed: boolean
  before?: string
  after: string
}

export type WorkflowAuthoringDescription = {
  path: string
  files: string[]
  revision: string
}

export class WorkflowAuthoringWorkspace {
  constructor(
    readonly store: WorkflowAuthoringStore,
    private readonly resources = new WorkflowResourceLoader(),
  ) {}

  private assertPublishedPath(relativePath = ""): void {
    const normalized = relativePath.trim().replaceAll("\\", "/").replace(/^\.\//, "")
    if (normalized === ".authoring" || normalized.startsWith(".authoring/")) {
      throw new Error("Workflow authoring session facts require session-scoped APIs")
    }
  }

  read(relativePath: string): Promise<string> {
    this.assertPublishedPath(relativePath)
    return this.store.read(relativePath)
  }

  async tree(relativePath?: string): Promise<string[]> {
    this.assertPublishedPath(relativePath)
    return (await this.store.tree(relativePath)).filter((item) => !item.startsWith(".authoring/"))
  }

  async search(query: string, relativePath?: string): Promise<Array<{ path: string; line: number; text: string }>> {
    this.assertPublishedPath(relativePath)
    const needle = query.trim().toLowerCase()
    if (!needle) return []
    const matches: Array<{ path: string; line: number; text: string }> = []
    for (const filePath of await this.tree(relativePath)) {
      const content = await this.store.read(filePath)
      content.split("\n").forEach((line, index) => {
        if (line.toLowerCase().includes(needle)) matches.push({ path: filePath, line: index + 1, text: line })
      })
    }
    return matches
  }

  async describe(relativePath: string): Promise<WorkflowAuthoringDescription> {
    this.assertPublishedPath(relativePath)
    const files = await this.store.tree(relativePath)
    const sources = await Promise.all(files.map(async (filePath) => ({
      path: filePath,
      content: await this.store.read(filePath),
    })))
    return {
      path: relativePath,
      files,
      revision: hashWorkflowSources(sources),
    }
  }

  async diff(relativePath: string, nextContent: string): Promise<WorkflowAuthoringDiff> {
    this.assertPublishedPath(relativePath)
    let before: string | undefined
    try {
      before = await this.store.read(relativePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    return {
      path: relativePath,
      changed: before !== nextContent,
      ...(before === undefined ? {} : { before }),
      after: nextContent,
    }
  }

  validate(form: AiWorkflowForm, sources: Record<string, string>): WorkflowResourceLoadResult {
    return this.resources.load({ form, sources })
  }

}
