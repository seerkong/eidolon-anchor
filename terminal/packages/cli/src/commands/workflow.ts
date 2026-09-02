import path from "node:path"
import type { CommandModule } from "yargs"

import {
  createWorkflowComponent,
  type WorkflowComponent,
  type WorkflowComponentOptions,
} from "@cell/ai-organ-logic/workflow"
import {
  readHeadlessInput,
  runHeadlessExec,
  runNativeWorkflowTool,
  type HeadlessExecOptions,
  type HeadlessExecResult,
  type NativeWorkflowToolOptions,
} from "@terminal/organ-support"

export type WorkflowInitArgs = {
  form?: "ai-data" | "ai-ctrl" | "AIDataWorkflow" | "AICtrlWorkflow"
  name?: string
  fqn?: string
  description?: string
  target?: string
  json?: boolean
  sessionId?: string
  template?: string
  prebuilt?: string
}

export type WorkflowValidateArgs = {
  ref: string
  json?: boolean
}

export type WorkflowInspectArgs = {
  json?: boolean
}

export type WorkflowNaturalAuthorArgs = {
  requirement?: string
  instruction?: string
  ref?: string
  form?: "auto" | "ai-data" | "ai-ctrl"
  dryRun?: boolean
  publish?: boolean
  model?: string
  profile?: string
  timeout?: number
  json?: boolean
}

export type WorkflowAgentArgs = {
  requirement?: string
  form?: "auto" | "ai-data" | "ai-ctrl"
  session?: string
  publish?: boolean
  execute?: boolean
  yes?: boolean
  model?: string
  profile?: string
  timeout?: number
  outputTrace?: string
  captureProviderRequests?: boolean
  json?: boolean
}

export type WorkflowRuntimeArgs = {
  ref?: string
  instanceId?: string
  runId?: string
  input?: string
  output?: string
  patch?: string
  nodeId?: string
  allowPartial?: boolean
  model?: string
  profile?: string
  timeout?: number
  captureRuntimeEvidence?: boolean
  json?: boolean
  yes?: boolean
  materialRef?: string
  revision?: string
  sourcePath?: string
  destinationPath?: string
  port?: string
  appResourceId?: string
  session?: string
}

export type WorkflowCommandProcessLike = Pick<NodeJS.Process, "env" | "cwd" | "stdout" | "stderr"> & {
  exitCode?: number
}

export type WorkflowCommandDeps = {
  createWorkflowComponent: (options?: WorkflowComponentOptions) => WorkflowComponent
  processLike: WorkflowCommandProcessLike
  runHeadlessExec?: (options: HeadlessExecOptions) => Promise<HeadlessExecResult>
  readHeadlessInput?: (prompt?: string) => Promise<string | undefined>
  runNativeWorkflowTool?: (options: NativeWorkflowToolOptions) => Promise<unknown>
  reportError: (message: string) => void
}

const DEFAULT_WORKFLOW_COMMAND_DEPS: WorkflowCommandDeps = {
  createWorkflowComponent,
  processLike: process,
  runHeadlessExec,
  readHeadlessInput,
  runNativeWorkflowTool,
  reportError: (message) => {
    console.error(message)
  },
}

function writeLine(processLike: WorkflowCommandProcessLike, value: string): void {
  processLike.stdout.write(`${value}\n`)
}

function writeJson(processLike: WorkflowCommandProcessLike, value: unknown): void {
  writeLine(processLike, JSON.stringify(value, null, 2))
}

function setProcessExitCode(processLike: WorkflowCommandProcessLike, exitCode: number): void {
  processLike.exitCode = exitCode
}

function resolveLaunchCwd(processLike: WorkflowCommandProcessLike): string {
  return processLike.env.PWD ?? processLike.env.INIT_CWD ?? processLike.cwd()
}

function resolveTargetRoot(processLike: WorkflowCommandProcessLike, target?: string): string {
  const launchCwd = resolveLaunchCwd(processLike)
  return path.resolve(launchCwd, target?.trim() || path.join(".eidolon", "workflows"))
}

function resolveCliResourceLayers(processLike: WorkflowCommandProcessLike): Array<{
  id: "global" | "workspace"
  rootDir: string
}> {
  const launchCwd = resolveLaunchCwd(processLike)
  const home = processLike.env.HOME
    ?? processLike.env.USERPROFILE
    ?? process.env.HOME
    ?? process.env.USERPROFILE
    ?? launchCwd
  return [
    { id: "global", rootDir: path.join(path.resolve(home), ".eidolon", "resources") },
    { id: "workspace", rootDir: path.join(launchCwd, ".eidolon", "resources") },
  ]
}

function makeCliRuntime(processLike: WorkflowCommandProcessLike) {
  const launchCwd = resolveLaunchCwd(processLike)
  return {
    vm: {
      outerCtx: {
        workDir: launchCwd,
        metadata: {
          aiWorkflow: {
            roots: {
              workspaceRoot: path.join(launchCwd, ".eidolon", "workflows"),
            },
          },
          resourcePackages: {
            layers: resolveCliResourceLayers(processLike),
          },
        },
      },
    },
    actor: {},
  }
}

function makeCliWorkflowComponent(deps: WorkflowCommandDeps): WorkflowComponent {
  return deps.createWorkflowComponent({
    workspaceRoot: resolveTargetRoot(deps.processLike),
    resourceLayers: resolveCliResourceLayers(deps.processLike),
  })
}

function parseHumanValue(value: string | undefined): unknown {
  const source = value?.trim()
  if (!source) return undefined
  try {
    return JSON.parse(source)
  } catch {
    return source
  }
}

function parseToolOutput(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function renderRuntimeToolResult(
  deps: WorkflowCommandDeps,
  toolName: string,
  value: unknown,
  json: boolean | undefined,
): void {
  const result = parseToolOutput(value)
  if (json || typeof result !== "object" || result === null) {
    json ? writeJson(deps.processLike, result) : writeLine(deps.processLike, String(result))
  } else {
    const item = result as Record<string, unknown>
    const status = String(item.status ?? item.error ?? "ok")
    const runId = typeof item.run_id === "string" ? ` run_id=${item.run_id}` : ""
    writeLine(deps.processLike, `${toolName}: ${status}${runId}`)
    if (item.output !== undefined) writeJson(deps.processLike, item.output)
    if (Array.isArray(item.entries)) writeJson(deps.processLike, item.entries)
    if (Array.isArray(item.apps)) writeJson(deps.processLike, item.apps)
    if (item.app !== undefined) writeJson(deps.processLike, item.app)
  }
  if (typeof result === "object" && result !== null && (result as any).ok === false) {
    setProcessExitCode(deps.processLike, 1)
  }
}

async function callRuntimeTool(
  deps: WorkflowCommandDeps,
  toolName: string,
  input: unknown,
  args: WorkflowRuntimeArgs,
): Promise<void> {
  const runner = deps.runNativeWorkflowTool ?? runNativeWorkflowTool
  const value = await runner({
    workDir: resolveLaunchCwd(deps.processLike),
    toolName,
    input,
    model: args.model,
    profile: args.profile,
    timeoutSeconds: args.timeout,
    sessionKey: args.session?.trim() || undefined,
    captureRuntimeEvidence: args.captureRuntimeEvidence === true,
  })
  renderRuntimeToolResult(deps, toolName, value, args.json)
}

function withRuntimeOptions(yargs: any) {
  return yargs
    .option("session", { type: "string", describe: "Eidolon session id containing durable workflow instance/run facts" })
    .option("model", { type: "string", describe: "optional Eidolon model override" })
    .option("profile", { type: "string", describe: "optional Eidolon runtime profile" })
    .option("timeout", { type: "number", describe: "runtime initialization timeout in seconds" })
    .option("capture-runtime-evidence", {
      type: "boolean",
      default: false,
      describe: "include public Provider-cache and Workflow execution evidence in the JSON result",
    })
    .option("json", { type: "boolean", default: false })
}

export function buildWorkflowCliAuthorPrompt(input: {
  operation: "create" | "edit"
  request: string
  workflowRef?: string
  form?: string
  publish: boolean
}): string {
  return [
    `Handle an Eidolon AI workflow ${input.operation} request through the native authoring lifecycle.`,
    "Call the native WorkflowAuthor tool exactly once with the complete request below, then wait for its authoring actor and report the business purpose and proof state.",
    "Do not ask the human for form, nodes, ports, policies, FQN, XNL, or internal paths. Use recoverable authoring sessions; do not use MCP, shell, generic file writes, or any external agent CLI.",
    "Publication requires the explicit publish argument below and never authorizes execution.",
    "",
    "WorkflowAuthor arguments:",
    JSON.stringify({
      operation: input.operation,
      request: input.request,
      ...(input.workflowRef ? { workflow_ref: input.workflowRef } : {}),
      form: input.form || "auto",
      publish: input.publish,
    }, null, 2),
  ].join("\n")
}

export function buildWorkflowCliFulfillInput(input: WorkflowAgentArgs): Record<string, unknown> {
  const request = String(input.requirement ?? "").trim()
  if (!request) throw new Error("workflow agent requires an ordinary-language business goal")
  const execute = input.execute === true || input.yes === true
  return {
    request,
    form: input.form ?? "auto",
    operation: "auto",
    publish: input.publish === true || execute,
    execute,
  }
}

export function buildWorkflowCliAgentPrompt(input: WorkflowAgentArgs): string {
  const toolInput = buildWorkflowCliFulfillInput(input)
  return [
    "Fulfill the business goal below through Eidolon's native workflow product experience.",
    "Call WorkflowFulfill exactly once with the arguments below.",
    "If this outer session already contains a typed durable WorkflowFulfill handoff, include that exact authoring, publication or execution object as continuation; never reconstruct identifiers from ordinary prose or child history.",
    "Wait for the dedicated workflow actor and report only the business purpose, progress, needed confirmation or wait, and final result.",
    "Do not expose form, nodes, ports, policy, XNL, identifiers, Material revisions, fact paths or physical paths in the ordinary business response.",
    "Do not use MCP, an external agent CLI, shell, generic file writes, or low-level workflow tools outside WorkflowFulfill.",
    "",
    "WorkflowFulfill arguments:",
    JSON.stringify(toolInput, null, 2),
  ].join("\n")
}

async function resolveWorkflowAgentRequirement(
  deps: WorkflowCommandDeps,
  requirement: unknown,
): Promise<string | undefined> {
  // yargs represents a bare `-` positional as an empty string (or boolean true
  // in a minimal parser); normalize those sentinels without making an omitted
  // requirement implicitly read stdin.
  const source = requirement === true || requirement === ""
    ? "-"
    : typeof requirement === "string"
      ? requirement.trim()
      : undefined
  if (source !== "-" && source !== "/dev/stdin") return source
  return (await (deps.readHeadlessInput ?? readHeadlessInput)(undefined))?.trim()
}

async function runWorkflowAgent(deps: WorkflowCommandDeps, input: WorkflowAgentArgs): Promise<void> {
  const runner = deps.runHeadlessExec ?? runHeadlessExec
  const result = await runner({
    workDir: resolveLaunchCwd(deps.processLike),
    input: buildWorkflowCliAgentPrompt(input),
    sessionKey: input.session?.trim() || undefined,
    model: input.model,
    profile: input.profile,
    timeoutSeconds: input.timeout,
    mcp: false,
    approvalMode: "full-auto",
    autoResume: true,
    maxContinuations: 16,
    failOnToolError: ["WorkflowFulfill"],
    outputTracePath: input.outputTrace,
    captureProviderRequests: input.captureProviderRequests,
  })
  if (input.json) {
    writeJson(deps.processLike, {
      kind: "workflow.businessJourneyResult",
      runtime: "eidolon.headless",
      ...result,
    })
  } else {
    writeLine(deps.processLike, result.finalMessage ?? result.visibleOutput ?? "Workflow journey completed without a final message")
  }
  if (result.status !== "completed") setProcessExitCode(deps.processLike, 1)
}

async function runNaturalAuthoring(
  deps: WorkflowCommandDeps,
  input: {
    operation: "create" | "edit"
    request: string
    workflowRef?: string
    form?: string
    publish: boolean
    model?: string
    profile?: string
    timeout?: number
    json?: boolean
  },
): Promise<void> {
  if (!input.request.trim()) throw new Error(`workflow ${input.operation} requires a natural-language request`)
  if (input.operation === "edit" && !input.workflowRef?.trim()) {
    throw new Error("workflow edit requires a logical workflow ref")
  }
  const runner = deps.runHeadlessExec ?? runHeadlessExec
  const workDir = resolveLaunchCwd(deps.processLike)
  const result = await runner({
    workDir,
    input: buildWorkflowCliAuthorPrompt(input),
    model: input.model,
    profile: input.profile,
    timeoutSeconds: input.timeout,
    mcp: false,
    approvalMode: "full-auto",
    autoResume: true,
    maxContinuations: 8,
  })
  if (input.json) {
    writeJson(deps.processLike, {
      kind: "workflow.naturalAuthoringResult",
      operation: input.operation,
      runtime: "eidolon.headless",
      ...result,
    })
  } else {
    const output = result.finalMessage ?? result.visibleOutput
    writeLine(deps.processLike, output || `${input.operation} completed without a final message`)
  }
  if (result.status !== "completed") setProcessExitCode(deps.processLike, 1)
}

export function createWorkflowCommand(
  deps: WorkflowCommandDeps = DEFAULT_WORKFLOW_COMMAND_DEPS,
): CommandModule<object, object> {
  return {
    command: "workflow",
    describe: "create, inspect and validate Eidolon AI workflow resources",
    builder: (yargs) =>
      yargs
        .command({
          command: "agent [requirement]",
          describe: "fulfill an ordinary business goal through the shared Eidolon workflow journey",
          builder: (yargs) => withRuntimeOptions(yargs
            .positional("requirement", {
              type: "string",
              describe: "ordinary-language business goal, or '-'/'/dev/stdin' to read a heredoc",
            })
            .option("session", {
              alias: ["s"],
              type: "string",
              describe: "Eidolon session id to continue across CLI invocations",
            })
            .option("form", {
              type: "string",
              choices: ["auto", "ai-data", "ai-ctrl"] as const,
              default: "auto",
              describe: "require an exact Workflow form; auto leaves semantic selection to the workflow actor",
            })
            .option("output-trace", {
              type: "string",
              describe: "write structured workflow-agent trace records to this file",
            })
            .option("capture-provider-requests", {
              type: "boolean",
              default: false,
              describe: "capture complete provider request attempts in the session SQLite ledger",
            })
            .option("publish", { type: "boolean", default: false, describe: "explicitly authorize publication, but not execution" })
            .option("execute", {
              alias: ["yes"],
              type: "boolean",
              default: false,
              describe: "explicitly authorize both publication and execution",
            })),
          handler: async (args) => {
            const agentArgs = args as WorkflowAgentArgs
            try {
              const requirement = await resolveWorkflowAgentRequirement(deps, agentArgs.requirement)
              if (!requirement) {
                deps.reportError(
                  "Workflow requirement required: pass ordinary text, or use '-' or '/dev/stdin' with a heredoc",
                )
                setProcessExitCode(deps.processLike, 2)
                return
              }
              await runWorkflowAgent(deps, { ...agentArgs, requirement })
            } catch (error) {
              deps.reportError(error instanceof Error ? error.message : String(error))
              setProcessExitCode(deps.processLike, 1)
            }
          },
        })
        .command({
          command: "create <requirement>",
          describe: "create a canonical AI workflow from an ordinary-language requirement",
          builder: (yargs) => yargs
            .positional("requirement", { type: "string", describe: "ordinary-language workflow requirement" })
            .option("form", { type: "string", choices: ["auto", "ai-data", "ai-ctrl"] as const, default: "auto" })
            .option("publish", { type: "boolean", default: false, describe: "explicitly authorize publication after proof; never executes" })
            .option("model", { type: "string", describe: "optional Eidolon model override" })
            .option("profile", { type: "string", describe: "optional Eidolon runtime profile" })
            .option("timeout", { type: "number", describe: "authoring turn timeout in seconds" })
            .option("json", { type: "boolean", default: false }),
          handler: async (args) => {
            const natural = args as WorkflowNaturalAuthorArgs
            try {
              await runNaturalAuthoring(deps, {
                operation: "create",
                request: String(natural.requirement ?? "").trim(),
                form: natural.form,
                publish: natural.publish === true,
                model: natural.model,
                profile: natural.profile,
                timeout: natural.timeout,
                json: natural.json,
              })
            } catch (error) {
              deps.reportError(error instanceof Error ? error.message : String(error))
              setProcessExitCode(deps.processLike, 1)
            }
          },
        })
        .command({
          command: "prepare <ref> [input]",
          describe: "create a durable workflow Instance with a frozen definition revision; never executes",
          builder: (yargs) => withRuntimeOptions(yargs
            .positional("ref", { type: "string", describe: "logical workflow resource or VFS ref" })
            .positional("input", { type: "string", describe: "optional JSON value or ordinary text input" })
            .option("instance-id", { type: "string", describe: "optional stable Instance id" })),
          handler: async (args) => {
            const runtimeArgs = args as WorkflowRuntimeArgs
            try {
              await callRuntimeTool(deps, "WorkflowCreateInstance", {
                workflow_ref: String(runtimeArgs.ref ?? "").trim(),
                input: parseHumanValue(runtimeArgs.input),
                ...(runtimeArgs.instanceId ? { instance_id: runtimeArgs.instanceId } : {}),
              }, runtimeArgs)
            } catch (error) {
              deps.reportError(error instanceof Error ? error.message : String(error))
              setProcessExitCode(deps.processLike, 1)
            }
          },
        })
        .command({
          command: "run <instance-id>",
          describe: "preview or explicitly confirm execution of a prepared workflow Instance",
          builder: (yargs) => withRuntimeOptions(yargs
            .positional("instance-id", { type: "string", describe: "prepared workflow Instance id" })
            .option("run-id", { type: "string", describe: "optional stable caller-supplied Run id" })
            .option("yes", { type: "boolean", default: false, describe: "independent execution confirmation" })),
          handler: async (args) => {
            const runtimeArgs = args as WorkflowRuntimeArgs
            try {
              await callRuntimeTool(deps, "WorkflowRun", {
                instance_id: String(runtimeArgs.instanceId ?? "").trim(),
                ...(runtimeArgs.runId ? { run_id: runtimeArgs.runId } : {}),
                confirmed: runtimeArgs.yes === true,
              }, runtimeArgs)
            } catch (error) {
              deps.reportError(error instanceof Error ? error.message : String(error))
              setProcessExitCode(deps.processLike, 1)
            }
          },
        })
        .command({
          command: "prepare-prebuilt <prebuilt-id> [input]",
          describe: "create a durable workflow Instance from an installed prebuilt starting fact; never executes",
          builder: (yargs) => withRuntimeOptions(yargs
            .positional("prebuilt-id", { type: "string" })
            .positional("input", { type: "string", describe: "optional JSON value or ordinary text input" })
            .option("instance-id", { type: "string" })),
          handler: async (args) => {
            const runtimeArgs = args as WorkflowRuntimeArgs & { prebuiltId?: string }
            try {
              await callRuntimeTool(deps, "WorkflowCreateInstanceFromPrebuilt", {
                prebuilt_id: runtimeArgs.prebuiltId,
                input: parseHumanValue(runtimeArgs.input),
                ...(runtimeArgs.instanceId ? { instance_id: runtimeArgs.instanceId } : {}),
              }, runtimeArgs)
            } catch (error) {
              deps.reportError(error instanceof Error ? error.message : String(error))
              setProcessExitCode(deps.processLike, 1)
            }
          },
        })
        .command({
          command: "apps [app-resource-id]",
          describe: "list AI Workflow Apps or inspect one exact App resource",
          builder: (yargs) => withRuntimeOptions(yargs
            .positional("app-resource-id", { type: "string", describe: "exact AIWorkflowAppBundle resource identity" })),
          handler: async (args) => {
            const runtimeArgs = args as WorkflowRuntimeArgs
            try {
              const appResourceId = runtimeArgs.appResourceId
              const component = makeCliWorkflowComponent(deps)
              const result = appResourceId
                ? {
                    ok: true,
                    kind: "workflow.app",
                    app: await component.queries.getApp(appResourceId),
                    effectDispatched: false,
                  }
                : {
                    ok: true,
                    kind: "workflow.apps",
                    apps: await component.queries.listApps(),
                    effectDispatched: false,
                  }
              if (runtimeArgs.json) {
                writeJson(deps.processLike, result)
              } else if (result.kind === "workflow.app") {
                writeJson(deps.processLike, result.app)
              } else if (result.apps.length === 0) {
                writeLine(deps.processLike, "No AI Workflow Apps are installed.")
              } else {
                for (const app of result.apps) writeLine(deps.processLike, app.id)
              }
            } catch (error) {
              deps.reportError(error instanceof Error ? error.message : String(error))
              setProcessExitCode(deps.processLike, 1)
            }
          },
        })
        .command({
          command: "types",
          describe: "list published workflow Types and current content revisions",
          builder: (yargs) => withRuntimeOptions(yargs),
          handler: async (args) => {
            const runtimeArgs = args as WorkflowRuntimeArgs
            try {
              await callRuntimeTool(deps, "WorkflowListTypes", {}, runtimeArgs)
            } catch (error) {
              deps.reportError(error instanceof Error ? error.message : String(error))
              setProcessExitCode(deps.processLike, 1)
            }
          },
        })
        .command({
          command: "instances",
          describe: "list durable workflow Instances",
          builder: (yargs) => withRuntimeOptions(yargs),
          handler: async (args) => {
            const runtimeArgs = args as WorkflowRuntimeArgs
            try {
              await callRuntimeTool(deps, "WorkflowListInstances", {}, runtimeArgs)
            } catch (error) {
              deps.reportError(error instanceof Error ? error.message : String(error))
              setProcessExitCode(deps.processLike, 1)
            }
          },
        })
        .command({
          command: "material-import <material-ref> <source-path>",
          describe: "preview or confirm import of a workspace path as an immutable Material revision",
          builder: (yargs) => withRuntimeOptions(yargs
            .positional("material-ref", { type: "string" })
            .positional("source-path", { type: "string" })
            .option("yes", { type: "boolean", default: false })),
          handler: async (args) => {
            const runtimeArgs = args as WorkflowRuntimeArgs
            try {
              await callRuntimeTool(deps, "WorkflowMaterialImport", {
                material_ref: runtimeArgs.materialRef,
                source_path: runtimeArgs.sourcePath,
                confirmed: runtimeArgs.yes === true,
              }, runtimeArgs)
            } catch (error) {
              deps.reportError(error instanceof Error ? error.message : String(error))
              setProcessExitCode(deps.processLike, 1)
            }
          },
        })
        .command({
          command: "material-bind <instance-id> <node-id> <port> <material-ref> <revision>",
          describe: "bind one exact Material revision to a prepared Instance node port",
          builder: (yargs) => withRuntimeOptions(yargs
            .positional("instance-id", { type: "string" })
            .positional("node-id", { type: "string" })
            .positional("port", { type: "string" })
            .positional("material-ref", { type: "string" })
            .positional("revision", { type: "string" })),
          handler: async (args) => {
            const runtimeArgs = args as WorkflowRuntimeArgs
            try {
              await callRuntimeTool(deps, "WorkflowMaterialBind", {
                instance_id: runtimeArgs.instanceId,
                node_id: runtimeArgs.nodeId,
                port: runtimeArgs.port,
                material_ref: runtimeArgs.materialRef,
                revision: runtimeArgs.revision,
              }, runtimeArgs)
            } catch (error) {
              deps.reportError(error instanceof Error ? error.message : String(error))
              setProcessExitCode(deps.processLike, 1)
            }
          },
        })
        .command({
          command: "material-export <material-ref> <revision> <destination-path>",
          describe: "preview or confirm export of an exact Material revision",
          builder: (yargs) => withRuntimeOptions(yargs
            .positional("material-ref", { type: "string" })
            .positional("revision", { type: "string" })
            .positional("destination-path", { type: "string" })
            .option("yes", { type: "boolean", default: false })),
          handler: async (args) => {
            const runtimeArgs = args as WorkflowRuntimeArgs
            try {
              await callRuntimeTool(deps, "WorkflowMaterialExport", {
                material_ref: runtimeArgs.materialRef,
                revision: runtimeArgs.revision,
                destination_path: runtimeArgs.destinationPath,
                confirmed: runtimeArgs.yes === true,
              }, runtimeArgs)
            } catch (error) {
              deps.reportError(error instanceof Error ? error.message : String(error))
              setProcessExitCode(deps.processLike, 1)
            }
          },
        })
        .command({
          command: "replay <run-id>",
          describe: "preview or confirm replay from a frozen Run receipt",
          builder: (yargs) => withRuntimeOptions(yargs
            .positional("run-id", { type: "string" })
            .option("new-run-id", { type: "string" })
            .option("yes", { type: "boolean", default: false })),
          handler: async (args) => {
            const runtimeArgs = args as WorkflowRuntimeArgs & { newRunId?: string }
            try {
              await callRuntimeTool(deps, "WorkflowMaterialReplay", {
                run_id: runtimeArgs.runId,
                ...(runtimeArgs.newRunId ? { new_run_id: runtimeArgs.newRunId } : {}),
                confirmed: runtimeArgs.yes === true,
              }, runtimeArgs)
            } catch (error) {
              deps.reportError(error instanceof Error ? error.message : String(error))
              setProcessExitCode(deps.processLike, 1)
            }
          },
        })
        .command({
          command: "material-cleanup [material-ref]",
          describe: "preview or confirm cleanup of unleased Material revisions",
          builder: (yargs) => withRuntimeOptions(yargs
            .positional("material-ref", { type: "string" })
            .option("yes", { type: "boolean", default: false })),
          handler: async (args) => {
            const runtimeArgs = args as WorkflowRuntimeArgs
            try {
              await callRuntimeTool(deps, "WorkflowMaterialCleanup", {
                ...(runtimeArgs.materialRef ? { material_ref: runtimeArgs.materialRef } : {}),
                confirmed: runtimeArgs.yes === true,
              }, runtimeArgs)
            } catch (error) {
              deps.reportError(error instanceof Error ? error.message : String(error))
              setProcessExitCode(deps.processLike, 1)
            }
          },
        })
        .command({
          command: "status <run-id>",
          describe: "read persisted workflow graph status",
          builder: (yargs) => withRuntimeOptions(yargs.positional("run-id", { type: "string" })),
          handler: async (args) => {
            const runtimeArgs = args as WorkflowRuntimeArgs
            try {
              await callRuntimeTool(deps, "WorkflowStatus", { run_id: runtimeArgs.runId }, runtimeArgs)
            } catch (error) {
              deps.reportError(error instanceof Error ? error.message : String(error))
              setProcessExitCode(deps.processLike, 1)
            }
          },
        })
        .command({
          command: "summary <run-id>",
          describe: "read Run descriptor, Instance and frozen Material receipt facts",
          builder: (yargs) => withRuntimeOptions(yargs.positional("run-id", { type: "string" })),
          handler: async (args) => {
            const runtimeArgs = args as WorkflowRuntimeArgs
            try {
              await callRuntimeTool(deps, "WorkflowGetFlowSummary", { run_id: runtimeArgs.runId }, runtimeArgs)
            } catch (error) {
              deps.reportError(error instanceof Error ? error.message : String(error))
              setProcessExitCode(deps.processLike, 1)
            }
          },
        })
        .command({
          command: "events <run-id>",
          describe: "read persisted workflow domain and effect events",
          builder: (yargs) => withRuntimeOptions(yargs.positional("run-id", { type: "string" })),
          handler: async (args) => {
            const runtimeArgs = args as WorkflowRuntimeArgs
            try {
              await callRuntimeTool(deps, "WorkflowEvents", { run_id: runtimeArgs.runId }, runtimeArgs)
            } catch (error) {
              deps.reportError(error instanceof Error ? error.message : String(error))
              setProcessExitCode(deps.processLike, 1)
            }
          },
        })
        .command({
          command: "result <run-id>",
          describe: "read a workflow terminal result",
          builder: (yargs) => withRuntimeOptions(yargs
            .positional("run-id", { type: "string" })
            .option("allow-partial", { type: "boolean", default: false })),
          handler: async (args) => {
            const runtimeArgs = args as WorkflowRuntimeArgs
            try {
              await callRuntimeTool(deps, "WorkflowResult", {
                run_id: runtimeArgs.runId,
                allow_partial: runtimeArgs.allowPartial === true,
              }, runtimeArgs)
            } catch (error) {
              deps.reportError(error instanceof Error ? error.message : String(error))
              setProcessExitCode(deps.processLike, 1)
            }
          },
        })
        .command({
          command: "resume <run-id> [output]",
          describe: "resume a waiting workflow or stable AIDataWorkflow manual node",
          builder: (yargs) => withRuntimeOptions(yargs
            .positional("run-id", { type: "string" })
            .positional("output", { type: "string", describe: "optional JSON value or ordinary text output" })
            .option("node-id", { type: "string", describe: "stable AIDataWorkflow manual node id" })),
          handler: async (args) => {
            const runtimeArgs = args as WorkflowRuntimeArgs
            try {
              const output = parseHumanValue(runtimeArgs.output)
              await callRuntimeTool(deps, "WorkflowResume", {
                run_id: runtimeArgs.runId,
                ...(runtimeArgs.nodeId ? { node_id: runtimeArgs.nodeId } : {}),
                ...(output === undefined ? {} : { output, payload: output }),
              }, runtimeArgs)
            } catch (error) {
              deps.reportError(error instanceof Error ? error.message : String(error))
              setProcessExitCode(deps.processLike, 1)
            }
          },
        })
        .command({
          command: "graph-patch <run-id> <patch>",
          describe: "apply a canonical JSON GraphPatch to an AIDataWorkflow run",
          builder: (yargs) => withRuntimeOptions(yargs
            .positional("run-id", { type: "string" })
            .positional("patch", { type: "string", describe: "GraphPatch JSON object" })),
          handler: async (args) => {
            const runtimeArgs = args as WorkflowRuntimeArgs
            try {
              const patch = parseHumanValue(runtimeArgs.patch)
              if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
                throw new Error("workflow graph-patch requires a JSON object")
              }
              await callRuntimeTool(deps, "WorkflowApplyGraphPatch", {
                run_id: runtimeArgs.runId,
                patch,
              }, runtimeArgs)
            } catch (error) {
              deps.reportError(error instanceof Error ? error.message : String(error))
              setProcessExitCode(deps.processLike, 1)
            }
          },
        })
        .command({
          command: "holon-process <request>",
          describe: "process one organization-owned TaskSpace task from a closed JSON request",
          builder: (yargs) => withRuntimeOptions(yargs
            .positional("request", { type: "string", describe: "closed WorkflowProcessHolonTask JSON request" })),
          handler: async (args) => {
            const runtimeArgs = args as WorkflowRuntimeArgs & { request?: string }
            try {
              const request = parseHumanValue(runtimeArgs.request)
              if (typeof request !== "object" || request === null || Array.isArray(request)) {
                throw new Error("workflow holon-process requires a JSON object")
              }
              await callRuntimeTool(deps, "WorkflowProcessHolonTask", request as Record<string, unknown>, runtimeArgs)
            } catch (error) {
              deps.reportError(error instanceof Error ? error.message : String(error))
              setProcessExitCode(deps.processLike, 1)
            }
          },
        })
        .command({
          command: "holon-replan <request>",
          describe: "explicitly adopt a compatible organization snapshot from a closed JSON request",
          builder: (yargs) => withRuntimeOptions(yargs
            .positional("request", { type: "string", describe: "closed WorkflowReplanHolonTask JSON request" })),
          handler: async (args) => {
            const runtimeArgs = args as WorkflowRuntimeArgs & { request?: string }
            try {
              const request = parseHumanValue(runtimeArgs.request)
              if (typeof request !== "object" || request === null || Array.isArray(request)) {
                throw new Error("workflow holon-replan requires a JSON object")
              }
              await callRuntimeTool(deps, "WorkflowReplanHolonTask", request as Record<string, unknown>, runtimeArgs)
            } catch (error) {
              deps.reportError(error instanceof Error ? error.message : String(error))
              setProcessExitCode(deps.processLike, 1)
            }
          },
        })
        .command({
          command: "edit <ref> <instruction>",
          describe: "edit an existing AI workflow from an ordinary-language instruction",
          builder: (yargs) => yargs
            .positional("ref", { type: "string", describe: "logical workflow resource or VFS ref" })
            .positional("instruction", { type: "string", describe: "ordinary-language edit instruction" })
            .option("publish", { type: "boolean", default: false, describe: "explicitly authorize publication after proof; never executes" })
            .option("model", { type: "string" })
            .option("profile", { type: "string" })
            .option("timeout", { type: "number" })
            .option("json", { type: "boolean", default: false }),
          handler: async (args) => {
            const natural = args as WorkflowNaturalAuthorArgs
            try {
              await runNaturalAuthoring(deps, {
                operation: "edit",
                request: String(natural.instruction ?? "").trim(),
                workflowRef: String(natural.ref ?? "").trim(),
                publish: natural.publish === true,
                model: natural.model,
                profile: natural.profile,
                timeout: natural.timeout,
                json: natural.json,
              })
            } catch (error) {
              deps.reportError(error instanceof Error ? error.message : String(error))
              setProcessExitCode(deps.processLike, 1)
            }
          },
        })
        .command({
          command: "templates",
          describe: "list installed workflow authoring templates",
          builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
          handler: (args) => {
            const templates = makeCliWorkflowComponent(deps).catalog.listTemplates()
            if ((args as any).json) writeJson(deps.processLike, { templates })
            else templates.forEach((item) => writeLine(deps.processLike, `${item.id}\t${item.description}`))
          },
        })
        .command({
          command: "prebuilt",
          describe: "list installed reusable workflow starting facts",
          builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
          handler: (args) => {
            const workflows = makeCliWorkflowComponent(deps).catalog.listPrebuiltWorkflows()
            if ((args as any).json) writeJson(deps.processLike, { workflows })
            else workflows.forEach((item) => writeLine(deps.processLike, `${item.id}\t${item.description}`))
          },
        })
        .command({
          command: "package-open",
          describe: "open the complete workspace ResourcePackage as a recoverable authoring session",
          builder: (yargs) => yargs
            .option("session-id", { type: "string", describe: "optional recoverable authoring session id" })
            .option("select", {
              type: "array",
              string: true,
              describe: "optional exact resource ref to select; repeat for more than one",
            })
            .option("json", { type: "boolean", default: false }),
          handler: async (args) => {
            try {
              const component = makeCliWorkflowComponent(deps)
              const session = await component.sessions.openResourcePackage({
                sessionId: typeof (args as any).sessionId === "string" ? (args as any).sessionId : undefined,
                source: { kind: "workspace-layer" },
                selectedResourceRefs: Array.isArray((args as any).select)
                  ? (args as any).select.map(String)
                  : undefined,
              })
              const result = {
                status: "session_opened",
                artifactKind: "resource-package",
                session,
                publicationEffectDispatched: false,
                runtimeEffectDispatched: false,
              }
              if ((args as any).json) writeJson(deps.processLike, result)
              else writeLine(deps.processLike, `${result.status} ${session.sessionId} ${session.workingRevision}`)
            } catch (error) {
              deps.reportError(error instanceof Error ? error.message : String(error))
              setProcessExitCode(deps.processLike, 1)
            }
          },
        })
        .command({
          command: "sessions",
          describe: "list recoverable workflow authoring sessions",
          builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
          handler: async (args) => {
            try {
              const sessions = await makeCliWorkflowComponent(deps).sessions.list()
              if ((args as any).json) writeJson(deps.processLike, { sessions })
              else sessions.forEach((item) => writeLine(deps.processLike, `${item.sessionId}\t${item.status}`))
            } catch (error) {
              deps.reportError(error instanceof Error ? error.message : String(error))
              setProcessExitCode(deps.processLike, 1)
            }
          },
        })
        .command({
          command: "prove <session-id>",
          describe: "validate and statically dry-run one current authoring revision",
          builder: (yargs) => yargs
            .positional("session-id", { type: "string" })
            .option("json", { type: "boolean", default: false }),
          handler: async (args) => {
            try {
              const component = makeCliWorkflowComponent(deps)
              const sessionId = String((args as any).sessionId)
              const session = await component.sessions.describe(sessionId)
              const result = session.artifactKind === "resource-package"
                ? {
                    status: "proved",
                    sessionId,
                    proof: await component.sessions.prepareResourcePackagePublication({ sessionId }),
                    publicationEffectDispatched: false,
                    runtimeEffectDispatched: false,
                  }
                : {
                    status: "proved",
                    sessionId,
                    diff: await component.sessions.diff(sessionId),
                    validation: await component.sessions.validate(sessionId),
                    dryRun: await component.sessions.dryRun(sessionId),
                    effectDispatched: false,
                  }
              if ((args as any).json) writeJson(deps.processLike, result)
              else {
                const revision = session.artifactKind === "resource-package"
                  ? result.proof.revision
                  : result.dryRun.revision
                writeLine(deps.processLike, `proved ${sessionId} ${revision}`)
              }
            } catch (error) {
              deps.reportError(error instanceof Error ? error.message : String(error))
              setProcessExitCode(deps.processLike, 1)
            }
          },
        })
        .command({
          command: "publish <session-id>",
          describe: "publish one proved authoring revision after explicit confirmation",
          builder: (yargs) => yargs
            .positional("session-id", { type: "string" })
            .option("yes", { type: "boolean", default: false, describe: "explicit publication confirmation; never executes" })
            .option("revision", { type: "string", describe: "exact working revision; required for ResourcePackage publication" })
            .option("json", { type: "boolean", default: false }),
          handler: async (args) => {
            try {
              const component = makeCliWorkflowComponent(deps)
              const sessionId = String((args as any).sessionId)
              const session = await component.sessions.describe(sessionId)
              const result = session.artifactKind === "resource-package"
                ? await component.resourcePackagePublisher!.publish({
                    sessionId,
                    expectedRevision: String((args as any).revision ?? session.workingRevision),
                    confirmed: (args as any).yes === true,
                  })
                : await component.sessions.publish({
                    sessionId,
                    confirmed: (args as any).yes === true,
                  })
              if ((args as any).json) writeJson(deps.processLike, result)
              else writeLine(deps.processLike, `${String(result.status)} ${String(result.sessionId)}`)
            } catch (error) {
              deps.reportError(error instanceof Error ? error.message : String(error))
              setProcessExitCode(deps.processLike, 1)
            }
          },
        })
        .command({
          command: "init [form] [name]",
          describe: "open a recoverable authoring session from an empty, installed template or prebuilt XNL starting fact",
          builder: (yargs) =>
            yargs
              .positional("form", {
                type: "string",
                choices: ["ai-data", "ai-ctrl", "AIDataWorkflow", "AICtrlWorkflow"] as const,
                describe: "workflow form",
              })
              .positional("name", {
                type: "string",
                describe: "workflow bundle name",
              })
              .option("fqn", {
                type: "string",
                describe: "optional workflow resource FQN",
              })
              .option("description", {
                type: "string",
                describe: "optional workflow description",
              })
              .option("target", {
                type: "string",
                describe: "workflow workspace root; defaults to .eidolon/workflows",
              })
              .option("session-id", {
                type: "string",
                describe: "optional recoverable authoring session id",
              })
              .option("template", {
                type: "string",
                describe: "installed template id (use workflow templates to discover)",
              })
              .option("prebuilt", {
                type: "string",
                describe: "installed prebuilt workflow id (use workflow prebuilt to discover)",
              })
              .option("json", {
                type: "boolean",
                default: false,
                describe: "print JSON output",
              }),
          handler: async (args) => {
            const initArgs = args as WorkflowInitArgs
            try {
              const targetRoot = resolveTargetRoot(deps.processLike, initArgs.target)
              const component = deps.createWorkflowComponent({ workspaceRoot: targetRoot })
              if (initArgs.template && initArgs.prebuilt) {
                throw new Error("workflow init accepts --template or --prebuilt, not both")
              }
              if ((initArgs.template || initArgs.prebuilt) && (initArgs.form || initArgs.name)) {
                throw new Error("workflow init template/prebuilt mode does not accept form or name")
              }
              if (initArgs.template || initArgs.prebuilt) {
                const startingFact = initArgs.template
                  ? component.catalog.getTemplate(initArgs.template)
                  : component.catalog.getPrebuiltWorkflow(initArgs.prebuilt!)
                const startingFactKind = initArgs.template ? "template" : "prebuilt"
                const session = await component.sessions.open({
                  sessionId: initArgs.sessionId,
                  form: startingFact.form,
                  template: startingFact.files,
                  target: {
                    scope: "definition",
                    id: startingFact.id,
                    path: startingFact.id,
                  },
                })
                const result = {
                  status: "session_opened",
                  startingFact: {
                    kind: startingFactKind,
                    id: startingFact.id,
                    form: startingFact.form,
                    description: startingFact.description,
                  },
                  session,
                  effectDispatched: false,
                }
                if (initArgs.json) writeJson(deps.processLike, result)
                else {
                  writeLine(deps.processLike, `${result.status}: ${startingFactKind} ${startingFact.id}`)
                  writeLine(deps.processLike, `  session=${session.sessionId}`)
                }
                return
              }
              if (!initArgs.form || !initArgs.name) {
                throw new Error("workflow init requires form and name, or one of --template/--prebuilt")
              }
              const draft = component.commands.createBundleDraft({
                form: initArgs.form,
                name: initArgs.name,
                fqn: initArgs.fqn,
                description: initArgs.description,
              })
              const bundlePrefix = `${draft.files[0]!.path.split("/")[0]}/`
              const session = await component.sessions.open({
                sessionId: initArgs.sessionId,
                form: draft.form,
                template: draft.files.map((file) => ({
                  path: file.path.slice(bundlePrefix.length),
                  content: file.content,
                })),
                target: {
                  scope: "definition",
                  id: draft.name,
                  path: bundlePrefix.slice(0, -1),
                  workflowRef: draft.workflowRef,
                },
              })
              const result = {
                status: "session_opened",
                draft,
                session,
                effectDispatched: false,
              }
              if (initArgs.json) {
                writeJson(deps.processLike, result)
              } else {
                writeLine(deps.processLike, `${result.status}: ${draft.workflowRef}`)
                writeLine(deps.processLike, `  session=${session.sessionId}`)
              }
            } catch (error) {
              deps.reportError(error instanceof Error ? error.message : String(error))
              setProcessExitCode(deps.processLike, 1)
            }
          },
        })
        .command({
          command: "inspect",
          describe: "inspect native AI workflow capability",
          builder: (yargs) =>
            yargs.option("json", {
              type: "boolean",
              default: false,
              describe: "print JSON output",
            }),
          handler: async (args) => {
            const inspectArgs = args as WorkflowInspectArgs
            const inspection = makeCliWorkflowComponent(deps).queries.inspectCapability(makeCliRuntime(deps.processLike))
            if (inspectArgs.json) {
              writeJson(deps.processLike, inspection)
            } else {
              writeLine(deps.processLike, `ai-workflow native=${inspection.native}`)
              writeLine(deps.processLike, `forms=${inspection.forms.join(",")}`)
              writeLine(deps.processLike, `workflowRootsInjected=${inspection.workflowRootsInjected}`)
            }
          },
        })
        .command({
          command: "validate <ref>",
          describe: "resolve and structurally validate an AI workflow definition",
          builder: (yargs) =>
            yargs
              .positional("ref", {
                type: "string",
                describe: "workflow resource ref",
              })
              .option("json", {
                type: "boolean",
                default: false,
                describe: "print JSON output",
              }),
          handler: async (args) => {
            const validateArgs = args as WorkflowValidateArgs
            const validation = await makeCliWorkflowComponent(deps).queries.validateDefinition(validateArgs.ref)
            if (validateArgs.json) {
              writeJson(deps.processLike, validation)
            } else if (validation.ok) {
              writeLine(deps.processLike, `ok ${validation.form}/${validation.substrate}: ${validation.ref}`)
              writeLine(deps.processLike, `nodes=${validation.nodes?.count ?? 0} materials=${validation.materials?.count ?? 0}`)
            } else {
              writeLine(deps.processLike, `invalid: ${validation.diagnostics.map((item) => item.message).join("; ")}`)
              setProcessExitCode(deps.processLike, 1)
            }
          },
        })
        .demandCommand(1),
    handler: () => {},
  }
}

export const workflow = createWorkflowCommand()
