import { randomUUID } from "node:crypto"
import type { AiWorkflowForm } from "@cell/ai-workflow-contract"
import {
  WorkflowResourceLoader,
  type WorkflowResourceLoadResult,
  type WorkflowStaticProjection,
} from "../resources"
import {
  hashWorkflowSources,
  type WorkflowAuthoringFile,
  type WorkflowAuthoringStore,
} from "./WorkflowAuthoringStore"

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const MOUNTS = Object.freeze({
  "/base": "read_only",
  "/refs": "read_only",
  "/work": "read_write",
  "/out": "read_write",
} as const)

export type WorkflowAuthoringSession = {
  kind: "workflow.authoringSession"
  sessionId: string
  form: AiWorkflowForm
  status: "open" | "published"
  target: Record<string, unknown>
  mounts: typeof MOUNTS
  currentRevision: string
  diffRevision?: string
  validationRevision?: string
  dryRunRevision?: string
  diffResult?: WorkflowAuthoringDiffResult
  validationResult?: WorkflowResourceLoadResult
  dryRunProjection?: WorkflowStaticProjection
  createdAt: string
  updatedAt: string
}

export type WorkflowAuthoringDiffResult = {
  summary: { created: number; modified: number; deleted: number; unchanged: number }
  changes: Array<{ path: string; kind: "created" | "modified" | "deleted" | "unchanged" }>
}

export type WorkflowAuthoringAuditEntry = {
  seq: number
  at: string
  operation: string
  detail: Record<string, unknown>
}

type ResolvedLogicalPath = {
  mount: keyof typeof MOUNTS
  relative: string
  storePath: string
}

function cloneFiles(files: readonly WorkflowAuthoringFile[] | undefined): WorkflowAuthoringFile[] {
  return (files ?? []).map((file) => ({ path: safeRelative(file.path), content: file.content }))
}

function safeRelative(value: string, allowRoot = false): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "")
  if ((!normalized && !allowRoot) || normalized.startsWith("/") || (normalized !== "" && normalized.split("/").some((part) => part === ".." || part === ""))) {
    throw new Error(`unsafe workflow authoring path: ${value}`)
  }
  return normalized
}

function safeSessionId(value: string): string {
  if (!SESSION_ID.test(value)) throw new Error(`unsafe workflow authoring session id: ${value}`)
  return value
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function functionParameterSource(source: string, exportName: string): string | undefined {
  const name = escapeRegExp(exportName)
  const declarations = [
    new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\s*\\(`),
    new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(?:async\\s*)?\\(`),
  ]
  for (const declaration of declarations) {
    const match = declaration.exec(source)
    if (!match) continue
    const open = match.index + match[0].lastIndexOf("(")
    let depth = 0
    let quote: string | undefined
    for (let index = open + 1; index < source.length; index += 1) {
      const char = source[index]!
      if (quote) {
        if (char === "\\") index += 1
        else if (char === quote) quote = undefined
        continue
      }
      if (char === '"' || char === "'" || char === "`") {
        quote = char
      } else if (char === "(" || char === "[" || char === "{" || char === "<") {
        depth += 1
      } else if (char === ")") {
        if (depth === 0) return source.slice(open + 1, index)
        depth -= 1
      } else if (char === "]" || char === "}" || char === ">") {
        depth = Math.max(0, depth - 1)
      }
    }
  }
  return undefined
}

function topLevelParameterCount(source: string): number {
  if (!source.trim()) return 0
  let count = 1
  let depth = 0
  let quote: string | undefined
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!
    if (quote) {
      if (char === "\\") index += 1
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'" || char === "`") quote = char
    else if (char === "(" || char === "[" || char === "{" || char === "<") depth += 1
    else if (char === ")" || char === "]" || char === "}" || char === ">") depth = Math.max(0, depth - 1)
    else if (char === "," && depth === 0) count += 1
  }
  return count
}

function validateLocalDataCodeBindings(
  result: WorkflowResourceLoadResult,
  files: readonly WorkflowAuthoringFile[],
): string[] {
  if (result.binding?.kind !== "AIDataWorkflow") return []
  const sourceByPath = new Map(files.map((file) => [file.path.replace(/^\.\//, ""), file.content]))
  const diagnostics: string[] = []
  for (const node of result.binding.definition.nodes as any[]) {
    if (node.tag !== "TransformNode" && node.tag !== "SinkNode") continue
    const reference = typeof node.src === "string" ? node.src : undefined
    const match = reference?.match(/^vfs:\/\/\.\/([^#]+)#([A-Za-z_$][\w$]*)$/)
    if (!match) continue
    const [, filePath, exportName] = match
    const source = sourceByPath.get(filePath!)
    if (source === undefined) {
      diagnostics.push(`data-code-binding: ${node.id} source ${filePath} is missing from the workflow bundle`)
      continue
    }
    const parameters = functionParameterSource(source, exportName!)
    if (parameters === undefined) {
      diagnostics.push(`data-code-binding: ${node.id} export ${exportName} was not found in ${filePath}`)
      continue
    }
    if (topLevelParameterCount(parameters) < 2) {
      diagnostics.push(
        `data-code-signature: ${node.id} export ${exportName} must accept (runtime, inputs, config); the first argument is never inputs`,
      )
    }
  }
  return diagnostics
}

export class WorkflowAuthoringSessionStore {
  private readonly resources: WorkflowResourceLoader

  constructor(
    readonly store: WorkflowAuthoringStore,
    resources = new WorkflowResourceLoader(),
  ) {
    this.resources = resources
  }

  private root(sessionId: string): string {
    return `.authoring/sessions/${safeSessionId(sessionId)}`
  }

  private metadataPath(sessionId: string): string {
    return `${this.root(sessionId)}/session.json`
  }

  private auditPath(sessionId: string): string {
    return `${this.root(sessionId)}/audit.jsonl`
  }

  private resolve(sessionId: string, logicalPath: string): ResolvedLogicalPath {
    const normalized = logicalPath.trim().replaceAll("\\", "/")
    if (!normalized.startsWith("/") || normalized.includes("//")) {
      throw new Error(`unsafe workflow authoring VFS path: ${logicalPath}`)
    }
    const [mountName, ...parts] = normalized.slice(1).split("/")
    const mount = `/${mountName}` as keyof typeof MOUNTS
    if (!(mount in MOUNTS)) throw new Error(`unsupported workflow authoring mount: ${mount}`)
    const relative = safeRelative(parts.join("/"), true)
    return {
      mount,
      relative,
      storePath: `${this.root(sessionId)}/${mountName}${relative ? `/${relative}` : ""}`,
    }
  }

  private async readMetadata(sessionId: string): Promise<WorkflowAuthoringSession> {
    try {
      return JSON.parse(await this.store.read(this.metadataPath(sessionId))) as WorkflowAuthoringSession
    } catch (error) {
      if (errorCode(error) === "ENOENT") throw new Error(`Workflow authoring session not found: ${sessionId}`)
      throw error
    }
  }

  private async writeMetadata(session: WorkflowAuthoringSession): Promise<void> {
    await this.store.writeAtomic(this.metadataPath(session.sessionId), `${JSON.stringify(session, null, 2)}\n`)
  }

  private async appendAudit(
    sessionId: string,
    operation: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    const entries = await this.audit(sessionId, false)
    const entry: WorkflowAuthoringAuditEntry = {
      seq: entries.length + 1,
      at: new Date().toISOString(),
      operation,
      detail,
    }
    const source = [...entries, entry].map((item) => JSON.stringify(item)).join("\n")
    await this.store.writeAtomic(this.auditPath(sessionId), `${source}\n`)
  }

  private async mountFiles(sessionId: string, mount: "base" | "refs" | "work" | "out"): Promise<WorkflowAuthoringFile[]> {
    const prefix = `${this.root(sessionId)}/${mount}`
    const paths = await this.store.tree(prefix)
    return Promise.all(paths.map(async (item) => ({
      path: item.slice(prefix.length + 1),
      content: await this.store.read(item),
    })))
  }

  private async workRevision(sessionId: string): Promise<string> {
    return hashWorkflowSources(await this.mountFiles(sessionId, "work"))
  }

  private async invalidate(sessionId: string): Promise<WorkflowAuthoringSession> {
    const current = await this.readMetadata(sessionId)
    const updated: WorkflowAuthoringSession = {
      ...current,
      currentRevision: await this.workRevision(sessionId),
      diffRevision: undefined,
      validationRevision: undefined,
      dryRunRevision: undefined,
      diffResult: undefined,
      validationResult: undefined,
      dryRunProjection: undefined,
      updatedAt: new Date().toISOString(),
    }
    await this.writeMetadata(updated)
    return updated
  }

  async open(input: {
    sessionId?: string
    form: AiWorkflowForm
    source?: readonly WorkflowAuthoringFile[]
    refs?: readonly WorkflowAuthoringFile[]
    template?: readonly WorkflowAuthoringFile[]
    target?: Record<string, unknown>
  }): Promise<WorkflowAuthoringSession> {
    const sessionId = safeSessionId(input.sessionId?.trim() || `workflow-${randomUUID()}`)
    try {
      await this.store.read(this.metadataPath(sessionId))
      throw new Error(`Workflow authoring session already exists: ${sessionId}`)
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error
    }
    if (input.source && input.template) throw new Error("Authoring session accepts source or template, not both")
    const base = cloneFiles(input.source)
    const work = cloneFiles(input.source ?? input.template)
    for (const file of base) await this.store.writeAtomic(`${this.root(sessionId)}/base/${file.path}`, file.content)
    for (const file of cloneFiles(input.refs)) await this.store.writeAtomic(`${this.root(sessionId)}/refs/${file.path}`, file.content)
    for (const file of work) await this.store.writeAtomic(`${this.root(sessionId)}/work/${file.path}`, file.content)
    const now = new Date().toISOString()
    const session: WorkflowAuthoringSession = {
      kind: "workflow.authoringSession",
      sessionId,
      form: input.form,
      status: "open",
      target: { ...(input.target ?? {}) },
      mounts: MOUNTS,
      currentRevision: await this.workRevision(sessionId),
      createdAt: now,
      updatedAt: now,
    }
    await this.writeMetadata(session)
    await this.appendAudit(sessionId, "open", { form: input.form, target: session.target })
    return session
  }

  async describe(sessionId: string): Promise<WorkflowAuthoringSession> {
    return this.readMetadata(sessionId)
  }

  async list(): Promise<WorkflowAuthoringSession[]> {
    const paths = await this.store.tree(".authoring/sessions")
    const metadata = paths.filter((item) => item.endsWith("/session.json"))
    return Promise.all(metadata.map(async (item) => JSON.parse(await this.store.read(item)) as WorkflowAuthoringSession))
  }

  async tree(sessionId: string, logicalPath = "/work"): Promise<string[]> {
    const resolved = this.resolve(sessionId, logicalPath)
    const paths = await this.store.tree(resolved.storePath)
    const base = `${this.root(sessionId)}/${resolved.mount.slice(1)}`
    const result = paths.map((item) => `/${resolved.mount.slice(1)}/${item.slice(base.length + 1)}`)
    await this.appendAudit(sessionId, "tree", { path: logicalPath, count: result.length })
    return result
  }

  async read(sessionId: string, logicalPath: string): Promise<string> {
    const resolved = this.resolve(sessionId, logicalPath)
    const content = await this.store.read(resolved.storePath)
    await this.appendAudit(sessionId, "read", { path: logicalPath })
    return content
  }

  async write(sessionId: string, logicalPath: string, content: string): Promise<{ path: string; revision: string }> {
    const resolved = this.resolve(sessionId, logicalPath)
    if (MOUNTS[resolved.mount] === "read_only") throw new Error(`${resolved.mount} is read-only`)
    if (!resolved.relative) throw new Error("Workflow authoring writes require a file path")
    await this.store.writeAtomic(resolved.storePath, content)
    const session = await this.invalidate(sessionId)
    await this.appendAudit(sessionId, "write", { path: logicalPath, revision: session.currentRevision })
    return { path: logicalPath, revision: session.currentRevision }
  }

  async edit(sessionId: string, logicalPath: string, oldText: string, newText: string): Promise<{ path: string; revision: string }> {
    const content = await this.read(sessionId, logicalPath)
    if (!content.includes(oldText)) throw new Error("oldText not found in workflow authoring file")
    const result = await this.write(sessionId, logicalPath, content.replace(oldText, newText))
    await this.appendAudit(sessionId, "edit", { path: logicalPath })
    return result
  }

  async patch(sessionId: string, patchSource: string): Promise<{ paths: string[]; revision: string }> {
    const commands = parsePatch(patchSource)
    const paths: string[] = []
    for (const command of commands) {
      const logicalPath = command.path.startsWith("/") ? command.path : `/work/${command.path}`
      if (command.kind === "add") {
        await this.write(sessionId, logicalPath, patchAddedText(command.body))
      } else if (command.kind === "delete") {
        await this.delete(sessionId, logicalPath)
      } else {
        const current = await this.read(sessionId, logicalPath)
        await this.write(sessionId, logicalPath, applyUpdateHunks(current, command.body))
      }
      paths.push(logicalPath)
    }
    const revision = (await this.readMetadata(sessionId)).currentRevision
    await this.appendAudit(sessionId, "patch", { paths, revision })
    return { paths, revision }
  }

  async delete(sessionId: string, logicalPath: string): Promise<{ path: string; deleted: true }> {
    const resolved = this.resolve(sessionId, logicalPath)
    if (MOUNTS[resolved.mount] === "read_only") throw new Error(`${resolved.mount} is read-only`)
    if (!resolved.relative) throw new Error("Workflow authoring delete requires a nested path")
    await this.store.delete(resolved.storePath)
    await this.invalidate(sessionId)
    await this.appendAudit(sessionId, "delete", { path: logicalPath })
    return { path: logicalPath, deleted: true }
  }

  async search(sessionId: string, query: string, logicalPath = "/work"): Promise<Array<{ path: string; line: number; text: string }>> {
    if (!query) return []
    const paths = await this.tree(sessionId, logicalPath)
    const matches: Array<{ path: string; line: number; text: string }> = []
    for (const item of paths) {
      const content = await this.store.read(this.resolve(sessionId, item).storePath)
      content.split(/\r?\n/).forEach((line, index) => {
        if (line.includes(query)) matches.push({ path: item, line: index + 1, text: line })
      })
    }
    await this.appendAudit(sessionId, "search", { path: logicalPath, query, matches: matches.length })
    return matches
  }

  async diff(sessionId: string): Promise<WorkflowAuthoringDiffResult> {
    const base = new Map((await this.mountFiles(sessionId, "base")).map((file) => [file.path, file.content]))
    const work = new Map((await this.mountFiles(sessionId, "work")).map((file) => [file.path, file.content]))
    const paths = [...new Set([...base.keys(), ...work.keys()])].sort()
    const summary = { created: 0, modified: 0, deleted: 0, unchanged: 0 }
    const changes = paths.map((item) => {
      const kind = !base.has(item) ? "created"
        : !work.has(item) ? "deleted"
          : base.get(item) === work.get(item) ? "unchanged"
            : "modified"
      summary[kind] += 1
      return { path: `/work/${item}`, kind }
    })
    const result = { summary, changes }
    const session = await this.readMetadata(sessionId)
    const revision = await this.workRevision(sessionId)
    await this.writeMetadata({
      ...session,
      currentRevision: revision,
      diffRevision: revision,
      diffResult: result,
      updatedAt: new Date().toISOString(),
    })
    await this.appendAudit(sessionId, "diff", { summary, revision })
    return result
  }

  async audit(sessionId: string, requireSession = true): Promise<WorkflowAuthoringAuditEntry[]> {
    if (requireSession) await this.readMetadata(sessionId)
    try {
      return (await this.store.read(this.auditPath(sessionId)))
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as WorkflowAuthoringAuditEntry)
    } catch (error) {
      if (errorCode(error) === "ENOENT") return []
      throw error
    }
  }

  async validate(sessionId: string): Promise<{ valid: true; revision: string; result: WorkflowResourceLoadResult }> {
    const session = await this.readMetadata(sessionId)
    const files = await this.mountFiles(sessionId, "work")
    const sources = Object.fromEntries(files.filter((file) => file.path.endsWith(".xnl")).map((file) => [file.path, file.content]))
    const result = this.resources.load({ form: session.form, sources })
    const codeDiagnostics = validateLocalDataCodeBindings(result, files)
    if (!result.binding || result.diagnostics.length > 0 || codeDiagnostics.length > 0) {
      const details = [
        ...result.diagnostics.map((item) => `${item.code}: ${item.message}`),
        ...codeDiagnostics,
      ].join("; ")
      throw new Error(`Workflow authoring validation failed${details ? `: ${details}` : ""}`)
    }
    const revision = await this.workRevision(sessionId)
    await this.writeMetadata({
      ...session,
      currentRevision: revision,
      validationRevision: revision,
      dryRunRevision: undefined,
      validationResult: result,
      dryRunProjection: undefined,
      updatedAt: new Date().toISOString(),
    })
    await this.appendAudit(sessionId, "validate", { revision })
    return { valid: true, revision, result }
  }

  async dryRun(sessionId: string): Promise<{
    valid: true
    revision: string
    substrate: string
    projection: WorkflowStaticProjection
  }> {
    const session = await this.readMetadata(sessionId)
    const revision = await this.workRevision(sessionId)
    if (session.validationRevision !== revision || !session.validationResult?.binding) {
      throw new Error("Workflow dry-run requires current validation")
    }
    const files = await this.mountFiles(sessionId, "work")
    const sources = Object.fromEntries(files.filter((file) => file.path.endsWith(".xnl")).map((file) => [file.path, file.content]))
    const projection = this.resources.projectStatic({ form: session.form, sources })
    const updated = {
      ...session,
      currentRevision: revision,
      dryRunRevision: revision,
      dryRunProjection: projection,
      updatedAt: new Date().toISOString(),
    }
    await this.writeMetadata(updated)
    await this.appendAudit(sessionId, "dry-run", { revision, projection })
    return { valid: true, revision, substrate: String(session.validationResult.substrate), projection }
  }

  async publish(input: { sessionId: string; confirmed: boolean; targetPath?: string }): Promise<Record<string, unknown>> {
    const session = await this.readMetadata(input.sessionId)
    if (!input.confirmed) {
      await this.appendAudit(input.sessionId, "publication-confirmation-required")
      return { status: "confirmation_required", sessionId: input.sessionId, effectDispatched: false }
    }
    const revision = await this.workRevision(input.sessionId)
    if (session.diffRevision !== revision || session.validationRevision !== revision || session.dryRunRevision !== revision) {
      throw new Error("Workflow publication requires current diff, validation and dry-run revisions")
    }
    const targetPath = safeRelative(
      input.targetPath?.trim()
        || String(session.target.path ?? session.target.id ?? "").trim(),
    )
    const files = await this.mountFiles(input.sessionId, "work")
    await this.store.replaceTreeAtomic(targetPath, files)
    const publishedSources = Object.fromEntries((await Promise.all(
      files.filter((file) => file.path.endsWith(".xnl")).map(async (file) => [
        file.path,
        await this.store.read(`${targetPath}/${file.path}`),
      ] as const),
    )))
    const readback = this.resources.load({ form: session.form, sources: publishedSources })
    if (!readback.binding || readback.diagnostics.length > 0) {
      const details = readback.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; ")
      throw new Error(`Published workflow failed canonical readback${details ? `: ${details}` : ""}`)
    }
    if (readback.binding.definition.fqn !== session.validationResult?.binding?.definition.fqn) {
      throw new Error("Published workflow canonical readback changed definition identity")
    }
    const updated: WorkflowAuthoringSession = {
      ...session,
      status: "published",
      currentRevision: revision,
      updatedAt: new Date().toISOString(),
    }
    await this.writeMetadata(updated)
    await this.appendAudit(input.sessionId, "publish", {
      revision,
      targetPath,
      readbackFqn: readback.binding.definition.fqn,
    })
    return {
      status: "published",
      sessionId: input.sessionId,
      revision,
      targetPath,
      canonicalReadback: {
        form: session.form,
        definitionFqn: readback.binding.definition.fqn,
        diagnostics: readback.diagnostics,
      },
      effectDispatched: false,
    }
  }
}

type PatchCommand = { kind: "add" | "delete" | "update"; path: string; body: string[] }

function parsePatch(source: string): PatchCommand[] {
  const lines = source.split(/\r?\n/)
  if (lines[0] !== "*** Begin Patch" || lines.at(-1) !== "*** End Patch") {
    throw new Error("Workflow authoring patch requires Begin Patch and End Patch markers")
  }
  const commands: PatchCommand[] = []
  let current: PatchCommand | undefined
  for (const line of lines.slice(1, -1)) {
    const match = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(line)
    if (match) {
      if (current) commands.push(current)
      current = {
        kind: match[1]!.toLowerCase() as PatchCommand["kind"],
        path: match[2]!.trim(),
        body: [],
      }
    } else if (current) {
      current.body.push(line)
    } else {
      throw new Error("Workflow authoring patch must declare a file operation")
    }
  }
  if (current) commands.push(current)
  if (commands.length === 0) throw new Error("Workflow authoring patch is empty")
  return commands
}

function patchAddedText(body: readonly string[]): string {
  if (body.some((line) => !line.startsWith("+"))) {
    throw new Error("Workflow authoring add patch content must use + lines")
  }
  return `${body.map((line) => line.slice(1)).join("\n")}${body.length ? "\n" : ""}`
}

function applyUpdateHunks(source: string, body: readonly string[]): string {
  const hunks: string[][] = []
  let current: string[] = []
  for (const line of body) {
    if (line.startsWith("@@")) {
      if (current.length) hunks.push(current)
      current = []
    } else {
      if (line !== "" && ![" ", "+", "-"].includes(line[0]!)) {
        throw new Error("Workflow authoring update patch has an invalid hunk line")
      }
      current.push(line)
    }
  }
  if (current.length) hunks.push(current)
  if (hunks.length === 0) throw new Error("Workflow authoring update patch requires a hunk")
  let result = source
  for (const hunk of hunks) {
    const oldLines = hunk.filter((line) => line.startsWith(" ") || line.startsWith("-")).map((line) => line.slice(1))
    const newLines = hunk.filter((line) => line.startsWith(" ") || line.startsWith("+")).map((line) => line.slice(1))
    let oldText = oldLines.join("\n")
    let newText = newLines.join("\n")
    if (source.endsWith("\n")) {
      oldText += "\n"
      newText += "\n"
    }
    if (!result.includes(oldText)) throw new Error("Workflow authoring update patch context was not found")
    result = result.replace(oldText, newText)
  }
  return result
}
