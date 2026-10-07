import { readFileSync, realpathSync } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const logic = path.join(root, "cell/packages/ai-organ-logic")
function version(name: string): string {
  let directory = path.dirname(Bun.resolveSync(name === "halfcode-compiler.xnl" ? `${name}/resource-core` : name, logic))
  while (directory !== path.dirname(directory)) {
    try { const data = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")); if (data.name === name) return data.version }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    directory = path.dirname(directory)
  }
  throw new Error(`Package manifest unavailable: ${name}`)
}
const packages = ["holarchy-core-contract", "holarchy-core-logic", "holarchy-file-xnl-capsule", "holarchy-file-xnl-logic", "holarchy-test-support", "depa-inference-capsule", "xnl-core", "halfcode-compiler.xnl", "ai-workflow-contract", "ai-workflow-logic"]
const versions = Object.fromEntries(packages.map(name => [name, version(name)]))
const candidates = JSON.parse(readFileSync(path.join(root, "holon-candidates.json"), "utf8"))
if (candidates.publicFileRelease) {
  // The old lock also lists historical external candidates (e.g. inference 0.1.0).
  // Current resolution is governed by consumer manifests and the selected public release.
  const consumer = JSON.parse(readFileSync(path.join(logic, "package.json"), "utf8"))
  for (const [name, actual] of Object.entries(versions)) {
    const declared = consumer.dependencies?.[name] ?? consumer.devDependencies?.[name]
    if (typeof declared !== "string" || !/^\d+\.\d+\.\d+$/.test(declared) || declared !== actual) throw new Error(`Declared consumer version mismatch: ${name}`)
  }
  const release = JSON.parse(readFileSync(path.join(root, candidates.publicFileRelease), "utf8"))
  if (release.schema !== "holarchy.public-file-release/v1") throw new Error("Public release provenance unavailable")
  const published = release.status === "published-public-release"
  const lock = readFileSync(path.join(root, "bun.lock"), "utf8")
  let publication: any
  if (published) {
    if (release.publication?.registry !== "https://registry.npmjs.com" || release.publication?.receipt !== "publication.json") throw new Error("Unexpected public registry receipt")
    const bytes = readFileSync(path.join(root, "artifacts/holarchy-public-file/publication.json"))
    if (createHash("sha256").update(bytes).digest("hex") !== release.publication.receiptSha256) throw new Error("Publication receipt differs")
    publication = JSON.parse(bytes.toString("utf8"))
    if (!publication.completedAt || publication.registry !== release.publication.registry) throw new Error("Registry publication incomplete")
  }
  function packageRoot(name: string, from: string): string {
    let directory = path.dirname(realpathSync(Bun.resolveSync(name, from)))
    while (directory !== path.dirname(directory)) {
      try { if (JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")).name === name) return directory }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      directory = path.dirname(directory)
    }
    throw new Error(`Public package root unavailable: ${name}`)
  }
  for (const item of release.packages) {
    const bytes = readFileSync(path.join(root, "artifacts/holarchy-public-file", item.filename))
    if (createHash("sha256").update(bytes).digest("hex") !== item.sha256 || "sha512-" + createHash("sha512").update(bytes).digest("base64") !== item.integrity) throw new Error(`Public release integrity differs: ${item.name}`)
    const target = item.name === "holarchy-file-xnl-support" ? packageRoot("holarchy-file-xnl-capsule", logic) : logic
    const installedRoot = packageRoot(item.name, target)
    if (published) {
      const entry = publication.packages.find((p: any) => p.name === item.name && p.version === item.version)
      if (entry?.status !== "registry-verified" || entry.integrity !== item.integrity || entry.sha256 !== item.sha256) throw new Error(`Publication identity mismatch: ${item.name}`)
      const locked = lock.split(/\r?\n/).find(line => line.includes(`"${item.name}": ["${item.name}@${item.version}",`))
      if (!locked?.includes(item.integrity) || !installedRoot.startsWith(path.join(root, "node_modules") + path.sep)) throw new Error(`Registry installation differs: ${item.name}`)
    } else if (installedRoot !== path.join(root, ".tmp/public-file-release/packages", item.name)) throw new Error(`Unexpected public candidate owner: ${item.name}`)
    const installed = JSON.parse(readFileSync(path.join(installedRoot, "package.json"), "utf8"))
    if (installed.version !== item.version) throw new Error(`Public release version mismatch: ${item.name}`)
  }
} else {
  for (const item of candidates.packages) if (item.name in versions && versions[item.name] !== item.version) throw new Error(`Candidate resolution mismatch: ${item.name}`)
}
process.stdout.write(`${JSON.stringify({ runtime: `bun-${Bun.version}`, versions, testSource: "cell/tsconfig.json" })}\n`)
const tests = ["file_xnl_holon_issuer_fixture", "materialize_file_xnl_holon_e2e_resource", "holon_native_history_fixture", "holon_shared_scenario_adoption", "holon_execution_binding_contract", "holon_task_runtime_definition_projection", "holon_task_runtime_capability", "holon_task_runtime_processor", "holon_task_runtime_service", "holon_execution_binding_registry", "standalone_holon_task_runtime_file_e2e", "standalone_holon_task_runtime_product_routing", "holon_repair_resource_product_loop", "holon_product_provider_transport", "holon_product_session_prefix", "holon_task_os_process_recovery", "holon_product_process_recovery", "holon_product_live_budget", "holon_product_verification_gate"]
const checks = [
  { cwd: logic, args: ["run", "typecheck:holon-execution-binding"] },
  { cwd: logic, args: ["run", "typecheck:holon-task-runtime"] },
  { cwd: path.join(root, "cell/packages/holarchy-eidolon-adapter"), args: ["run", "typecheck"] },
  { cwd: path.join(root, "cell/packages/holarchy-eidolon-adapter"), args: ["test"] },
  { cwd: logic, args: ["test", ...tests.map(name => `tests/workflow/${name}.test.ts`), "--timeout", "65000"] },
]
for (const check of checks) {
  const child = Bun.spawn([process.execPath, ...check.args], { cwd: check.cwd, env: { ...process.env, EIDOLON_TEST_TSCONFIG: path.join(root, "cell/tsconfig.json"), EIDOLON_HOLON_LIVE: "0" }, stdout: "inherit", stderr: "inherit" })
  const exit = await child.exited
  if (exit !== 0) process.exit(exit)
}
