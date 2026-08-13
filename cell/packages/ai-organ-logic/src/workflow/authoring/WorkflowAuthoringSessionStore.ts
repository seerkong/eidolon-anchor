import { createHash, randomUUID } from "node:crypto"
import type { AiWorkflowForm } from "@cell/ai-workflow-contract"
import ts from "typescript"
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
  schemaVersion: 2
  sessionId: string
  form: AiWorkflowForm
  status: "open" | "published"
  lifecycle: "editing" | "ready_for_publication" | "published_clean" | "published_dirty"
  dirty: boolean
  target: Record<string, unknown>
  mounts: typeof MOUNTS
  baseRevision: string
  workingRevision: string
  publishedRevision?: string
  latestPublicationReceiptId?: string
  pendingPublication?: WorkflowPendingPublication
  proofSet?: WorkflowPublicationProofSet
  /** Compatibility projection for callers that predate schema v2. */
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

export type WorkflowPendingPublication = {
  attemptId: string
  revision: string
  targetPath: string
  startedAt: string
}

export type WorkflowPublicationReceipt = {
  kind: "workflow.publicationReceipt"
  receiptId: string
  sequence: number
  sessionId: string
  revision: string
  targetPath: string
  definitionFqn: string
  workflowRef: string
  contract: {
    inputPorts: string[]
    outputPorts: string[]
  }
  artifactDigest: string
  proofReceiptIds: string[]
  createdAt: string
}

type WorkflowProofReceiptBase = {
  receiptId: string
  revision: string
  bundleDigest: string
  createdAt: string
}

export type WorkflowPublicationProofSet = {
  revision: string
  bundleDigest: string
  diffReceipt: WorkflowProofReceiptBase & {
    kind: "workflow.diffReceipt"
    baseRevision: string
    summary: WorkflowAuthoringDiffResult["summary"]
  }
  validationReceipt: WorkflowProofReceiptBase & {
    kind: "workflow.validationReceipt"
    definitionFqn: string
    diagnosticCount: number
  }
  staticProjectionReceipt: WorkflowProofReceiptBase & {
    kind: "workflow.staticProjectionReceipt"
    projectionDigest: string
    effectDispatched: false
    acceptanceClaimed: false
  }
  buildReceipt: WorkflowProofReceiptBase & {
    kind: "workflow.buildReceipt"
    definitionFqn: string
    assemblyDigest: string
  }
  acceptanceDispositionReceipt: WorkflowProofReceiptBase & {
    kind: "workflow.acceptanceDispositionReceipt"
    disposition: "required" | "not_required"
    policySource: string
  }
  candidateAcceptanceReceipt?: WorkflowProofReceiptBase & {
    kind: "workflow.candidateAcceptanceReceipt"
    fixtureId: string
    outcome: "passed" | "degraded" | "failed"
    evidenceDigest: string
    isolated: true
    realEffectDispatched: false
    runtime: "canonical-depa-flows"
    effectProvider: "isolated-fixture"
  }
}

export type WorkflowCandidateAcceptanceHarness = {
  run(input: {
    session: WorkflowAuthoringSession
    files: readonly WorkflowAuthoringFile[]
    projection: WorkflowStaticProjection
    fixtureId: string
  }): Promise<{
    outcome: "passed" | "degraded" | "failed"
    evidence: Record<string, unknown>
    isolated: true
    realEffectDispatched: false
    runtime: "canonical-depa-flows"
    effectProvider: "isolated-fixture"
  }>
}

export type WorkflowAcceptancePolicy = {
  requirement: "required" | "not_required"
  source: string
  fixtureId?: string
}

function proofReceiptIds(proofSet: WorkflowPublicationProofSet): string[] {
  return [
    proofSet.diffReceipt.receiptId,
    proofSet.validationReceipt.receiptId,
    proofSet.staticProjectionReceipt.receiptId,
    proofSet.buildReceipt.receiptId,
    proofSet.acceptanceDispositionReceipt.receiptId,
    proofSet.candidateAcceptanceReceipt?.receiptId,
  ].filter((item): item is string => Boolean(item))
}

export type WorkflowStructuredPatchOperation =
  | { kind: "add" | "update"; path: string; content: string }
  | { kind: "delete"; path: string }

export type WorkflowAuthoringReceipt = {
  kind: "workflow.authoringReceipt"
  receiptId: string
  authoringSessionId: string
  stage: "coding" | "testing" | "releasing"
  outcome: "ready" | "published" | "waiting" | "failed"
  workingRevision: string
  publishedRevision?: string
  dirty: boolean
  changedPaths: string[]
  proofReceiptIds: string[]
  publicationReceiptId?: string
  diagnosticCodes: string[]
  diagnosticsTruncated: boolean
  nextAction: string
  createdAt: string
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

export type WorkflowAuthoringVfsDiagnostic = {
  kind: "workflow.authoringVfsDiagnostic"
  code: "not_found" | "operation_mismatch"
  operation: "read" | "tree" | "search" | "write"
  path: string
  expected: "file" | "directory"
  actual: "file" | "directory" | "missing"
  mounts: typeof MOUNTS
}

export class WorkflowAuthoringVfsError extends Error {
  constructor(readonly diagnostic: WorkflowAuthoringVfsDiagnostic) {
    super(JSON.stringify(diagnostic))
    this.name = "WorkflowAuthoringVfsError"
  }
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

function digestJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`
}

function proofReceiptId(kind: string, sessionId: string, revision: string, discriminator = ""): string {
  return `${kind}-${createHash("sha256").update(`${sessionId}\0${revision}\0${discriminator}`).digest("hex")}`
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

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
  ) current = current.expression
  return current
}

function propertySegments(expression: ts.Expression): string[] | undefined {
  const current = unwrapExpression(expression)
  if (ts.isIdentifier(current)) return [current.text]
  if (ts.isPropertyAccessExpression(current)) {
    const parent = propertySegments(current.expression)
    return parent ? [...parent, current.name.text] : undefined
  }
  if (ts.isElementAccessExpression(current)) {
    const argument = current.argumentExpression && unwrapExpression(current.argumentExpression)
    if (!argument || (!ts.isStringLiteral(argument) && !ts.isNoSubstitutionTemplateLiteral(argument))) return undefined
    const parent = propertySegments(current.expression)
    return parent ? [...parent, argument.text] : undefined
  }
  return undefined
}

function objectPropertyName(property: ts.ObjectLiteralElementLike): string | undefined {
  if (!property.name) return undefined
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)) {
    return property.name.text
  }
  return undefined
}

function isFunctionScope(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
    || ts.isConstructorDeclaration(node)
}

function enclosingFunctionScope(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  let current: ts.Node | undefined = node.parent
  while (current) {
    if (isFunctionScope(current)) return current
    current = current.parent
  }
  return undefined
}

function runtimeParameterName(scope: ts.FunctionLikeDeclaration | undefined): string | undefined {
  const parameter = scope?.parameters[0]
  return parameter && ts.isIdentifier(parameter.name) ? parameter.name.text : undefined
}

function isRuntimeCapabilityPath(segments: readonly string[] | undefined, runtimeParameter: string, leaf: readonly string[]): boolean {
  return segments?.length === leaf.length + 1
    && segments[0] === runtimeParameter
    && segments.slice(1).join(".") === leaf.join(".")
}

function validateEffectInvocationContracts(files: readonly WorkflowAuthoringFile[]): string[] {
  const diagnostics: string[] = []
  for (const file of files.filter((item) => item.path.startsWith("flow-code/") && /\.[cm]?[jt]sx?$/.test(item.path))) {
    const scriptKind = file.path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    const sourceFile = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true, scriptKind)
    const effectAliases = new Map<ts.FunctionLikeDeclaration, Map<string, string[]>>()
    const runAuthorityAliases = new Map<ts.FunctionLikeDeclaration, Map<string, string[]>>()

    const collectAliases = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const segments = propertySegments(node.initializer)
        const scope = enclosingFunctionScope(node)
        if (scope && segments?.slice(-2).join(".") === "ai.effects") {
          const aliases = effectAliases.get(scope) ?? new Map<string, string[]>()
          aliases.set(node.name.text, segments)
          effectAliases.set(scope, aliases)
        }
        if (scope && segments?.slice(-3).join(".") === "ai.metadata.run") {
          const aliases = runAuthorityAliases.get(scope) ?? new Map<string, string[]>()
          aliases.set(node.name.text, segments)
          runAuthorityAliases.set(scope, aliases)
        }
      }
      ts.forEachChild(node, collectAliases)
    }
    collectAliases(sourceFile)

    const inspectCalls = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = unwrapExpression(node.expression)
        const isComputedInvoke = ts.isElementAccessExpression(callee)
          && callee.argumentExpression !== undefined
          && ts.isStringLiteral(unwrapExpression(callee.argumentExpression))
          && (unwrapExpression(callee.argumentExpression) as ts.StringLiteral).text === "invoke"
        const invokeOwner = ts.isPropertyAccessExpression(callee) && callee.name.text === "invoke"
          ? callee.expression
          : isComputedInvoke && ts.isElementAccessExpression(callee)
            ? callee.expression
            : undefined
        if (invokeOwner) {
          const scope = enclosingFunctionScope(node)
          const runtimeParameter = runtimeParameterName(scope)
          const owner = unwrapExpression(invokeOwner)
          const ownerSegments = propertySegments(owner)
          const aliasedOwnerSegments = scope && ts.isIdentifier(owner)
            ? effectAliases.get(scope)?.get(owner.text)
            : undefined
          const candidateOwnerSegments = aliasedOwnerSegments ?? ownerSegments
          const looksLikeEffectProvider = candidateOwnerSegments?.slice(-2).join(".") === "ai.effects"
          const isEffectProvider = runtimeParameter !== undefined && (
            isRuntimeCapabilityPath(ownerSegments, runtimeParameter, ["ai", "effects"])
            || isRuntimeCapabilityPath(aliasedOwnerSegments, runtimeParameter, ["ai", "effects"])
          )
          if (looksLikeEffectProvider) {
            const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
            if (isComputedInvoke) {
              diagnostics.push(
                `data-code-effect-contract: ${file.path}:${location.line + 1}:${location.character + 1} effects.invoke must use the canonical direct member capability`,
              )
              ts.forEachChild(node, inspectCalls)
              return
            }
            if (!isEffectProvider) {
              diagnostics.push(
                `data-code-effect-contract: ${file.path}:${location.line + 1}:${location.character + 1} effects.invoke provider must originate from the current function runtime parameter`,
              )
              ts.forEachChild(node, inspectCalls)
              return
            }
            const request = node.arguments[0] ? unwrapExpression(node.arguments[0]) : undefined
            const runProperty = request && ts.isObjectLiteralExpression(request)
              ? request.properties.find((property) => objectPropertyName(property) === "run")
              : undefined
            const hasAuthoritativeRun = (() => {
              if (!runProperty || !scope || !runtimeParameter) return false
              if (ts.isShorthandPropertyAssignment(runProperty)) {
                return isRuntimeCapabilityPath(
                  runAuthorityAliases.get(scope)?.get(runProperty.name.text),
                  runtimeParameter,
                  ["ai", "metadata", "run"],
                )
              }
              if (!ts.isPropertyAssignment(runProperty)) return false
              const runExpression = unwrapExpression(runProperty.initializer)
              const segments = propertySegments(runExpression)
              const aliasedSegments = ts.isIdentifier(runExpression)
                ? runAuthorityAliases.get(scope)?.get(runExpression.text)
                : undefined
              return isRuntimeCapabilityPath(segments, runtimeParameter, ["ai", "metadata", "run"])
                || isRuntimeCapabilityPath(aliasedSegments, runtimeParameter, ["ai", "metadata", "run"])
            })()
            if (!hasAuthoritativeRun) {
              diagnostics.push(
                `data-code-effect-contract: ${file.path}:${location.line + 1}:${location.character + 1} effects.invoke request run must originate from runtime.ai.metadata.run`,
              )
            }
          }
        }
      }
      ts.forEachChild(node, inspectCalls)
    }
    inspectCalls(sourceFile)
  }
  return diagnostics
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    && (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false)
}

type LocalFunctionContract = {
  body: ts.ConciseBody
  parameters: string[]
  exported: boolean
}

function localFunctionContracts(sourceFile: ts.SourceFile): Map<string, LocalFunctionContract> {
  const contracts = new Map<string, LocalFunctionContract>()
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      contracts.set(statement.name.text, {
        body: statement.body,
        parameters: statement.parameters.map((parameter) => ts.isIdentifier(parameter.name) ? parameter.name.text : ""),
        exported: hasExportModifier(statement),
      })
      continue
    }
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
      const initializer = unwrapExpression(declaration.initializer)
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        contracts.set(declaration.name.text, {
          body: initializer.body,
          parameters: initializer.parameters.map((parameter) => ts.isIdentifier(parameter.name) ? parameter.name.text : ""),
          exported: hasExportModifier(statement),
        })
      }
    }
  }
  return contracts
}

function inferredReturnObjectKeys(source: string, path: string, exportName: string): string[][] {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const contracts = localFunctionContracts(sourceFile)
  if (!contracts.get(exportName)?.exported) return []

  const resolveString = (expression: ts.Expression, environment: ReadonlyMap<string, string>): string | undefined => {
    const value = unwrapExpression(expression)
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text
    return ts.isIdentifier(value) ? environment.get(value.text) : undefined
  }

  const inferExpression = (
    expression: ts.Expression,
    environment: ReadonlyMap<string, string>,
    stack: ReadonlySet<string>,
  ): string[][] => {
    const value = unwrapExpression(expression)
    if (ts.isObjectLiteralExpression(value) && !value.properties.some(ts.isSpreadAssignment)) {
      const keys = value.properties.map((property) => {
        if (property.name && ts.isComputedPropertyName(property.name)) {
          return resolveString(property.name.expression, environment)
        }
        return objectPropertyName(property)
      })
      return keys.every((key): key is string => key !== undefined) ? [keys] : []
    }
    if (!ts.isCallExpression(value) || !ts.isIdentifier(unwrapExpression(value.expression))) return []
    const callee = unwrapExpression(value.expression) as ts.Identifier
    if (stack.has(callee.text)) return []
    const contract = contracts.get(callee.text)
    if (!contract) return []
    const nestedEnvironment = new Map<string, string>()
    contract.parameters.forEach((parameter, index) => {
      const argument = value.arguments[index]
      if (!parameter || !argument) return
      const resolved = resolveString(argument, environment)
      if (resolved !== undefined) nestedEnvironment.set(parameter, resolved)
    })
    return inferBody(contract.body, nestedEnvironment, new Set([...stack, callee.text]))
  }

  const inferBody = (
    body: ts.ConciseBody,
    environment: ReadonlyMap<string, string>,
    stack: ReadonlySet<string>,
  ): string[][] => {
    if (!ts.isBlock(body)) return inferExpression(body, environment, stack)
    const returned: string[][] = []
    const visit = (node: ts.Node): void => {
      if (node !== body && ts.isFunctionLike(node)) return
      if (ts.isReturnStatement(node) && node.expression) {
        returned.push(...inferExpression(node.expression, environment, stack))
      }
      ts.forEachChild(node, visit)
    }
    visit(body)
    return returned
  }

  const root = contracts.get(exportName)!
  return inferBody(root.body, new Map(), new Set([exportName]))
}

function validateLocalDataCodeBindings(
  result: WorkflowResourceLoadResult,
  files: readonly WorkflowAuthoringFile[],
): string[] {
  const diagnostics = validateEffectInvocationContracts(files)
  if (result.binding?.kind !== "AIDataWorkflow") return diagnostics
  const sourceByPath = new Map(files.map((file) => [file.path.replace(/^\.\//, ""), file.content]))
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
    const expectedOutputs = [...(node.outputs ?? [])].map(String).sort()
    for (const returnedKeys of inferredReturnObjectKeys(source, filePath!, exportName!)) {
      const actualOutputs = [...returnedKeys].sort()
      if (
        actualOutputs.length !== expectedOutputs.length
        || actualOutputs.some((key, index) => key !== expectedOutputs[index])
      ) {
        diagnostics.push(
          `data-code-output-contract: ${node.id} export ${exportName} must return exact output keys [${expectedOutputs.join(", ")}], got [${actualOutputs.join(", ")}]`,
        )
      }
    }
  }
  return diagnostics
}

export class WorkflowAuthoringSessionStore {
  private readonly resources: WorkflowResourceLoader

  constructor(
    readonly store: WorkflowAuthoringStore,
    resources = new WorkflowResourceLoader(),
    private readonly candidateHarness?: WorkflowCandidateAcceptanceHarness,
  ) {
    this.resources = resources
  }

  private root(sessionId: string): string {
    return `.authoring/sessions/${safeSessionId(sessionId)}`
  }

  private lockPath(sessionId: string): string {
    return `.authoring/locks/${safeSessionId(sessionId)}.lock`
  }

  private metadataPath(sessionId: string): string {
    return `${this.root(sessionId)}/session.json`
  }

  private auditPath(sessionId: string): string {
    return `${this.root(sessionId)}/audit.jsonl`
  }

  private publicationPath(sessionId: string, receiptId: string): string {
    return `${this.root(sessionId)}/publications/${safeSessionId(receiptId)}.json`
  }

  private authoringReceiptPath(sessionId: string, receiptId: string): string {
    return `${this.root(sessionId)}/authoring-receipts/${safeSessionId(receiptId)}.json`
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

  private deriveSession(
    raw: Partial<WorkflowAuthoringSession> & Pick<WorkflowAuthoringSession, "sessionId" | "form" | "target" | "createdAt" | "updatedAt">,
    revisions: { base: string; working: string },
  ): WorkflowAuthoringSession {
    const publishedRevision = raw.publishedRevision
      ?? (raw.status === "published" ? raw.currentRevision : undefined)
    const dirty = publishedRevision === undefined || publishedRevision !== revisions.working
    const proofReady = raw.diffRevision === revisions.working
      && raw.validationRevision === revisions.working
      && raw.dryRunRevision === revisions.working
    const lifecycle: WorkflowAuthoringSession["lifecycle"] = publishedRevision
      ? dirty ? "published_dirty" : "published_clean"
      : proofReady ? "ready_for_publication" : "editing"
    return {
      ...raw,
      kind: "workflow.authoringSession",
      schemaVersion: 2,
      sessionId: raw.sessionId,
      form: raw.form,
      status: publishedRevision ? "published" : "open",
      lifecycle,
      dirty,
      target: { ...raw.target },
      mounts: MOUNTS,
      baseRevision: revisions.base,
      workingRevision: revisions.working,
      publishedRevision,
      currentRevision: revisions.working,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    }
  }

  private async readMetadata(sessionId: string): Promise<WorkflowAuthoringSession> {
    try {
      const raw = JSON.parse(await this.store.read(this.metadataPath(sessionId))) as WorkflowAuthoringSession
      return this.deriveSession(raw, {
        base: hashWorkflowSources(await this.mountFiles(sessionId, "base")),
        working: hashWorkflowSources(await this.mountFiles(sessionId, "work")),
      })
    } catch (error) {
      if (errorCode(error) === "ENOENT") throw new Error(`Workflow authoring session not found: ${sessionId}`)
      throw error
    }
  }

  private async writeMetadata(session: WorkflowAuthoringSession): Promise<void> {
    const normalized = this.deriveSession(session, {
      base: session.baseRevision,
      working: session.workingRevision,
    })
    await this.store.writeAtomic(this.metadataPath(session.sessionId), `${JSON.stringify(normalized, null, 2)}\n`)
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

  private async requirePathKind(
    resolved: ResolvedLogicalPath,
    operation: WorkflowAuthoringVfsDiagnostic["operation"],
    expected: WorkflowAuthoringVfsDiagnostic["expected"],
  ): Promise<void> {
    const actual = await this.store.kind(resolved.storePath)
    if (actual === expected) return
    throw new WorkflowAuthoringVfsError({
      kind: "workflow.authoringVfsDiagnostic",
      code: actual === "missing" ? "not_found" : "operation_mismatch",
      operation,
      path: `${resolved.mount}${resolved.relative ? `/${resolved.relative}` : ""}`,
      expected,
      actual,
      mounts: MOUNTS,
    })
  }

  private async workRevision(sessionId: string): Promise<string> {
    return hashWorkflowSources(await this.mountFiles(sessionId, "work"))
  }

  private async invalidate(sessionId: string): Promise<WorkflowAuthoringSession> {
    const current = await this.readMetadata(sessionId)
    const workingRevision = await this.workRevision(sessionId)
    const updated: WorkflowAuthoringSession = {
      ...current,
      workingRevision,
      currentRevision: workingRevision,
      diffRevision: undefined,
      validationRevision: undefined,
      dryRunRevision: undefined,
      diffResult: undefined,
      validationResult: undefined,
      dryRunProjection: undefined,
      proofSet: undefined,
      updatedAt: new Date().toISOString(),
    }
    const derived = this.deriveSession(updated, { base: current.baseRevision, working: workingRevision })
    await this.writeMetadata(derived)
    return derived
  }

  private async replaceSessionRoot(
    sessionId: string,
    session: WorkflowAuthoringSession,
    workFiles: readonly WorkflowAuthoringFile[],
  ): Promise<void> {
    const root = this.root(sessionId)
    const existingPaths = await this.store.tree(root)
    const retained = await Promise.all(existingPaths
      .filter((item) => item !== this.metadataPath(sessionId) && !item.startsWith(`${root}/work/`))
      .map(async (item) => ({ path: item.slice(root.length + 1), content: await this.store.read(item) })))
    await this.store.replaceTreeAtomic(root, [
      ...retained,
      ...workFiles.map((file) => ({ path: `work/${file.path}`, content: file.content })),
      { path: "session.json", content: `${JSON.stringify(session, null, 2)}\n` },
    ])
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
    for (const mount of Object.keys(MOUNTS)) {
      await this.store.ensureDirectory(`${this.root(sessionId)}/${mount.slice(1)}`)
    }
    const base = cloneFiles(input.source)
    const work = cloneFiles(input.source ?? input.template)
    for (const file of base) await this.store.writeAtomic(`${this.root(sessionId)}/base/${file.path}`, file.content)
    for (const file of cloneFiles(input.refs)) await this.store.writeAtomic(`${this.root(sessionId)}/refs/${file.path}`, file.content)
    for (const file of work) await this.store.writeAtomic(`${this.root(sessionId)}/work/${file.path}`, file.content)
    const now = new Date().toISOString()
    const baseRevision = hashWorkflowSources(base)
    const workingRevision = hashWorkflowSources(work)
    const session: WorkflowAuthoringSession = {
      kind: "workflow.authoringSession",
      schemaVersion: 2,
      sessionId,
      form: input.form,
      status: "open",
      lifecycle: "editing",
      dirty: true,
      target: { ...(input.target ?? {}) },
      mounts: MOUNTS,
      baseRevision,
      workingRevision,
      currentRevision: workingRevision,
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
    return Promise.all(metadata.map(async (item) => {
      const sessionId = item.slice(".authoring/sessions/".length, -"/session.json".length)
      return this.readMetadata(sessionId)
    }))
  }

  async tree(sessionId: string, logicalPath = "/work"): Promise<string[]> {
    await this.readMetadata(sessionId)
    const resolved = this.resolve(sessionId, logicalPath)
    await this.requirePathKind(resolved, "tree", "directory")
    const paths = await this.store.tree(resolved.storePath)
    const base = `${this.root(sessionId)}/${resolved.mount.slice(1)}`
    const result = paths.map((item) => `/${resolved.mount.slice(1)}/${item.slice(base.length + 1)}`)
    await this.appendAudit(sessionId, "tree", { path: logicalPath, count: result.length })
    return result
  }

  async read(sessionId: string, logicalPath: string): Promise<string> {
    await this.readMetadata(sessionId)
    const resolved = this.resolve(sessionId, logicalPath)
    await this.requirePathKind(resolved, "read", "file")
    const content = await this.store.read(resolved.storePath)
    await this.appendAudit(sessionId, "read", { path: logicalPath })
    return content
  }

  async write(sessionId: string, logicalPath: string, content: string): Promise<{ path: string; revision: string }> {
    const resolved = this.resolve(sessionId, logicalPath)
    if (MOUNTS[resolved.mount] === "read_only") throw new Error(`${resolved.mount} is read-only`)
    if (!resolved.relative) throw new Error("Workflow authoring writes require a file path")
    const actual = await this.store.kind(resolved.storePath)
    if (actual === "directory") {
      throw new WorkflowAuthoringVfsError({
        kind: "workflow.authoringVfsDiagnostic",
        code: "operation_mismatch",
        operation: "write",
        path: logicalPath,
        expected: "file",
        actual,
        mounts: MOUNTS,
      })
    }
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
    const session = await this.readMetadata(sessionId)
    const work = new Map((await this.mountFiles(sessionId, "work")).map((file) => [file.path, file.content]))
    const operations: WorkflowStructuredPatchOperation[] = []
    for (const command of commands) {
      const logicalPath = command.path.startsWith("/") ? command.path : `/work/${command.path}`
      const resolved = this.resolve(sessionId, logicalPath)
      if (resolved.mount !== "/work" || !resolved.relative) {
        throw new Error("Workflow authoring patch operations are restricted to /work files")
      }
      if (command.kind === "add") {
        operations.push({ kind: "add", path: logicalPath, content: patchAddedText(command.body) })
      } else if (command.kind === "delete") {
        operations.push({ kind: "delete", path: logicalPath })
      } else {
        const current = work.get(resolved.relative)
        if (current === undefined) throw new Error(`Workflow authoring patch path does not exist: ${logicalPath}`)
        operations.push({ kind: "update", path: logicalPath, content: applyUpdateHunks(current, command.body) })
      }
    }
    return this.applyPatch({
      sessionId,
      expectedWorkingRevision: session.workingRevision,
      operations,
      auditOperation: "patch",
    })
  }

  async applyPatch(input: {
    sessionId: string
    expectedWorkingRevision: string
    operations: readonly WorkflowStructuredPatchOperation[]
    auditOperation?: "patch" | "structured-patch"
  }): Promise<{ paths: string[]; revision: string }> {
    return this.store.withExclusiveLock(this.lockPath(input.sessionId), () => this.applyPatchUnlocked(input))
  }

  private async applyPatchUnlocked(input: {
    sessionId: string
    expectedWorkingRevision: string
    operations: readonly WorkflowStructuredPatchOperation[]
    auditOperation?: "patch" | "structured-patch"
  }): Promise<{ paths: string[]; revision: string }> {
    if (input.operations.length === 0) throw new Error("Workflow authoring structured patch is empty")
    const session = await this.readMetadata(input.sessionId)
    const actualRevision = await this.workRevision(input.sessionId)
    if (input.expectedWorkingRevision !== actualRevision) {
      throw new Error(`Workflow authoring revision conflict: expected ${input.expectedWorkingRevision}, current ${actualRevision}`)
    }
    const work = new Map((await this.mountFiles(input.sessionId, "work")).map((file) => [file.path, file.content]))
    const normalized = input.operations.map((operation) => {
      const resolved = this.resolve(input.sessionId, operation.path.startsWith("/") ? operation.path : `/work/${operation.path}`)
      if (resolved.mount !== "/work" || !resolved.relative) {
        throw new Error("Workflow authoring structured patch operations are restricted to /work files")
      }
      return { operation, relative: resolved.relative, logicalPath: `/work/${resolved.relative}` }
    })
    const unique = new Set(normalized.map((item) => item.relative))
    if (unique.size !== normalized.length) throw new Error("Workflow authoring structured patch contains duplicate paths")
    for (const item of normalized) {
      const exists = work.has(item.relative)
      if (item.operation.kind === "add") {
        if (exists) throw new Error(`Workflow authoring patch path already exists: ${item.logicalPath}`)
        work.set(item.relative, item.operation.content)
      } else if (item.operation.kind === "update") {
        if (!exists) throw new Error(`Workflow authoring patch path does not exist: ${item.logicalPath}`)
        work.set(item.relative, item.operation.content)
      } else {
        if (!exists) throw new Error(`Workflow authoring patch path does not exist: ${item.logicalPath}`)
        work.delete(item.relative)
      }
    }
    const workFiles = [...work].map(([path, content]) => ({ path, content }))
    const revision = hashWorkflowSources(workFiles)
    const updated = this.deriveSession({
      ...session,
      workingRevision: revision,
      currentRevision: revision,
      diffRevision: undefined,
      validationRevision: undefined,
      dryRunRevision: undefined,
      diffResult: undefined,
      validationResult: undefined,
      dryRunProjection: undefined,
      proofSet: undefined,
      updatedAt: new Date().toISOString(),
    }, { base: session.baseRevision, working: revision })

    // Re-check immediately before the one authoritative tree swap. All operation
    // validation above is side-effect free, so a failure cannot expose a prefix.
    if (await this.workRevision(input.sessionId) !== actualRevision) {
      throw new Error(`Workflow authoring revision conflict: current revision changed during patch`)
    }
    await this.replaceSessionRoot(input.sessionId, updated, workFiles)
    const paths = normalized.map((item) => item.logicalPath)
    await this.appendAudit(input.sessionId, input.auditOperation ?? "structured-patch", { paths, revision })
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
    const changes: WorkflowAuthoringDiffResult["changes"] = paths.map((item) => {
      const kind: WorkflowAuthoringDiffResult["changes"][number]["kind"] = !base.has(item) ? "created"
        : !work.has(item) ? "deleted"
          : base.get(item) === work.get(item) ? "unchanged"
            : "modified"
      summary[kind] += 1
      return { path: `/work/${item}`, kind }
    })
    const result: WorkflowAuthoringDiffResult = { summary, changes }
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

  async listPublicationReceipts(sessionId: string): Promise<WorkflowPublicationReceipt[]> {
    await this.readMetadata(sessionId)
    const prefix = `${this.root(sessionId)}/publications`
    const paths = (await this.store.tree(prefix)).filter((item) => item.endsWith(".json"))
    const receipts = await Promise.all(paths.map(async (item) => (
      JSON.parse(await this.store.read(item)) as WorkflowPublicationReceipt
    )))
    return receipts.sort((left, right) => left.sequence - right.sequence || left.receiptId.localeCompare(right.receiptId))
  }

  async createAuthoringReceipt(input: {
    sessionId: string
    expectedWorkingRevision: string
    stage: WorkflowAuthoringReceipt["stage"]
    outcome: WorkflowAuthoringReceipt["outcome"]
  }): Promise<WorkflowAuthoringReceipt> {
    const session = await this.readMetadata(input.sessionId)
    if (session.workingRevision !== input.expectedWorkingRevision) {
      throw new Error(`Workflow authoring receipt revision conflict: expected ${input.expectedWorkingRevision}, current ${session.workingRevision}`)
    }
    if (input.outcome === "ready" && session.proofSet?.revision !== session.workingRevision) {
      throw new Error("Workflow ready receipt requires a complete current proof receipt set")
    }
    if (input.outcome === "published" && (
      session.publishedRevision !== session.workingRevision
      || session.dirty
      || !session.latestPublicationReceiptId
    )) {
      throw new Error("Workflow published receipt requires a clean current publication receipt")
    }
    const diagnosticCodes = (session.validationResult?.diagnostics ?? [])
      .map((item) => item.code)
    const boundedDiagnostics = diagnosticCodes.slice(0, 20)
    const receipt: WorkflowAuthoringReceipt = {
      kind: "workflow.authoringReceipt",
      receiptId: randomUUID(),
      authoringSessionId: session.sessionId,
      stage: input.stage,
      outcome: input.outcome,
      workingRevision: session.workingRevision,
      publishedRevision: session.publishedRevision,
      dirty: session.dirty,
      changedPaths: (session.diffResult?.changes ?? [])
        .filter((change) => change.kind !== "unchanged")
        .map((change) => change.path),
      proofReceiptIds: session.proofSet ? proofReceiptIds(session.proofSet) : [],
      publicationReceiptId: session.latestPublicationReceiptId,
      diagnosticCodes: boundedDiagnostics,
      diagnosticsTruncated: diagnosticCodes.length > boundedDiagnostics.length,
      nextAction: input.outcome === "published"
        ? "request_execution_authorization_or_finish"
        : input.outcome === "ready"
          ? "request_publication_authorization_or_finish"
          : input.outcome === "waiting"
            ? "await_user_decision"
            : "inspect_bounded_diagnostics",
      createdAt: new Date().toISOString(),
    }
    await this.store.writeAtomic(
      this.authoringReceiptPath(session.sessionId, receipt.receiptId),
      `${JSON.stringify(receipt, null, 2)}\n`,
    )
    await this.appendAudit(session.sessionId, "authoring-receipt", {
      receiptId: receipt.receiptId,
      stage: receipt.stage,
      outcome: receipt.outcome,
      revision: receipt.workingRevision,
    })
    return receipt
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
      proofSet: undefined,
      updatedAt: new Date().toISOString(),
    })
    await this.appendAudit(sessionId, "validate", { revision })
    return { valid: true, revision, result }
  }

  async dryRun(sessionId: string, acceptancePolicy?: WorkflowAcceptancePolicy): Promise<{
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
    const now = new Date().toISOString()
    let proofSet: WorkflowPublicationProofSet | undefined
    if (session.diffRevision === revision && session.diffResult && session.validationResult.binding) {
      const definitionFqn = session.validationResult.binding.definition.fqn
      const hasEffectNodes = Array.isArray((projection as any).effectNodeIds)
        && (projection as any).effectNodeIds.length > 0
      const policy: WorkflowAcceptancePolicy = acceptancePolicy ?? {
        requirement: "not_required",
        source: hasEffectNodes
          ? "canonical-profile:static-publication-default"
          : "canonical-profile:effect-free-default",
      }
      if (!/^(?:canonical-profile|definition-policy):[A-Za-z0-9_.:/-]+$/.test(policy.source)) {
        throw new Error("Workflow acceptance policy source must be canonical-profile or definition-policy authority")
      }
      const common = { revision, bundleDigest: revision, createdAt: now }
      const acceptanceDispositionReceipt: WorkflowPublicationProofSet["acceptanceDispositionReceipt"] = {
        ...common,
        kind: "workflow.acceptanceDispositionReceipt",
        receiptId: proofReceiptId("acceptance", sessionId, revision, `${policy.requirement}:${policy.source}`),
        disposition: policy.requirement,
        policySource: policy.source,
      }
      let candidateAcceptanceReceipt: WorkflowPublicationProofSet["candidateAcceptanceReceipt"]
      if (policy.requirement === "required") {
        if (!policy.fixtureId) throw new Error("Required workflow candidate acceptance needs an explicit fixture id")
        if (!this.candidateHarness) throw new Error("Required workflow candidate acceptance needs an installed isolated fixture harness")
        const candidate = await this.candidateHarness.run({ session, files, projection, fixtureId: policy.fixtureId })
        if (
          candidate.isolated !== true
          || candidate.realEffectDispatched !== false
          || candidate.runtime !== "canonical-depa-flows"
          || candidate.effectProvider !== "isolated-fixture"
        ) {
          throw new Error("Workflow candidate harness violated isolated effect contract")
        }
        candidateAcceptanceReceipt = {
          ...common,
          kind: "workflow.candidateAcceptanceReceipt",
          receiptId: proofReceiptId("candidate", sessionId, revision, policy.fixtureId),
          fixtureId: policy.fixtureId,
          outcome: candidate.outcome,
          evidenceDigest: digestJson(candidate.evidence),
          isolated: true,
          realEffectDispatched: false,
          runtime: "canonical-depa-flows",
          effectProvider: "isolated-fixture",
        }
        if (candidate.outcome !== "passed") {
          throw new Error(`Workflow isolated candidate acceptance did not pass: ${candidate.outcome}`)
        }
      }
      proofSet = {
        revision,
        bundleDigest: revision,
        diffReceipt: {
          ...common,
          kind: "workflow.diffReceipt",
          receiptId: proofReceiptId("diff", sessionId, revision, session.baseRevision),
          baseRevision: session.baseRevision,
          summary: session.diffResult.summary,
        },
        validationReceipt: {
          ...common,
          kind: "workflow.validationReceipt",
          receiptId: proofReceiptId("validation", sessionId, revision, definitionFqn),
          definitionFqn,
          diagnosticCount: session.validationResult.diagnostics.length,
        },
        staticProjectionReceipt: {
          ...common,
          kind: "workflow.staticProjectionReceipt",
          receiptId: proofReceiptId("static-projection", sessionId, revision, digestJson(projection)),
          projectionDigest: digestJson(projection),
          effectDispatched: false,
          acceptanceClaimed: false,
        },
        buildReceipt: {
          ...common,
          kind: "workflow.buildReceipt",
          receiptId: proofReceiptId("build", sessionId, revision, definitionFqn),
          definitionFqn,
          assemblyDigest: digestJson({ revision, definitionFqn, paths: files.map((file) => file.path).sort() }),
        },
        acceptanceDispositionReceipt,
        candidateAcceptanceReceipt,
      }
    }
    const updated = {
      ...session,
      currentRevision: revision,
      dryRunRevision: revision,
      dryRunProjection: projection,
      proofSet,
      updatedAt: now,
    }
    await this.writeMetadata(updated)
    await this.appendAudit(sessionId, "dry-run", { revision, projection })
    return { valid: true, revision, substrate: String(session.validationResult.substrate), projection }
  }

  async preparePublication(input: {
    sessionId: string
    acceptancePolicy?: WorkflowAcceptancePolicy
  }): Promise<{ revision: string; proofSet: WorkflowPublicationProofSet }> {
    await this.diff(input.sessionId)
    await this.validate(input.sessionId)
    await this.dryRun(input.sessionId, input.acceptancePolicy)
    const prepared = await this.readMetadata(input.sessionId)
    if (!prepared.proofSet) throw new Error("Workflow preparation did not produce a complete proof receipt set")
    await this.appendAudit(input.sessionId, "prepare-publication", {
      revision: prepared.workingRevision,
      proofReceiptIds: proofReceiptIds(prepared.proofSet),
    })
    return { revision: prepared.workingRevision, proofSet: prepared.proofSet }
  }

  async publish(input: { sessionId: string; confirmed: boolean; targetPath?: string }): Promise<Record<string, unknown>> {
    return this.store.withExclusiveLock(this.lockPath(input.sessionId), () => this.publishUnlocked(input))
  }

  private async publishUnlocked(input: { sessionId: string; confirmed: boolean; targetPath?: string }): Promise<Record<string, unknown>> {
    let session = await this.readMetadata(input.sessionId)
    if (!input.confirmed) {
      await this.appendAudit(input.sessionId, "publication-confirmation-required")
      return { status: "confirmation_required", sessionId: input.sessionId, effectDispatched: false }
    }
    const revision = await this.workRevision(input.sessionId)
    if (session.diffRevision !== revision || session.validationRevision !== revision || session.dryRunRevision !== revision) {
      const staleProofs = [
        session.diffRevision === revision ? null : "diff",
        session.validationRevision === revision ? null : "validation",
        session.dryRunRevision === revision ? null : "dry-run",
      ].filter(Boolean)
      throw new Error(`Workflow publication requires current diff, validation and dry-run revisions: ${JSON.stringify({
        currentRevision: revision,
        diffRevision: session.diffRevision ?? null,
        validationRevision: session.validationRevision ?? null,
        dryRunRevision: session.dryRunRevision ?? null,
        staleProofs,
        repairOrder: ["diff", "validate", "dry-run", "publish"],
      })}`)
    }
    const proofSet = session.proofSet
    const receipts = proofSet ? [
      proofSet.diffReceipt,
      proofSet.validationReceipt,
      proofSet.staticProjectionReceipt,
      proofSet.buildReceipt,
      proofSet.acceptanceDispositionReceipt,
      proofSet.candidateAcceptanceReceipt,
    ].filter(Boolean) as WorkflowProofReceiptBase[] : []
    const completeAndCurrent = proofSet?.revision === revision
      && proofSet.bundleDigest === revision
      && receipts.slice(0, 5).every((receipt) => receipt.revision === revision && receipt.bundleDigest === revision)
      && proofSet.staticProjectionReceipt.effectDispatched === false
      && proofSet.staticProjectionReceipt.acceptanceClaimed === false
      && (
        proofSet.acceptanceDispositionReceipt.disposition === "not_required"
          ? /^(?:canonical-profile|definition-policy):/.test(proofSet.acceptanceDispositionReceipt.policySource)
          : proofSet.candidateAcceptanceReceipt?.outcome === "passed"
            && proofSet.candidateAcceptanceReceipt.isolated === true
            && proofSet.candidateAcceptanceReceipt.realEffectDispatched === false
            && proofSet.candidateAcceptanceReceipt.runtime === "canonical-depa-flows"
            && proofSet.candidateAcceptanceReceipt.effectProvider === "isolated-fixture"
      )
    if (!completeAndCurrent) {
      throw new Error("Workflow publication requires a complete current proof receipt set")
    }
    const targetPath = safeRelative(
      input.targetPath?.trim()
        || String(session.target.path ?? session.target.id ?? "").trim(),
    )
    const pending = session.pendingPublication
    if (pending && (pending.revision !== revision || pending.targetPath !== targetPath)) {
      throw new Error(`Workflow publication has an unfinished attempt for another revision or target: ${pending.attemptId}`)
    }
    const attempt: WorkflowPendingPublication = pending ?? {
      attemptId: randomUUID(),
      revision,
      targetPath,
      startedAt: new Date().toISOString(),
    }
    if (!pending) {
      session = { ...session, pendingPublication: attempt, updatedAt: new Date().toISOString() }
      await this.writeMetadata(session)
    }
    const files = await this.mountFiles(input.sessionId, "work")
    await this.store.replaceTreeAtomic(targetPath, files)
    const publishedFiles = await Promise.all(files.map(async (file) => ({
      path: file.path,
      content: await this.store.read(`${targetPath}/${file.path}`),
    })))
    const publishedSources = Object.fromEntries(
      publishedFiles.filter((file) => file.path.endsWith(".xnl")).map((file) => [file.path, file.content]),
    )
    const artifactDigest = hashWorkflowSources(publishedFiles)
    if (artifactDigest !== revision) {
      throw new Error(`Published workflow readback digest mismatch: expected ${revision}, received ${artifactDigest}`)
    }
    const readback = this.resources.load({ form: session.form, sources: publishedSources })
    if (!readback.binding || readback.diagnostics.length > 0) {
      const details = readback.diagnostics.map((item) => `${item.code}: ${item.message}`).join("; ")
      throw new Error(`Published workflow failed canonical readback${details ? `: ${details}` : ""}`)
    }
    if (readback.binding.definition.fqn !== session.validationResult?.binding?.definition.fqn) {
      throw new Error("Published workflow canonical readback changed definition identity")
    }
    await this.store.replaceTreeAtomic(`${this.root(input.sessionId)}/base`, publishedFiles)
    const existingReceipts = await this.listPublicationReceipts(input.sessionId)
    const recoveredReceipt = existingReceipts.find((item) => item.receiptId === attempt.attemptId)
    if (recoveredReceipt && (
      recoveredReceipt.revision !== revision
      || recoveredReceipt.targetPath !== targetPath
      || recoveredReceipt.artifactDigest !== artifactDigest
    )) {
      throw new Error(`Workflow publication recovery receipt does not match pending attempt: ${attempt.attemptId}`)
    }
    const receipt: WorkflowPublicationReceipt = recoveredReceipt ?? {
      kind: "workflow.publicationReceipt",
      receiptId: attempt.attemptId,
      sequence: existingReceipts.length + 1,
      sessionId: input.sessionId,
      revision,
      targetPath,
      definitionFqn: readback.binding.definition.fqn,
      workflowRef: `resource://${readback.binding.definition.fqn}`,
      contract: {
        inputPorts: [...((readback.binding.definition as any).contract?.inputPorts ?? [])],
        outputPorts: [...((readback.binding.definition as any).contract?.outputPorts ?? [])],
      },
      artifactDigest,
      proofReceiptIds: proofReceiptIds(proofSet),
      createdAt: new Date().toISOString(),
    }
    if (!recoveredReceipt) {
      await this.store.writeAtomic(
        this.publicationPath(input.sessionId, receipt.receiptId),
        `${JSON.stringify(receipt, null, 2)}\n`,
      )
    }
    const updated: WorkflowAuthoringSession = this.deriveSession({
      ...session,
      status: "published",
      baseRevision: revision,
      workingRevision: revision,
      publishedRevision: revision,
      latestPublicationReceiptId: receipt.receiptId,
      pendingPublication: undefined,
      currentRevision: revision,
      updatedAt: new Date().toISOString(),
    }, { base: revision, working: revision })
    await this.writeMetadata(updated)
    await this.appendAudit(input.sessionId, "publish", {
      revision,
      targetPath,
      readbackFqn: readback.binding.definition.fqn,
      receiptId: receipt.receiptId,
      artifactDigest,
    })
    return {
      status: "published",
      sessionId: input.sessionId,
      revision,
      receipt,
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
