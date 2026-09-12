import { readFileSync } from "node:fs"
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
for (const item of candidates.packages) if (item.name in versions && versions[item.name] !== item.version) throw new Error(`Candidate resolution mismatch: ${item.name}`)
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
