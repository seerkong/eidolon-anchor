import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

type Graph = Map<string, string[]>
type Manifest = { name: string } & Record<string, unknown>

/** AST extraction includes type-only edges and reexports: erasure cannot hide ownership. */
export function sourceImports(source: string, onUnresolved?: () => void): string[] {
  const result = new Set<string>()
  const file = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true)
  const add = (node: ts.Node | undefined) => {
    if (node && ts.isStringLiteralLike(node)) result.add(node.text)
    else onUnresolved?.()
  }
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) add(node.moduleSpecifier)
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal)
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression)
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) add(node.arguments[0])
    ts.forEachChild(node, visit)
  }
  visit(file)
  return [...result]
}

/** Return all non-trivial SCCs, including self loops; no ignored component list. */
export function stronglyConnected(graph: Graph): string[][] {
  let next = 0
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const active = new Set<string>()
  const components: string[][] = []
  const visit = (node: string) => {
    index.set(node, next)
    low.set(node, next++)
    stack.push(node)
    active.add(node)
    for (const target of graph.get(node) ?? []) {
      if (!graph.has(target)) continue
      if (!index.has(target)) { visit(target); low.set(node, Math.min(low.get(node)!, low.get(target)!)) }
      else if (active.has(target)) low.set(node, Math.min(low.get(node)!, index.get(target)!))
    }
    if (low.get(node) !== index.get(node)) return
    const component: string[] = []
    let member: string
    do { member = stack.pop()!; active.delete(member); component.push(member) } while (member !== node)
    if (component.length > 1 || graph.get(node)?.includes(node)) components.push(component.sort())
  }
  for (const node of graph.keys()) if (!index.has(node)) visit(node)
  return components
}

const dependencySections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const
export function checkManifestBoundary(manifest: Manifest): string[] {
  if (manifest.name !== "@cell/ai-support") return []
  return dependencySections.flatMap(section => (
    Object.hasOwn((manifest[section] ?? {}) as object, "@cell/ai-organ-logic")
      ? [`${manifest.name} ${section} -> @cell/ai-organ-logic`] : []
  ))
}

const selectedRules = [
  "ai-organ-logic/src/conversationCapsule/internals/domainRuntime.ts",
  "ai-organ-logic/src/conversationCapsule/internals/derivations.ts",
  "ai-organ-logic/src/organization/HolonTaskPumpJournal.ts",
  "ai-organ-logic/src/organization/HolonTaskRuntimeRoutes.ts",
  "ai-organ-logic/src/organization/HolonTaskRuntimeComposition.ts",
  "ai-core-logic/src/llm/ModelConfigRules.ts",
  "ai-core-logic/src/llm/ProviderOptions.ts",
  "ai-core-logic/src/llm/DeepSeekModelCapabilities.ts",
  "ai-core-logic/src/permissions/LocalPermissionRules.ts",
  "ai-persistence-logic/src/ConversationProjection.ts",
  "ai-persistence-logic/src/ConversationRecovery.ts",
  "ai-persistence-logic/src/ProviderContextTransitionEvidence.ts",
]

export function analyzeSources(sources: Map<string, string>) {
  const graph: Graph = new Map(), violations: string[] = []
  const resolve = (from: string, specifier: string): string | undefined => {
    let base: string
    if (specifier.startsWith(".")) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier))
    else if (specifier.startsWith("@cell/")) {
      const [pkg, ...rest] = specifier.slice(6).split("/")
      base = `${pkg}/src/${rest.length ? rest.join("/") : "index"}`
    } else return undefined
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`, base.replace(/\.js$/, ".ts")]) {
      if (sources.has(candidate)) return candidate
    }
    // Preserve unresolved owner identity, so nonexistent forbidden targets cannot evade the gate.
    return base
  }
  for (const [file, source] of sources) {
    const imports = sourceImports(source, () => {
      if (file.startsWith("ai-support/src/") || selectedRules.includes(file)) {
        violations.push(`unresolved dynamic dependency in selected closure: ${file}`)
      }
    })
    graph.set(file, imports.map(specifier => resolve(file, specifier)).filter((value): value is string => !!value))
  }
  const pathTo = (start: string, forbidden: (file: string) => boolean): string[] | null => {
    const seen = new Set([start]), queue: string[][] = [[start]]
    for (let i = 0; i < queue.length; i++) {
      const route = queue[i]!
      for (const target of graph.get(route.at(-1)!) ?? []) {
        if (forbidden(target)) return [...route, target]
        if (!seen.has(target)) { seen.add(target); queue.push([...route, target]) }
      }
    }
    return null
  }
  for (const file of sources.keys()) {
    if (!file.startsWith("ai-support/src/")) continue
    const route = pathTo(file, target => target.startsWith("ai-organ-logic/"))
    if (route) violations.push(`support reverse edge: ${route.join(" -> ")}`)
  }
  for (const file of selectedRules) {
    if (!sources.has(file)) continue
    const route = pathTo(file, target => target.startsWith("ai-support/"))
    if (route) violations.push(`rule reaches concrete support: ${route.join(" -> ")}`)
  }
  const cycles = stronglyConnected(graph)
  for (const cycle of cycles) {
    if (cycle.some(file => selectedRules.includes(file))) violations.push(`selected rule cycle: ${cycle.join(" -> ")}`)
  }
  return { graph, violations, cycles }
}

export function inspectWorkspace(packagesRoot: string) {
  const sources = new Map<string, string>(), manifests = new Map<string, Manifest>()
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (/\.tsx?$/.test(entry.name)) sources.set(path.relative(packagesRoot, absolute).split(path.sep).join("/"), readFileSync(absolute, "utf8"))
    }
  }
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const directory = path.join(packagesRoot, entry.name)
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      if (child.name === "src" && child.isDirectory()) walk(path.join(directory, "src"))
      if (child.name === "package.json") {
        const manifest = JSON.parse(readFileSync(path.join(directory, child.name), "utf8")) as Manifest
        manifests.set(manifest.name, manifest)
      }
    }
  }
  const result = analyzeSources(sources)
  for (const file of selectedRules) if (!sources.has(file)) result.violations.push(`selected rule missing: ${file}`)
  for (const manifest of manifests.values()) result.violations.push(...checkManifestBoundary(manifest))
  const manifestGraph: Graph = new Map([...manifests].map(([name, manifest]) => [name,
    dependencySections.flatMap(section => Object.keys((manifest[section] ?? {}) as object)).filter(target => manifests.has(target)),
  ]))
  return { ...result, manifestCycles: stronglyConnected(manifestGraph), sourceCount: sources.size }
}

if (import.meta.main) {
  const report = inspectWorkspace(fileURLToPath(new URL("../packages/", import.meta.url)))
  console.log(JSON.stringify({ sourceCount: report.sourceCount, violations: report.violations,
    sourceCycles: report.cycles, manifestCycles: report.manifestCycles }, null, 2))
  process.exitCode = report.violations.length ? 1 : 0
}
