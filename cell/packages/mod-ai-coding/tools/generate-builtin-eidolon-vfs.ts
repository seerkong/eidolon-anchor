import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"

import type { DataElementNode } from "xnl-core"
import { serializeVfsSnapshotToString } from "xnl-vfs"
import {
  DEPA_AI_RESOURCE_ENVELOPE_VERSION,
  DEPA_AI_RESOURCE_SPEC_VERSION,
  depaAIResourceKindContract,
  type DepaAIResourceKind,
} from "ai-workflow-contract"

import kernelRules from "../../mod-ai-kernel/src/prompt/KernelRules.md" with { type: "text" }
import kernelWorkLoop from "../../mod-ai-kernel/src/prompt/KernelWorkLoop.md" with { type: "text" }
import delegationGuidance from "../src/prompt/delegation-guidance.md" with { type: "text" }
import primaryAgent from "../src/agent/primary/AGENT.md" with { type: "text" }
import primaryIdentity from "../src/agent/primary/IDENTITY.md" with { type: "text" }
import primaryRouting from "../src/agent/primary/ROUTING.md" with { type: "text" }
import primaryCodingRules from "../src/prompt/primary-coding-rules.md" with { type: "text" }
import standardContextSource from "../../ai-organ-logic/src/resources/compat/standard-context.ts.txt" with { type: "text" }
import workspaceAgentsSource from "../../ai-organ-logic/src/resources/compat/workspace-agents.ts.txt" with { type: "text" }
import {
  BUILTIN_EIDOLON_AGENT_REF,
  BUILTIN_EIDOLON_SNAPSHOT_FILE_NAME,
} from "../src/builtin-vfs/constants"
import {
  HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_SOURCE,
} from "../../ai-organ-contract/src/organization/HolonTaskRuntime"

export { BUILTIN_EIDOLON_AGENT_REF, BUILTIN_EIDOLON_SNAPSHOT_FILE_NAME }

const packageRoot = path.resolve(import.meta.dir, "..")
const authoringRoot = path.join(packageRoot, "resources", "builtin-eidolon")
const resourceRoot = path.join(authoringRoot, ".eidolon", "resources")
const snapshotPath = path.join(packageRoot, "src", "builtin-vfs", BUILTIN_EIDOLON_SNAPSHOT_FILE_NAME)
const check = process.argv.includes("--check")

const TOOL_NAMES = Object.freeze(["bash", "edit", "glob", "grep", "ls", "read", "write"] as const)

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function stableNodeId(kind: "directory" | "file", logicalPath: string): string {
  return `eidolon_${kind}_${sha256(`${kind}\u0000${logicalPath}`).slice(0, 24)}`
}

function frontmatterBody(source: string): string {
  const match = source.match(/^---\s*\n[\s\S]*?\n---\s*\n?([\s\S]*)$/)
  return (match?.[1] ?? source).trim()
}

function promptResource(id: string, description: string, content: string): string {
  return `<Prompt #${id} envelopeVersion="${DEPA_AI_RESOURCE_ENVELOPE_VERSION}" specVersion=${DEPA_AI_RESOURCE_SPEC_VERSION} { lifecycle = "Active" description = "${description}" template = ${JSON.stringify(content.trim())} }>\n`
}

function kindDefinition(kind: DepaAIResourceKind): string {
  return depaAIResourceKindContract(kind, kind === "AgentContextPipeline" || kind === "AgentMessageSource" ? 2 : 1).kindDefinitionSource
}

function maturePromptSections(): Readonly<{ kernel: string; coding: string }> {
  const kernel = [
    kernelWorkLoop.replace(
      "{delegateAgentDescriptions}",
      "- Halfcode CodeAgent uses the exact ToolRefs and delegate capabilities frozen with its execution plan.",
    ).trim(),
    kernelRules.trim(),
  ].join("\n\n")
  const primary = frontmatterBody(primaryAgent)
    .replace("你是位于 {workdir} 的 coding agent。", "你是当前工作区中的 coding agent。")
  const coding = [
    `# Agent\n\n${primary}`,
    `# Identity\n\n${primaryIdentity.trim()}`,
    `# Routing\n\n${primaryRouting.trim()}`,
    primaryCodingRules.trim(),
    delegationGuidance.replace(
      "{agent_list}",
      "- code: general coding delegate\n- explorer: repository discovery\n- librarian: current library and documentation research\n- oracle: architecture and root-cause analysis\n- designer: user-visible UI/UX design\n- fixer: focused implementation",
    ).trim(),
  ].join("\n\n")
  return Object.freeze({ kernel, coding })
}

export function builtinEidolonResourceFiles(): Readonly<Record<string, string>> {
  const prompt = maturePromptSections()
  const toolRefs = TOOL_NAMES
    .map((name) => `    <ToolRef #${name} { kind = "Tool" ref = "resource://${name}" }>`)
    .join("\n")
  const files: Record<string, string> = {
    "manifest.xnl": `<ResourcePackage #eidolon.coding.package envelopeVersion="${DEPA_AI_RESOURCE_ENVELOPE_VERSION}" specVersion=${DEPA_AI_RESOURCE_SPEC_VERSION} { lifecycle = "Active" description = "Builtin mature Eidolon Coding Agent resources" } (\n  <Catalogs [\n    <Catalog #kind_definitions { kind = "KindDefinition" shape = "directory" root = "vfs://./KindDefinitions/" entry = "manifest.xnl" }>\n    <Catalog #agents { kind = "AIAgentDefinition" shape = "single-file" root = "vfs://./Agents/" }>\n    <Catalog #prompts { kind = "Prompt" shape = "single-file" root = "vfs://./Prompts/" }>\n    <Catalog #message_sources { kind = "AgentMessageSource" shape = "single-file" root = "vfs://./MessageSources/" }>\n    <Catalog #context_pipelines { kind = "AgentContextPipeline" shape = "single-file" root = "vfs://./ContextPipelines/" }>\n    <Catalog #tools { kind = "Tool" shape = "single-file" root = "vfs://./Tools/" }>\n  ]>\n)>\n`,
    "Agents/CodeAgent.xnl": `<AIAgentDefinition #eidolon.coding.CodeAgent envelopeVersion="${DEPA_AI_RESOURCE_ENVELOPE_VERSION}" specVersion=${DEPA_AI_RESOURCE_SPEC_VERSION} { lifecycle = "Active" description = "Mature reusable Eidolon coding agent" } (\n  <MessagePrefix [\n    <Message #kernel { role = "system" promptKind = "Prompt" promptRef = "resource://eidolon.coding.KernelPrompt" }>\n    <Message #coding { role = "system" promptKind = "Prompt" promptRef = "resource://eidolon.coding.CodingPrompt" }>\n    <MessageSource #workspace { kind = "AgentMessageSource" ref = "resource://eidolon.coding.WorkspaceAgents" }>\n  ]>\n  <ContextPipeline { kind = "AgentContextPipeline" ref = "resource://eidolon.coding.StandardContext" }>\n  <ToolRefs [\n${toolRefs}\n  ]>\n  <MaterialPortRefs []>\n)>\n`,
    "Prompts/KernelPrompt.xnl": promptResource(
      "eidolon.coding.KernelPrompt",
      "Mature Eidolon kernel work loop and rules",
      prompt.kernel,
    ),
    "Prompts/CodingPrompt.xnl": promptResource(
      "eidolon.coding.CodingPrompt",
      "Mature Eidolon coding identity, routing and execution rules",
      prompt.coding,
    ),
    "MessageSources/WorkspaceAgents.xnl": `<AgentMessageSource #eidolon.coding.WorkspaceAgents envelopeVersion="${DEPA_AI_RESOURCE_ENVELOPE_VERSION}" specVersion=2 { lifecycle = "Active" description = "Workspace AGENTS.md instruction source" } (\n  <CodeBinding { packageName = "eidolon.coding" module = "./Code/workspace-agents.ts" exportName = "loadMessages" }>\n  <Config { value = {} }>\n)>\n`,
    "ContextPipelines/StandardContext.xnl": `<AgentContextPipeline #eidolon.coding.StandardContext envelopeVersion="${DEPA_AI_RESOURCE_ENVELOPE_VERSION}" specVersion=2 { lifecycle = "Active" description = "Canonical Eidolon history and provider context pipeline" } (\n  <CodeBinding { packageName = "eidolon.coding" module = "./Code/standard-context.ts" exportName = "buildContext" }>\n  <Config { value = {} }>\n)>\n`,
    "Code/standard-context.ts": standardContextSource,
    "Code/workspace-agents.ts": workspaceAgentsSource,
  }
  for (const kind of ["AIAgentDefinition", "Prompt", "AgentMessageSource", "AgentContextPipeline", "Tool"] as const) {
    files[`KindDefinitions/${kind}/manifest.xnl`] = kindDefinition(kind)
  }
  files["KindDefinitions/HolonTaskRuntimeDefinition/manifest.xnl"] =
    HOLON_TASK_RUNTIME_DEFINITION_KIND_DEFINITION_SOURCE
  for (const name of TOOL_NAMES) {
    files[`Tools/${name}.xnl`] = `<Tool #${name} envelopeVersion="${DEPA_AI_RESOURCE_ENVELOPE_VERSION}" specVersion=${DEPA_AI_RESOURCE_SPEC_VERSION} { lifecycle = "Stable" description = "Eidolon ${name} execution capability" }>\n`
  }
  return Object.freeze(Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right))))
}

type TreeDirectory = { readonly kind: "directory"; readonly children: Map<string, TreeDirectory | TreeFile> }
type TreeFile = { readonly kind: "file"; readonly content: string }

function resourceTree(files: Readonly<Record<string, string>>): TreeDirectory {
  const root: TreeDirectory = { kind: "directory", children: new Map() }
  for (const [relativePath, content] of Object.entries(files)) {
    const segments = relativePath.split("/")
    if (
      !relativePath
      || relativePath.startsWith("/")
      || relativePath.includes("\\")
      || segments.some((segment) => !segment || segment === "." || segment === "..")
    ) {
      throw new TypeError(`Unsafe Builtin resource path: ${relativePath}`)
    }
    let directory = root
    for (const segment of segments.slice(0, -1)) {
      const existing = directory.children.get(segment)
      if (existing?.kind === "file") throw new TypeError(`Resource path conflicts with a file: ${relativePath}`)
      if (existing) directory = existing
      else {
        const child: TreeDirectory = { kind: "directory", children: new Map() }
        directory.children.set(segment, child)
        directory = child
      }
    }
    const name = segments.at(-1)!
    if (directory.children.has(name)) throw new TypeError(`Duplicate resource path: ${relativePath}`)
    directory.children.set(name, { kind: "file", content })
  }
  return root
}

function vfsDirectory(name: string, logicalPath: string, directory: TreeDirectory): DataElementNode {
  const body = [...directory.children.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([childName, child]) => {
      const childPath = `${logicalPath}/${childName}`
      if (child.kind === "directory") return vfsDirectory(childName, childPath, child)
      return {
        kind: "DataElement" as const,
        tag: "file",
        metadata: { id: stableNodeId("file", childPath), name: childName },
        attributes: {
          nodeType: "file",
          fileType: childName.endsWith(".xnl") ? "xnl" : "text",
          content: child.content,
        },
      }
    })
  return {
    kind: "DataElement",
    tag: "folder",
    metadata: { id: stableNodeId("directory", logicalPath), name },
    attributes: { nodeType: "folder" },
    body,
  }
}

export function generateBuiltinEidolonVfsSnapshot(files = builtinEidolonResourceFiles()): string {
  const resources = resourceTree(files)
  const root: TreeDirectory = { kind: "directory", children: new Map([
    [".eidolon", { kind: "directory", children: new Map([
      ["resources", resources],
    ]) }],
  ]) }
  const snapshot = vfsDirectory("project", "vfs://", root)
  return `${serializeVfsSnapshotToString(snapshot, { mode: "full" }).trim()}\n`
}

export async function listBuiltinResourceFiles(root: string, prefix = ""): Promise<string[]> {
  let entries
  try {
    entries = await readdir(path.join(root, prefix), { withFileTypes: true })
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
    throw error
  }
  const files: string[] = []
  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isSymbolicLink()) throw new TypeError(`Builtin resource symlink is not supported: ${relativePath}`)
    if (entry.isDirectory()) files.push(...await listBuiltinResourceFiles(root, relativePath))
    else if (entry.isFile()) files.push(relativePath)
    else throw new TypeError(`Unsupported builtin resource entry: ${relativePath}`)
  }
  return files.sort()
}

export function assertGeneratedArtifactCurrent(actual: string | undefined, expected: string, label: string): void {
  if (actual !== expected) throw new TypeError(`Generated Builtin Eidolon VFS artifact is stale: ${label}`)
}

async function assertOrWrite(filePath: string, expected: string): Promise<void> {
  if (check) {
    const actual = await readFile(filePath, "utf8").catch(() => undefined)
    assertGeneratedArtifactCurrent(actual, expected, filePath)
    return
  }
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, expected, "utf8")
}

async function main(): Promise<void> {
  const files = builtinEidolonResourceFiles()
  const expectedPaths = Object.keys(files).sort()
  const existingPaths = await listBuiltinResourceFiles(resourceRoot)
  const unexpected = existingPaths.filter((entry) => !Object.hasOwn(files, entry))
  if (unexpected.length > 0) throw new TypeError(`Unexpected Builtin resource file(s): ${unexpected.join(", ")}`)
  for (const relativePath of expectedPaths) {
    await assertOrWrite(path.join(resourceRoot, relativePath), files[relativePath]!)
  }
  await assertOrWrite(snapshotPath, generateBuiltinEidolonVfsSnapshot(files))
  const status = check ? "verified" : "generated"
  process.stdout.write(`${status} ${expectedPaths.length} resources and ${path.relative(packageRoot, snapshotPath)}\n`)
}

if (import.meta.main) await main()
