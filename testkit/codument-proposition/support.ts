import { mkdir, rename, writeFile } from "node:fs/promises"
import path from "node:path"

import type {
  CodumentPropositionProviderBinding,
  CodumentPropositionRunReceipt,
  CodumentPropositionMode,
  PropositionModeExecutionPort,
  PropositionModeIdentity,
  PropositionProcessResult,
  PropositionProviderTurn,
  PropositionProviderAttemptFacts,
  PropositionReceiptStorePort,
} from "./contract"
import { verifyPropositionModeIdentity } from "./harness"
import {
  copiedMatureCodeAgentPrefix,
  STANDARD_CONTEXT_PIPELINE_SOURCE,
  WORKSPACE_AGENTS_MESSAGE_SOURCE,
} from "./agent-resources"

const SECRET_ENVIRONMENT_KEY = /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)(?:_|$)/i
const SECRET_VALUE = /(?:sk-[A-Za-z0-9_-]{12,}|(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^,}\s]+)/i

export type CodexCompatibleExecInvocation = Readonly<{
  cwd: string
  prompt: string
  requestedModel: string | null
}>

export function parseCodexCompatibleExecInvocation(
  argv: readonly string[],
  stdin: string | undefined,
  launchCwd: string,
): CodexCompatibleExecInvocation {
  if (argv[0] !== "exec") throw new Error("Codument proposition shim accepts only the codex exec surface")
  let cwd = path.resolve(launchCwd)
  let requestedModel: string | null = null
  let prompt: string | undefined
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!
    if (token === "-C" || token === "--cwd") {
      const value = argv[++index]
      if (!value) throw new Error(`${token} requires a directory`)
      cwd = path.resolve(launchCwd, value)
      continue
    }
    if (token === "-m" || token === "--model") {
      const value = argv[++index]
      if (!value) throw new Error(`${token} requires a model`)
      requestedModel = value
      continue
    }
    if (token === "--skip-git-repo-check" || token === "--dangerously-bypass-approvals-and-sandbox") continue
    if (token.startsWith("-")) throw new Error(`unsupported codex exec option: ${token}`)
    if (prompt !== undefined) throw new Error("codex exec shim accepts exactly one prompt")
    prompt = token
  }
  if (prompt === "-" || prompt === undefined) prompt = stdin
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("codex exec shim requires a non-empty prompt")
  return Object.freeze({ cwd, prompt, requestedModel })
}

export function buildEidolonPropositionShimArgv(input: Readonly<{
  eidolonExecutable: string
  invocation: CodexCompatibleExecInvocation
  mode: CodumentPropositionMode
  provider: CodumentPropositionProviderBinding
  sessionId: string
  tracePath: string
}>): readonly string[] {
  if (input.invocation.requestedModel && input.invocation.requestedModel !== input.provider.credential.model) {
    throw new Error(`source runner requested a different model: ${input.invocation.requestedModel}`)
  }
  if (input.mode !== "ordinary") {
    throw new Error("Workflow proposition modes require the registered prepare/run surface")
  }
  const common = [
    "--session", input.sessionId,
    "--model", input.provider.credential.model,
    "--timeout", "3600",
    "--output-trace", path.resolve(input.tracePath),
    "--capture-provider-requests",
    "--provider-chat-profile", input.provider.credential.profileId,
    "--json",
  ]
  return Object.freeze([
    input.eidolonExecutable,
    "exec",
    "-C", input.invocation.cwd,
    "--dangerously-bypass-approvals-and-sandbox",
    "--auto-resume",
    "--max-continuations", "16",
    ...common,
    input.invocation.prompt,
  ])
}

export type RegisteredPropositionWorkflowBinding = Readonly<{
  mode: "ai_ctrl" | "ai_data"
  kind: "AICtrlWorkflow" | "AIDataWorkflow"
  directoryName: string
  definitionRef: string
  instanceId: string
  runId: string
}>

export function registeredPropositionWorkflowBinding(
  mode: "ai_ctrl" | "ai_data",
  runId: string,
): RegisteredPropositionWorkflowBinding {
  const suffix = mode === "ai_ctrl" ? "ai-ctrl" : "ai-data"
  const workflowId = mode === "ai_ctrl"
    ? "local.codument.proposition.CtrlWorkflow"
    : "local.codument.proposition.DataWorkflow"
  return Object.freeze({
    mode,
    kind: mode === "ai_ctrl" ? "AICtrlWorkflow" : "AIDataWorkflow",
    directoryName: `codument-proposition-${suffix}`,
    definitionRef: `resource://${workflowId}`,
    instanceId: `codument-proposition-${suffix}-${runId}-instance`,
    runId: `codument-proposition-${suffix}-${runId}-run`,
  })
}

const PROPOSITION_AGENT_REF = "resource://local.codument.proposition.CodeAgent"
const PROPOSITION_TOOL_NAMES = Object.freeze(["bash", "edit", "glob", "grep", "ls", "read", "write"] as const)

const PROPOSITION_WORKFLOW_CODE = `export async function runCtrl(runtime: any, input: unknown, config: Record<string, unknown>) {
  const value = await runtime.ai.effects.runAgent(input, {
    agentDefinitionRef: String(config.agentDefinitionRef),
  })
  return value.output
}

export async function runData(runtime: any, input: unknown, config: Record<string, unknown>) {
  const value = await runtime.ai.effects.runAgent(input, {
    agentDefinitionRef: String(config.agentDefinitionRef),
  })
  return { result: value.output }
}
`

const PROPOSITION_AGENT_PROMPT = `You are the coding execution actor inside a fixed Eidolon Workflow.
Treat the invocation payload as the user's complete engineering request. Work directly in the current workspace.
Read AGENTS.md and all referenced Codument operation instructions before changing files. Use the available file and shell tools, keep iterating until implementation and verification are complete, and stop only for a real external blocker or a mandatory human decision.
Do not author or switch to another AI Workflow. Do not merely describe code that the request requires you to implement.`

function kindDefinition(kind: string): string {
  return `<KindDefinition #local.codument.proposition.kind.${kind} apiVersion="halfcode.resources/v1" version="1.0.0" {\n  lifecycle = "Stable" resourceKind = "${kind}" sourceShapes = ["single-file"]\n  currentApiVersion = "depa.flows/v1" supportedApiVersions = ["depa.flows/v1"]\n}>\n`
}

function propositionResourceFiles(
  binding: RegisteredPropositionWorkflowBinding,
  workspaceRoot: string,
): Readonly<Record<string, string>> {
  const workflowId = binding.definitionRef.slice("resource://".length)
  const appId = binding.mode === "ai_ctrl"
    ? "local.codument.proposition.CtrlApp"
    : "local.codument.proposition.DataApp"
  const workflow = binding.mode === "ai_ctrl"
    ? `<AICtrlWorkflow #${workflowId} apiVersion="depa.flows/v1" version="1.0.0" (\n  <FlowContract #${workflowId}>\n) [\n  <Run #execute { src = "vfs://./flow-code/index.ts#runCtrl" config = { agentDefinitionRef = "${PROPOSITION_AGENT_REF}" } }>\n  <Return #done>\n]>\n`
    : `<AIDataWorkflow #${workflowId} apiVersion="depa.flows/v1" version="1.0.0" (\n  <FlowContract #${workflowId} { inputPorts = ["request"] outputPorts = ["result"] }>\n) [\n  <EntryNode #entry>\n  <TransformNode #execute { inputs = { request = "flow-port://#entry/request" } outputs = ["result"] impl = "vfs://./flow-code/index.ts#runData" config = { agentDefinitionRef = "${PROPOSITION_AGENT_REF}" reuse_policy = "never" } }>\n  <ReturnNode #return { inputs = { result = "flow-port://#execute/result" } }>\n]>\n`
  const toolRefs = PROPOSITION_TOOL_NAMES
    .map((name) => `    <ToolRef #${name} { kind = "Tool" ref = "resource://${name}" }>`)
    .join("\n")
  const toolCatalog = PROPOSITION_TOOL_NAMES
    .map((name) => `<Tool #${name} apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Stable" description = "Eidolon ${name} execution capability" }>\n`)
  const maturePrefix = copiedMatureCodeAgentPrefix(workspaceRoot)
  return Object.freeze({
    "manifest.xnl": `<ResourcePackage #local.codument.proposition.package apiVersion="halfcode.resources/v1" version="1.0.0" { lifecycle = "Active" description = "Fixed Codument proposition Workflow harness" } (\n  <Catalogs [\n    <Catalog #kind_definitions { kind = "KindDefinition" shape = "directory" root = "vfs://./KindDefinitions/" entry = "manifest.xnl" }>\n    <Catalog #apps { kind = "AIWorkflowAppBundle" shape = "single-file" root = "vfs://./Apps/" }>\n    <Catalog #workflows { kind = "${binding.kind}" shape = "single-file" root = "vfs://./Workflows/" }>\n    <Catalog #agents { kind = "AIAgentDefinition" shape = "single-file" root = "vfs://./Agents/" }>\n    <Catalog #prompts { kind = "Prompt" shape = "single-file" root = "vfs://./Prompts/" }>\n    <Catalog #message_sources { kind = "AgentMessageSource" shape = "single-file" root = "vfs://./MessageSources/" }>\n    <Catalog #context_pipelines { kind = "AgentContextPipeline" shape = "single-file" root = "vfs://./ContextPipelines/" }>\n    <Catalog #tools { kind = "Tool" shape = "single-file" root = "vfs://./Tools/" }>\n  ]>\n)>\n`,
    [`KindDefinitions/${binding.kind}/manifest.xnl`]: kindDefinition(binding.kind),
    "KindDefinitions/AIWorkflowAppBundle/manifest.xnl": kindDefinition("AIWorkflowAppBundle"),
    "KindDefinitions/AIAgentDefinition/manifest.xnl": kindDefinition("AIAgentDefinition"),
    "KindDefinitions/Prompt/manifest.xnl": kindDefinition("Prompt"),
    "KindDefinitions/AgentMessageSource/manifest.xnl": kindDefinition("AgentMessageSource"),
    "KindDefinitions/AgentContextPipeline/manifest.xnl": kindDefinition("AgentContextPipeline"),
    "KindDefinitions/Tool/manifest.xnl": kindDefinition("Tool"),
    [`Apps/${binding.directoryName}.xnl`]: `<AIWorkflowAppBundle #${appId} apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Active" description = "Codument proposition ${binding.kind} harness" } (\n  <WorkflowBindings [\n    <WorkflowBinding #execute { kind = "${binding.kind}" ref = "${binding.definitionRef}" entrypoint = true }>\n  ]>\n)>\n`,
    [`Workflows/${binding.directoryName}.xnl`]: workflow,
    "Workflows/flow-code/index.ts": PROPOSITION_WORKFLOW_CODE,
    "Agents/CodeAgent.xnl": `<AIAgentDefinition #local.codument.proposition.CodeAgent apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Active" description = "Fixed Codument proposition coding actor" } (\n  <MessagePrefix [\n    <Message #kernel { role = "system" promptKind = "Prompt" promptRef = "resource://local.codument.proposition.KernelPrompt" }>\n    <Message #coding { role = "system" promptKind = "Prompt" promptRef = "resource://local.codument.proposition.CodingPrompt" }>\n    <MessageSource #workspace { kind = "AgentMessageSource" ref = "resource://local.codument.proposition.WorkspaceAgents" }>\n    <Message #mission { role = "system" promptKind = "Prompt" promptRef = "resource://local.codument.proposition.CodePrompt" }>\n  ]>\n  <ContextPipeline { kind = "AgentContextPipeline" ref = "resource://local.codument.proposition.StandardContext" }>\n  <ToolRefs [\n${toolRefs}\n  ]>\n  <MaterialPortRefs []>\n)>\n`,
    "Prompts/KernelPrompt.xnl": `<Prompt #local.codument.proposition.KernelPrompt apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Active" description = "Copied mature Eidolon kernel prompt" } (\n  <Content ?>${maturePrefix.kernel}</?>\n)>\n`,
    "Prompts/CodingPrompt.xnl": `<Prompt #local.codument.proposition.CodingPrompt apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Active" description = "Copied mature Eidolon coding prompt" } (\n  <Content ?>${maturePrefix.coding}</?>\n)>\n`,
    "Prompts/CodePrompt.xnl": `<Prompt #local.codument.proposition.CodePrompt apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Active" description = "Stable Codument proposition coding instruction" } (\n  <Content ?>${PROPOSITION_AGENT_PROMPT}</?>\n)>\n`,
    "MessageSources/WorkspaceAgents.xnl": `<AgentMessageSource #local.codument.proposition.WorkspaceAgents apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Active" description = "Workspace AGENTS.md source" } (\n  <Content ?>${WORKSPACE_AGENTS_MESSAGE_SOURCE}</?>\n)>\n`,
    "ContextPipelines/StandardContext.xnl": `<AgentContextPipeline #local.codument.proposition.StandardContext apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Active" description = "Canonical Eidolon context pipeline" } (\n  <Content ?>${STANDARD_CONTEXT_PIPELINE_SOURCE}</?>\n)>\n`,
    ...Object.fromEntries(PROPOSITION_TOOL_NAMES.map((name, index) => [`Tools/${name}.xnl`, toolCatalog[index]!])),
  })
}

export async function materializeRegisteredPropositionWorkflow(input: Readonly<{
  workspaceRoot: string
  binding: RegisteredPropositionWorkflowBinding
}>): Promise<void> {
  const packageRoot = path.join(path.resolve(input.workspaceRoot), ".eidolon", "resources")
  const files = propositionResourceFiles(input.binding, path.resolve(input.workspaceRoot))
  await Promise.all(Object.entries(files).map(async ([relativePath, content]) => {
    const destination = path.join(packageRoot, relativePath)
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, content, { encoding: "utf8", mode: 0o600 })
  }))
}

function propositionWorkflowCommonArgv(input: Readonly<{
  eidolonExecutable: string
  provider: CodumentPropositionProviderBinding
  sessionId: string
}>): string[] {
  return [
    input.eidolonExecutable,
    "workflow",
  ]
}

export function buildRegisteredPropositionWorkflowPrepareArgv(input: Readonly<{
  eidolonExecutable: string
  provider: CodumentPropositionProviderBinding
  sessionId: string
  binding: RegisteredPropositionWorkflowBinding
  request: string
}>): readonly string[] {
  return Object.freeze([
    ...propositionWorkflowCommonArgv(input),
    "prepare", input.binding.definitionRef, JSON.stringify({ request: input.request }),
    "--instance-id", input.binding.instanceId,
    "--session", input.sessionId,
    "--model", input.provider.credential.model,
    "--timeout", "3600",
    "--provider-chat-profile", input.provider.credential.profileId,
    "--json",
  ])
}

export function buildRegisteredPropositionWorkflowRunArgv(input: Readonly<{
  eidolonExecutable: string
  provider: CodumentPropositionProviderBinding
  sessionId: string
  binding: RegisteredPropositionWorkflowBinding
}>): readonly string[] {
  return Object.freeze([
    ...propositionWorkflowCommonArgv(input),
    "run", input.binding.instanceId,
    "--run-id", input.binding.runId,
    "--yes",
    "--session", input.sessionId,
    "--model", input.provider.credential.model,
    "--timeout", "3600",
    "--capture-runtime-evidence",
    "--provider-chat-profile", input.provider.credential.profileId,
    "--json",
  ])
}

export type RegisteredPropositionModeResult = Readonly<{
  identity: PropositionModeIdentity
  identities?: readonly PropositionModeIdentity[]
  process: PropositionProcessResult
  providerTurns: readonly PropositionProviderTurn[]
  providerAttempts: PropositionProviderAttemptFacts
}>

export type RegisteredPropositionModeSurface = (
  input: Parameters<PropositionModeExecutionPort["execute"]>[0],
) => Promise<RegisteredPropositionModeResult>

export type RegisteredPropositionModeSurfaces = Readonly<Record<
  CodumentPropositionMode,
  RegisteredPropositionModeSurface
>>

/**
 * Builds the complete child-process environment. The caller must enumerate
 * every key; provider credentials are resolved by the configured runtime from
 * the opaque credential binding and are never forwarded as environment text.
 */
export function createAllowlistedPropositionEnvironment(
  source: Readonly<Record<string, string | undefined>>,
  allowlist: readonly string[],
): Readonly<Record<string, string>> {
  const unique = [...new Set(allowlist)].sort()
  for (const key of unique) {
    if (SECRET_ENVIRONMENT_KEY.test(key)) throw new Error(`secret environment key is forbidden: ${key}`)
  }
  const result: Record<string, string> = {}
  for (const key of unique) {
    const value = source[key]
    if (typeof value === "string") result[key] = value
  }
  return Object.freeze(result)
}

/**
 * Binds already-registered production entry surfaces to the proposition
 * execution port. No Workflow implementation or lifecycle store is reachable
 * here; the only accepted identity is the typed public event projection.
 */
export function createRegisteredPropositionModeExecutionPort(
  surfaces: RegisteredPropositionModeSurfaces,
): PropositionModeExecutionPort {
  const port: PropositionModeExecutionPort = {
    async execute(input) {
      const surface = surfaces[input.mode]
      if (typeof surface !== "function") throw new Error(`registered proposition mode surface is missing: ${input.mode}`)
      const result = await surface(input)
      verifyPropositionModeIdentity(result.identity)
      const identities = result.identities ?? Object.freeze([result.identity])
      if (identities.length === 0) throw new Error("registered proposition mode emitted no identities")
      identities.forEach(verifyPropositionModeIdentity)
      return Object.freeze({
        identity: result.identity,
        identities: Object.freeze([...identities]),
        process: result.process,
        providerTurns: Object.freeze([...result.providerTurns]),
        providerAttempts: Object.freeze({
          ...result.providerAttempts,
          finalAttemptTerminalCauses: Object.freeze([...result.providerAttempts.finalAttemptTerminalCauses]),
        }),
      })
    },
  }
  return Object.freeze(port)
}

export function createRegisteredOrdinaryPropositionSurface(input: Readonly<{
  execute: RegisteredPropositionModeSurface
}>): RegisteredPropositionModeSurface {
  return async (request) => {
    if (request.mode !== "ordinary") throw new Error("ordinary proposition surface received a Workflow mode")
    const result = await input.execute(request)
    if (result.identity.workflow !== null) throw new Error("ordinary proposition surface emitted Workflow identity")
    return result
  }
}

export function createRegisteredWorkflowPropositionSurface(input: Readonly<{
  mode: "ai_ctrl" | "ai_data"
  workflowRef: string
  execute: (request: Parameters<RegisteredPropositionModeSurface>[0] & Readonly<{
    workflowRef: string
  }>) => Promise<RegisteredPropositionModeResult>
}>): RegisteredPropositionModeSurface {
  const expectedKind = input.mode === "ai_ctrl" ? "AICtrlWorkflow" : "AIDataWorkflow"
  if (!input.workflowRef.trim()) throw new Error("fixed Workflow reference is required")
  return async (request) => {
    if (request.mode !== input.mode) throw new Error(`${input.mode} proposition surface received mode ${request.mode}`)
    const result = await input.execute({ ...request, workflowRef: input.workflowRef })
    if (result.identity.workflow?.kind !== expectedKind) throw new Error(`registered Workflow surface must emit ${expectedKind}`)
    if (result.identity.workflow.definitionRef !== input.workflowRef) {
      throw new Error("registered Workflow surface emitted a different definition reference")
    }
    return result
  }
}

function assertReceiptRedacted(receipt: CodumentPropositionRunReceipt): void {
  const serialized = JSON.stringify(receipt)
  if (SECRET_VALUE.test(serialized)) throw new Error("proposition receipt contains credential-like material")
}

export function createJsonPropositionReceiptStore(outputRoot: string): PropositionReceiptStorePort {
  const root = path.resolve(outputRoot)
  const store: PropositionReceiptStorePort = {
    async persist(receipt) {
      assertReceiptRedacted(receipt)
      const digest = receipt.receiptDigest.replace(/^sha256:/, "")
      const name = `${receipt.modeIdentity.requestedMode}-${digest}.json`
      const destination = path.join(root, name)
      const temporary = `${destination}.tmp`
      await mkdir(root, { recursive: true })
      await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
      await rename(temporary, destination)
      return destination
    },
  }
  return Object.freeze(store)
}
