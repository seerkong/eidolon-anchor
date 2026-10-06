import path from "node:path"
import { fileURLToPath } from "node:url"
import ts from "../backend/node_modules/typescript/lib/typescript.js"

// Compare source revisions with one installed dependency graph, without checking
// out either revision. This gate does not claim that the full typecheck passes.
const DEFAULT_BASELINE = "bc1721136715a75fcd46d9d5eac4ca7f6e595df1"
const root = fileURLToPath(new URL("../", import.meta.url))
const args = process.argv.slice(2)
let baselineRef = DEFAULT_BASELINE
let json = false
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--json") json = true
  else if (args[index] === "--baseline" && args[index + 1] && !args[index + 1]!.startsWith("-")) {
    baselineRef = args[++index]!
  } else if (args[index] === "--help") {
    console.log("bun scripts/check-anchor-web-types.ts [--baseline <commit>] [--json]\nExit 0: no added diagnostics; 1: added diagnostics; 2: invalid input or unavailable baseline.")
    process.exit(0)
  } else {
    console.error(`Unknown or incomplete argument: ${args[index]}`)
    process.exit(2)
  }
}

function git(...gitArgs: string[]): string {
  const result = Bun.spawnSync(["git", ...gitArgs], { cwd: root })
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr).trim())
  return new TextDecoder().decode(result.stdout)
}

try {
  const revision = git("rev-parse", "--verify", `${baselineRef}^{commit}`).trim()
  const tracked = new Set(git("ls-tree", "-rz", "--name-only", revision).split("\0").filter(Boolean))
  const originals = new Map<string, string>()
  for (const relative of git("diff", "--name-only", "-z", revision).split("\0")) {
    if (tracked.has(relative) && /\.(?:[cm]?tsx?|json)$/.test(relative)) {
      originals.set(path.join(root, relative), git("show", `${revision}:${relative}`))
    }
  }
  const isRepositoryFile = (file: string) => {
    const relative = path.relative(root, path.resolve(file))
    return !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      && !relative.split(path.sep).includes("node_modules")
  }
  const baselineExists = (file: string): boolean => isRepositoryFile(file)
    ? tracked.has(path.relative(root, path.resolve(file))) : ts.sys.fileExists(file)
  const baselineRead = (file: string): string | undefined => baselineExists(file)
    ? originals.get(path.resolve(file)) ?? ts.sys.readFile(file) : undefined
  const directoryExists = (directory: string): boolean => isRepositoryFile(directory)
    ? path.resolve(directory) === path.resolve(root) || [...tracked].some(file => file.startsWith(`${path.relative(root, path.resolve(directory))}/`))
    : Boolean(ts.sys.directoryExists(directory))

  // Enumerate the Git tree, so deleting a current file cannot silently remove
  // its baseline diagnostics. The gate intentionally targets cell/tsconfig.json.
  const baselineReadDirectory: typeof ts.sys.readDirectory = (directory, extensions, excludes, includes, depth) => {
    const glob = (pattern: string) => new Bun.Glob(/\.[^/]+$/.test(pattern) || pattern.endsWith("**")
      ? pattern : `${pattern.replace(/\/$/, "")}/**/*`)
    const includeGlobs = (includes ?? ["**/*"]).map(glob)
    const excludeGlobs = (excludes ?? []).map(glob)
    return [...tracked].map(file => path.join(root, file)).filter(file => {
      const relative = path.relative(directory, file).split(path.sep).join("/")
      return !relative.startsWith("../") && !path.isAbsolute(relative)
        && (!extensions || extensions.some(extension => file.endsWith(extension)))
        && (depth === undefined || relative.split("/").length <= depth + 1)
        && includeGlobs.some(pattern => pattern.match(relative))
        && !excludeGlobs.some(pattern => pattern.match(relative))
    })
  }

  function diagnostics(baseline: boolean) {
    const configFile = path.join(root, "cell/tsconfig.json")
    const readFile = baseline ? baselineRead : ts.sys.readFile
    const config = ts.readConfigFile(configFile, readFile)
    if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, " "))
    const parseHost = baseline ? {
      ...ts.sys, fileExists: baselineExists, readFile, readDirectory: baselineReadDirectory,
    } : ts.sys
    const parsed = ts.parseJsonConfigFileContent(config.config, parseHost, path.dirname(configFile), { noEmit: true })
    if (parsed.errors.length || !parsed.fileNames.length) {
      throw new Error(`Invalid ${baseline ? "baseline" : "current"} config: ${parsed.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, " ")).join("; ")}`)
    }
    const host = ts.createCompilerHost(parsed.options)
    if (baseline) {
      host.fileExists = baselineExists
      host.directoryExists = directoryExists
      host.readFile = readFile
      host.getSourceFile = (file, languageVersion) => {
        const content = readFile(file)
        return content === undefined ? undefined : ts.createSourceFile(file, content, languageVersion, true)
      }
    }
    const program = ts.createProgram(parsed.fileNames, parsed.options, host)
    return {
      roots: parsed.fileNames.length,
      errors: ts.getPreEmitDiagnostics(program).map(error => ({
        file: error.file ? path.relative(root, error.file.fileName) : "config",
        code: error.code,
        line: error.file && error.start !== undefined ? error.file.getLineAndCharacterOfPosition(error.start).line + 1 : undefined,
        message: ts.flattenDiagnosticMessageText(error.messageText, " "),
      })),
    }
  }
  const baseline = diagnostics(true)
  const current = diagnostics(false)
  const key = (error: typeof baseline.errors[number]) => `${error.file}:${error.code}:${error.message}`
  const remaining = [...baseline.errors]
  const added = current.errors.filter(error => {
    const index = remaining.findIndex(old => key(old) === key(error))
    if (index < 0) return true
    remaining.splice(index, 1)
    return false
  })
  const caveat = "Same currently installed dependencies in both runs. This checks added diagnostics only; it is not a full typecheck pass."
  if (json) console.log(JSON.stringify({ revision, caveat, baseline, current, added, removed: remaining }, null, 2))
  else {
    console.log(`Anchor type regression gate: ${added.length ? "FAIL" : "PASS"} (baseline ${revision})`)
    console.log(`Diagnostics: baseline ${baseline.errors.length}; current ${current.errors.length}; added ${added.length}.`)
    console.log(caveat)
    for (const error of added) console.error(`${error.file}:${error.line ?? 0} TS${error.code}: ${error.message}`)
  }
  process.exitCode = added.length ? 1 : 0
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 2
}
