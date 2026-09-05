import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Offline execution-closure baseline. Run from any directory:
 *   bun run /path/to/cell/scripts/runtimeClosureRegression.ts [all|conversation|context|holon|configuration]
 *
 * Each listed TS test file gets a fresh Bun process, so module mocks and
 * registries cannot leak between suites. The existing suites use scripted
 * providers and temporary session directories; do not add live-provider tests.
 * No build, dependency installation, snapshot updates or fixture recording.
 */
export const groups = {
  conversation: [
    // Raw authority -> history/prompt/provider projections and tool pairing.
    "AIAgent/runtime/conversation_raw_state_views.test.ts",
    "AIAgent/conversation_domain_runtime.test.ts",
    "AIAgent/conversation_domain_projection.test.ts",
    "AIAgent/conversation/message_assembly_derivation.test.ts",
    "AIAgent/conversation/conversation_persistence_runtime_isolation.test.ts",
    "AIAgent/conversation/conversation_persistence_adapters.test.ts",
    "AIAgent/conversation/conversation_capsule_structure.test.ts",
    "AIAgent/conversation/provider_equivalence_gate.test.ts",
    "AIAgent/runtime/actor_provider_context_fact.test.ts",
    "AIAgent/runtime/provider_context_projections.test.ts",
    // Exact fork/rewind frontiers and real-file transaction/restart recovery.
    "AIAgent/conversation/conversation_session_fork.red.test.ts",
    "AIAgent/conversation/conversation_session_rewind.red.test.ts",
    "AIAgent/runtime/conversation_session_fork_persistence.test.ts",
    "AIAgent/runtime/local_conversation_persistence_repository.test.ts",
  ],
  context: [
    "AIAgent/runtime/provider_context_multi_actor_recovery.test.ts",
    "AIAgent/runtime/provider_context_epoch_transition.test.ts",
    // Actual heterogeneous prefix + workspace AGENTS + canonical pipeline.
    "workflow/workflow_app_resource_registry.test.ts",
    "AIAgent/runtime/runtime_profile_composer.test.ts",
    "AIAgent/runtime/context_control_plane.test.ts",
    "AIAgent/runtime/context_resource_facts.test.ts",
    "AIAgent/provider_context_fact_wire_profile.test.ts",
    "workflow/workflow_stage_context_provider_fact.test.ts",
    "workflow/deepseek_prefix_cache_stability.test.ts",
  ],
  holon: [
    // Accepted-effect receipt, crash replay and shared/fresh runtime ownership.
    "workflow/holon_task_pump_journal.test.ts",
    "workflow/holon_task_pump_journal_memory.test.ts",
    "workflow/holon_task_runtime_routes_explicit.test.ts",
    "workflow/holon_task_runtime_composition.test.ts",
    "workflow/standalone_holon_task_runtime_architecture.test.ts",
    "workflow/holon_task_runtime_processor.test.ts",
    "workflow/holon_task_runtime_service.test.ts",
    "workflow/holon_task_runtime_capability.test.ts",
    "workflow/holon_task_member_runtime_policy.test.ts",
    "workflow/holon_execution_binding_registry.test.ts",
    "workflow/standalone_holon_task_runtime_file_e2e.test.ts",
    "workflow/standalone_holon_task_runtime_product_routing.test.ts",
    "workflow/workflow_holon_task_runtime_adapter.test.ts",
    "workflow/workflow_complete_agent_ctrl_data_e2e.test.ts",
    "workflow/ctrl_workflow_runtime.test.ts",
    "workflow/data_workflow_runtime.test.ts",
  ],
  configuration: [
    "../../ai-support/tests/model_config_boundaries.test.ts",
    "../../ai-support/tests/runtime_snapshot_secret_redaction.test.ts",
    "../../ai-support/tests/local_permission_config_boundaries.test.ts",
    "../../ai-core-logic/tests/local_permission_rules.test.ts",
    "AIAgent/local_permission_evaluator.test.ts",
    "AIAgent/local_permission_questionnaire.test.ts",
    "AIAgent/local_permission_exec_mode.test.ts",
    "../../../scripts/runtimeClosureBoundaries.test.ts",
  ],
} as const

type Group = keyof typeof groups
const cellRoot = fileURLToPath(new URL("../", import.meta.url))
const testRoot = path.join(cellRoot, "packages/ai-organ-logic/tests")

type FileResult = { exitCode: number; signalCode: string | null; timedOut: boolean }
type RunFile = (testPath: string) => Promise<FileResult>

async function runFileInFreshProcess(testPath: string): Promise<FileResult> {
  if (!existsSync(testPath)) throw new Error(`Missing test file: ${testPath}`)
  const child = Bun.spawn({
    cmd: [process.execPath, "test", "--no-install", "--timeout", "30000", testPath],
    cwd: cellRoot,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  })
  // Bound import/hook hangs as well as individual test timeouts.
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, 120_000)
  try {
    const exitCode = await child.exited
    return { exitCode, signalCode: child.signalCode, timedOut }
  } finally {
    clearTimeout(timer)
  }
}

export async function runRuntimeClosureRegression(
  args: string[],
  runFile: RunFile = runFileInFreshProcess,
  report: Pick<Console, "log" | "error"> = console,
): Promise<number> {
  const selection = args[0] ?? "all"
  if (args.length > 1 || (selection !== "all" && !Object.hasOwn(groups, selection))) {
    report.error("Usage: bun run runtimeClosureRegression.ts [all|conversation|context|holon|configuration]")
    return 2
  }

  const selected: Group[] = selection === "all" ? Object.keys(groups) as Group[] : [selection as Group]
  const failures: string[] = []
  let total = 0
  for (const group of selected) {
    for (const file of groups[group]) {
      total += 1
      const label = `${group}/${file}`
      report.log(`\n[${total}] ${label}`)
      try {
        const { exitCode, signalCode, timedOut } = await runFile(path.join(testRoot, file))
        if (timedOut || exitCode !== 0 || signalCode !== null) {
          report.error(`FAIL: ${label} (exit=${exitCode}, signal=${signalCode}, timeout=${timedOut})`)
          failures.push(label)
        }
      } catch (error) {
        report.error(`FAIL: ${label}`, error)
        failures.push(label)
      }
    }
  }

  report.log(`\nExecution closure regression: ${total - failures.length}/${total} files passed.`)
  for (const failure of failures) report.error(`  FAIL ${failure}`)
  return failures.length > 0 ? 1 : 0
}

if (import.meta.main) process.exitCode = await runRuntimeClosureRegression(process.argv.slice(2))
