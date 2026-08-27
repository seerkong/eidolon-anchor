import type { AgentConfig } from "@cell/ai-core-contract/runtime/AgentConfig"
import type { AiAgentActor } from "@cell/ai-core-logic/runtime/actor"

import { readWorkflowLifecycleFacet } from "./WorkflowLifecycleFacet"
import { WORKFLOW_LIFECYCLE_DEFINITION_TOOL_NAMES } from "../tools/WorkflowToolCatalog"

const LIFECYCLE_INTERNAL_TOOL_NAMES = new Set<string>(WORKFLOW_LIFECYCLE_DEFINITION_TOOL_NAMES)
const MANAGED_WORKFLOW_SKILL = /^name:\s*sys-eidolon-anchor-devops\s*$/m
const WORKFLOW_NODE_ORIGIN_OWNER_DIGEST = sha("eidolon.workflow-node-origin-owner/v1")

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`
}

function sha(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(typeof value === "string" ? value : canonical(value), "utf8").digest("hex")}`
}

export function createWorkflowNodeActorOrigin(subject: Readonly<Record<string, unknown>>): ActorOriginFact {
  const subjectDigest = sha(subject)
  return Object.freeze({
    schemaVersion: "eidolon.actor-origin/v1",
    ownerDigest: WORKFLOW_NODE_ORIGIN_OWNER_DIGEST,
    subjectDigest,
    proofDigest: sha({ ownerDigest: WORKFLOW_NODE_ORIGIN_OWNER_DIGEST, subjectDigest }),
  })
}

export function hasExactWorkflowNodeActorOrigin(actor: Pick<AiAgentActor, "origin">): boolean {
  const origin = actor.origin
  return Boolean(origin
    && origin.schemaVersion === "eidolon.actor-origin/v1"
    && origin.ownerDigest === WORKFLOW_NODE_ORIGIN_OWNER_DIGEST
    && origin.proofDigest === sha({ ownerDigest: origin.ownerDigest, subjectDigest: origin.subjectDigest }))
}

function fail(reason: string): never {
  throw new Error(`WORKFLOW_NODE_LIFECYCLE_TOOL_UNAUTHORIZED: ${reason}`)
}

function assertExactDeclaredTools(config: Pick<AgentConfig, "name" | "tools" | "requireExactTools">): readonly string[] {
  if (config.requireExactTools !== true || config.tools === "*") {
    fail(`frozen Agent task '${config.name}' requires an exact declared tool list`)
  }
  for (const toolName of config.tools) {
    if (LIFECYCLE_INTERNAL_TOOL_NAMES.has(toolName)) {
      fail(`frozen Agent task cannot admit lifecycle-internal tool '${toolName}'`)
    }
  }
  return config.tools
}

function assertNoManagedWorkflowSkill(materials: readonly string[]): void {
  if (materials.some((material) => MANAGED_WORKFLOW_SKILL.test(material))) {
    fail("workflow node cannot admit the managed lifecycle Skill")
  }
}

export function assertWorkflowNodeAgentConfigIsolation(
  config: Pick<AgentConfig, "name" | "tools" | "requireExactTools" | "prompt" | "seedMessages">,
): void {
  assertExactDeclaredTools(config)
  assertNoManagedWorkflowSkill([
    ...config.prompt,
    ...(config.seedMessages ?? [])
      .filter((message) => message.role === "system" || message.role === "developer")
      .map((message) => message.content),
  ])
}

export function assertWorkflowNodeActorIsolation(
  actor: Pick<AiAgentActor, "origin" | "runtimeFacets" | "systemPrompts" | "toolPolicy">
    & { readonly agentName?: string },
): void {
  if (!hasExactWorkflowNodeActorOrigin(actor)) {
    fail("node Actor must retain the exact domain-owned origin proof")
  }
  if (readWorkflowLifecycleFacet(actor)) {
    fail("workflow node cannot carry the lifecycle facet")
  }
  assertNoManagedWorkflowSkill(actor.systemPrompts)
  const declared = assertExactDeclaredTools({
    name: actor.agentName ?? "workflow-node",
    tools: actor.toolPolicy.allowedTools,
    requireExactTools: actor.toolPolicy.allowedToolsMode === "exact",
  })
  const surface = actor.toolPolicy.providerToolSurface
  if (surface && (surface.mode !== "exact"
    || surface.toolNames.length !== declared.length
    || surface.toolNames.some((name, index) => name !== declared[index]))) {
    fail("provider tool surface must equal the frozen exact AgentDefinition tool list")
  }
}
import { createHash } from "node:crypto"

import type { ActorOriginFact } from "@cell/ai-core-contract/runtime/AiAgentActor"
