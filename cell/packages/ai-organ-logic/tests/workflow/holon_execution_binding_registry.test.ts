import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { AgentRegistry } from "@cell/ai-core-logic/runtime/AgentRegistry"
import { createVM, ensureVmRuntimeContext } from "@cell/ai-core-logic/runtime/runtime"
import { ToolFuncRegistry } from "@cell/ai-core-logic/runtime/ToolFuncRegistry"
import { applyFileStoreAiRuntimeSessionUpgrade } from "@cell/ai-runtime-control-composer"
import {
  LocalFileConversationPersistenceRepositoryFactory,
  LocalFileRuntimeDerivedIndexesStore,
  LocalFileRuntimeSnapshotRepositoryFactory,
} from "@cell/ai-support"

import {
  HOLON_EXECUTION_BINDING_KIND_DEFINITION_SOURCE,
  canonicalHolonExecutionBindingBytes,
} from "@cell/ai-organ-contract"
import {
  HOLON_EFFECTIVE_SNAPSHOT_KIND_DEFINITION_SOURCE,
  type HolonAuthorityTables,
} from "holarchy-core-contract"
import { createAIOrganizationTaskProfile } from "ai-workflow-contract"
import { FileTaskSpaceOwner } from "task-manager-file-support"
import {
  InMemoryTaskSpaceOwner,
  claimTask,
  createTaskSpace,
  expireTaskClaim,
  replanTask,
} from "task-manager-logic"

import {
  EidolonAppResourceRegistryAdapter,
  assertHolonExecutionBindingFreezeReceipt,
} from "../../src/resources"
import {
  loadHolonDeploymentDefinition,
  materializeHolonDeploymentDefinition,
} from "../../src/organization/HolonDeploymentDefinition"
import {
  FileHolonDeploymentRuntimeStore,
  normalizeHolonDeploymentRuntimeSnapshot,
} from "../../src/organization/HolonDeploymentRuntimeStore"
import {
  ensureHolonMemberRuntime,
  holonMemberRuntimeRef,
  type HolonMemberActorOwnerPort,
  type HolonMemberSessionOwnerPort,
} from "../../src/organization/HolonMemberRuntime"
import {
  coordinateHolonTaskAssignment,
  type HolonCoordinatorActorOwnerPort,
} from "../../src/organization/HolonCoordinator"
import {
  EidolonHolonLocalActorRuntime,
  type HolonExecutionAdapterPorts,
  type HolonGenericActorOwnerPort,
} from "../../src/organization/HolonLocalActorRuntime"
import { executeHolonWorkflowTask } from "../../src/organization/HolonWorkflowTaskRuntime"
import {
  FileHolonTaskPumpJournal,
  createHolonTaskPumpDispatchIntent,
} from "../../src/organization/HolonTaskPumpJournal"
import {
  deriveHolonTaskPumpExecutionIds,
  pumpHolonTaskSpace,
} from "../../src/organization/HolonTaskSpacePump"
import { composeToolRegistry } from "../../src/composer/AIAgent/ToolFuncComposer"
import { createAiAgentOrchestratorDriver } from "../../src/OrchestratorDriver"
import {
  configureRuntimePersistenceSupport,
  recoverAiAgentRuntime,
  saveAiAgentRuntimeSnapshot,
} from "../../src/persistence/RuntimeSnapshots"
import {
  appendLiveHistoryMessageToConversationDomainRuntime,
  materializeConversationHistoryMessagesFromVm,
} from "../../src/conversation/ConversationDomainRuntime"
import { bindWorkflowComponentToRuntime, createWorkflowComponent } from "../../src/workflow"
import { WorkflowRuntimeService } from "../../src/workflow/runtime"
import {
  issueFileXnlOrganizationFixture,
  type FileXnlHolonIssuerFixture,
} from "./fileXnlHolonIssuerFixture"

const temporaryRoots: string[] = []

configureRuntimePersistenceSupport({
  snapshotRepositoryFactory: LocalFileRuntimeSnapshotRepositoryFactory,
  derivedIndexesStore: LocalFileRuntimeDerivedIndexesStore,
  conversationPersistenceRepositoryFactory: LocalFileConversationPersistenceRepositoryFactory,
})

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  issuerStateByPackageRoot.clear()
  issuerEvidenceByPackageRoot.clear()
})

const created = { createdAt: "2026-01-01T00:00:00.000Z", createdBy: "seed" }

function organizationAuthorityTables(
  principalKind: "human" | "ai" = "human",
  organization: "review" | "audit" = "review",
  effectiveAt = "2026-01-01T00:00:00.000Z",
): HolonAuthorityTables {
  const audit = organization === "audit"
  const team = audit ? "audit-team" : "review-team"
  const member = audit ? "auditor" : "reviewer"
  const role = audit ? "auditor" : "reviewer"
  const revisionFacts = {
    ...created,
    effectiveDate: effectiveAt.slice(0, 10),
    effectiveState: true as const,
    changeSetId: `fixture-${effectiveAt}`,
  }
  return {
    OrganizationalSubject: [
      { id: `subject-${team}`, subjectType: "holon" },
      { id: `subject-${member}`, subjectType: "member" },
    ],
    Holon: [
      { id: `holon-${team}`, subjectId: `subject-${team}`, code: team, ...created },
    ],
    HolonVersion: [
      { id: `holon-${team}:v1`, holonId: `holon-${team}`, name: audit ? "Audit Team" : "Review Team", purpose: audit ? "Audit" : "Review", boundary: audit ? "Controls" : "Requirements", sequence: 1, ...revisionFacts },
    ],
    Member: [
      { id: `member-${member}`, subjectId: `subject-${member}`, ...created },
    ],
    MemberVersion: [
      { id: `member-${member}:v1`, memberId: `member-${member}`, displayName: audit ? "Auditor" : "Reviewer", principalKind, sequence: 2, ...revisionFacts },
    ],
    HolonMembership: [
      { id: `membership-${member}`, ...created },
    ],
    HolonMembershipVersion: [
      { id: `membership-${member}:v1`, membershipId: `membership-${member}`, parentHolonId: `holon-${team}`, subjectId: `subject-${member}`, mode: "primary", sequence: 3, ...revisionFacts },
    ],
    Role: [
      { id: `role-${role}`, holonId: `holon-${team}`, ...created },
    ],
    RoleVersion: [
      { id: `role-${role}:v1`, roleId: `role-${role}`, name: audit ? "Auditor" : "Reviewer", purpose: audit ? "Audit" : "Review", domainsJson: JSON.stringify([audit ? "controls" : "requirements"]), accountabilitiesJson: JSON.stringify([audit ? "audit" : "review"]), policiesJson: "[]", capabilityRequirementsJson: JSON.stringify([audit ? "controls-audit" : "requirements-review"]), sequence: 4, ...revisionFacts },
    ],
    RoleAssignment: [
      { id: `assignment-${member}`, ...created },
    ],
    RoleAssignmentVersion: [
      { id: `assignment-${member}:v1`, roleAssignmentId: `assignment-${member}`, membershipId: `membership-${member}`, roleId: `role-${role}`, sequence: 5, ...revisionFacts },
    ],
  }
}

const issuerStateByPackageRoot = new Map<string, Readonly<{
  authorityRoot: string
  authorityId: string
  revision: number
}>>()
const issuerEvidenceByPackageRoot = new Map<string, FileXnlHolonIssuerFixture>()
const committedInspectionAuthorityRoot = path.resolve(
  import.meta.dir,
  "../resources/holon-task-e2e/authority",
)

async function expectIndependentProductIssuer(packageRoot: string): Promise<void> {
  const state = issuerStateByPackageRoot.get(packageRoot)
  const evidence = issuerEvidenceByPackageRoot.get(packageRoot)
  expect(state).toBeDefined()
  expect(evidence).toBeDefined()
  expect(path.resolve(state!.authorityRoot)).not.toBe(committedInspectionAuthorityRoot)
  expect(path.resolve(state!.authorityRoot).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)).toBe(true)
  const head = await readFile(path.join(state!.authorityRoot, "head.xnl"), "utf8")
  expect(head).toContain(`authorityId = "${evidence!.commitReceipt.authorityId}"`)
  expect(head).toContain(`revision = ${evidence!.commitReceipt.revision}`)
  const receiptNames = await readdir(path.join(state!.authorityRoot, "receipts"))
  expect(receiptNames).toHaveLength(1)
  expect(await readFile(path.join(state!.authorityRoot, "receipts", receiptNames[0]!), "utf8")).toContain(
    evidence!.commitReceipt.stateDigest,
  )
  expect(evidence!.reconstructedAuthority.revision).toBe(evidence!.commitReceipt.revision)
}

function issuerReceiptProvenance(evidence: FileXnlHolonIssuerFixture) {
  const { sourceAuthorityId, sourceRevision, snapshotRef, effectiveAt, issuedAt } = evidence.provenance
  return { sourceAuthorityId, sourceRevision, snapshotRef, effectiveAt, issuedAt }
}

function fixtureKindDefinition(resourceKind: string, apiVersion = "eidolon.ai/v1"): string {
  return `<KindDefinition #eidolon.fixture.kind.${resourceKind} apiVersion="halfcode.resources/v1" version="1.0.0" {
  lifecycle = "Stable"
  resourceKind = "${resourceKind}"
  sourceShapes = ["single-file"]
  currentApiVersion = "${apiVersion}"
  supportedApiVersions = ["${apiVersion}"]
}>
`
}

async function writeHolonPackage(input: {
  readonly principalKind?: "human" | "ai"
  readonly corruptReceipt?: boolean
  readonly omitDependency?: string
  readonly runtimeMode?: "shared-member-runtime" | "isolated-task-runtime"
  readonly organization?: "review" | "audit"
  readonly withWorkflow?: boolean
  readonly rootDir?: string
  readonly effectiveAt?: string
  readonly workflowEffectiveAt?: string
} = {}): Promise<string> {
  const root = input.rootDir ?? await mkdtemp(path.join(os.tmpdir(), "eidolon-holon-binding-"))
  if (input.rootDir) await mkdir(root, { recursive: true })
  else temporaryRoots.push(root)
  const organization = input.organization ?? "review"
  const audit = organization === "audit"
  const team = audit ? "audit-team" : "review-team"
  const member = audit ? "auditor" : "reviewer"
  const role = audit ? "auditor" : "reviewer"
  const organizationResourceId = `eidolon.fixture.organization.${team}`
  const effectiveAt = input.effectiveAt ?? "2026-01-01T00:00:00.000Z"
  let issuerState = issuerStateByPackageRoot.get(root)
  if (!issuerState) {
    const authorityRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-holon-authority-"))
    temporaryRoots.push(authorityRoot)
    issuerState = Object.freeze({
      authorityRoot,
      authorityId: "holarchy-file-xnl-main",
      revision: 0,
    })
  }
  const issuedAt = new Date(Date.parse(effectiveAt) + 1_000).toISOString()
  const issuerFixture = await issueFileXnlOrganizationFixture({
    authorityRoot: issuerState.authorityRoot,
    authorityId: issuerState.authorityId,
    expectedRevision: issuerState.revision,
    tables: organizationAuthorityTables(input.principalKind, organization, effectiveAt),
    executionId: `publish-${team}-${issuerState.revision + 1}`,
    executionInstant: effectiveAt,
    rootHolonRef: `holon-${team}`,
    effectiveAt,
    issuedAt,
    projectionBounds: { maxDepth: 8, maxRecords: 100 },
  })
  issuerStateByPackageRoot.set(root, Object.freeze({
    ...issuerState,
    revision: issuerFixture.commitReceipt.revision,
  }))
  issuerEvidenceByPackageRoot.set(root, issuerFixture)
  const snapshot = issuerFixture.snapshot
  const snapshotBytes = issuerFixture.snapshotBytes
  const receiptBytes = Uint8Array.from(issuerFixture.issuanceReceiptBytes)
  if (input.corruptReceipt) receiptBytes[receiptBytes.length - 2] = "x".charCodeAt(0)

  const policy = {
    version: "1",
    runtime: { mode: input.runtimeMode ?? "shared-member-runtime" },
    taskProfileRef: "resource://eidolon.fixture.dep.task-profile",
    capabilityRefs: ["resource://eidolon.fixture.dep.capability"],
    toolRefs: ["resource://eidolon.fixture.dep.tool"],
    materialRefs: [input.withWorkflow
      ? "resource://eidolon.fixture.port.review-result"
      : "resource://eidolon.fixture.dep.material"],
  }
  const binding = (id: string, target: unknown, adapter: unknown) => ({
    apiVersion: "eidolon.ai/v1",
    kind: "HolonExecutionBinding",
    bindingRef: `resource://${id}`,
    snapshotRef: `resource://${organizationResourceId}`,
    target,
    adapter,
    policy,
  })
  const bindings = [
    binding("eidolon.fixture.binding.ai", { kind: "member", memberRef: `member-${member}` }, {
      kind: "ai-agent",
      agentDefinitionRef: "resource://eidolon.fixture.agent.reviewer",
      runtimeProfileRef: "resource://eidolon.fixture.dep.agent-runtime",
    }),
    binding("eidolon.fixture.binding.human", { kind: "member", memberRef: `member-${member}` }, {
      kind: "human-endpoint",
      humanEndpointRef: "resource://eidolon.fixture.dep.human-endpoint",
      inboxProfileRef: "resource://eidolon.fixture.dep.inbox-profile",
    }),
    binding("eidolon.fixture.binding.service", { kind: "role", roleRef: `role-${role}` }, {
      kind: "service",
      serviceAdapterRef: "resource://eidolon.fixture.dep.service-adapter",
      runtimeProfileRef: "resource://eidolon.fixture.dep.service-runtime",
    }),
    binding("eidolon.fixture.binding.hybrid", { kind: "role", roleRef: `role-${role}` }, {
      kind: "hybrid",
      policyRef: "resource://eidolon.fixture.dep.hybrid-policy",
      candidateBindingRefs: ["resource://eidolon.fixture.binding.ai", "resource://eidolon.fixture.binding.human"],
    }),
  ]
  const dependencies = [
    "task-profile", "capability", "tool", "material", "agent-runtime", "human-endpoint",
    "inbox-profile", "service-adapter", "service-runtime", "hybrid-policy",
  ]

  const files: Record<string, string> = {
    "manifest.xnl": `<ResourcePackage #eidolon.fixture.holon-binding apiVersion="halfcode.resources/v1" version="1.0.0" { lifecycle = "Active" } (
  <Catalogs [
    <Catalog #kind_definitions { kind = "KindDefinition" shape = "directory" root = "vfs://./KindDefinitions/" entry = "manifest.xnl" }>
    <Catalog #snapshots { kind = "HolonEffectiveSnapshot" shape = "single-file" root = "vfs://./Organization/" }>
    <Catalog #bindings { kind = "HolonExecutionBinding" shape = "single-file" root = "vfs://./Bindings/" }>
    <Catalog #agents { kind = "AIAgentDefinition" shape = "single-file" root = "vfs://./Agents/" }>
    <Catalog #dependencies { kind = "HolonExecutionDependency" shape = "single-file" root = "vfs://./Dependencies/" }>
  ]>
)>
`,
    "KindDefinitions/HolonExecutionBinding/manifest.xnl": HOLON_EXECUTION_BINDING_KIND_DEFINITION_SOURCE,
    "KindDefinitions/HolonEffectiveSnapshot/manifest.xnl": HOLON_EFFECTIVE_SNAPSHOT_KIND_DEFINITION_SOURCE,
    "KindDefinitions/AIAgentDefinition/manifest.xnl": fixtureKindDefinition("AIAgentDefinition", "depa.flows/v1"),
    "KindDefinitions/HolonExecutionDependency/manifest.xnl": fixtureKindDefinition("HolonExecutionDependency"),
    "Organization/ReviewTeam.xnl": `<HolonEffectiveSnapshot #${organizationResourceId} apiVersion="holon.workbench/v1" version="1.0.0" {
  snapshotBytesBase64 = "${Buffer.from(snapshotBytes).toString("base64")}"
  issuanceReceiptBytesBase64 = "${Buffer.from(receiptBytes).toString("base64")}"
}>
`,
    "Agents/Reviewer.xnl": `<AIAgentDefinition #eidolon.fixture.agent.reviewer apiVersion="depa.flows/v1" version="1.0.0" {
  lifecycle = "Active"
} (
  <Messages []>
  <ToolRefs []>
  <MaterialPortRefs []>
)>
`,
  }
  if (input.withWorkflow) {
    files["manifest.xnl"] = files["manifest.xnl"].replace(
      "    <Catalog #agents",
      `    <Catalog #ctrl_workflows { kind = "AICtrlWorkflow" shape = "single-file" root = "vfs://./CtrlWorkflows/" }>
    <Catalog #data_workflows { kind = "AIDataWorkflow" shape = "single-file" root = "vfs://./DataWorkflows/" }>
    <Catalog #material_bindings { kind = "MaterialBinding" shape = "single-file" root = "vfs://./MaterialBindings/" }>
    <Catalog #materials { kind = "ArticleMaterial" shape = "single-file" root = "vfs://./Materials/" }>
    <Catalog #ports { kind = "MaterialPort" shape = "single-file" root = "vfs://./Ports/" }>
    <Catalog #schemas { kind = "MessageSchema" shape = "single-file" root = "vfs://./Schemas/" }>
    <Catalog #agents`,
    )
    files["KindDefinitions/AICtrlWorkflow/manifest.xnl"] = fixtureKindDefinition("AICtrlWorkflow", "depa.flows/v1")
    files["KindDefinitions/AIDataWorkflow/manifest.xnl"] = fixtureKindDefinition("AIDataWorkflow", "depa.flows/v1")
    files["KindDefinitions/MaterialBinding/manifest.xnl"] = fixtureKindDefinition("MaterialBinding", "depa.flows/v1")
    files["KindDefinitions/ArticleMaterial/manifest.xnl"] = fixtureKindDefinition("ArticleMaterial", "depa.flows/v1")
    files["KindDefinitions/MaterialPort/manifest.xnl"] = fixtureKindDefinition("MaterialPort", "depa.flows/v1")
    files["KindDefinitions/MessageSchema/manifest.xnl"] = fixtureKindDefinition("MessageSchema", "depa.flows/v1")
    files["Agents/Reviewer.xnl"] = `<AIAgentDefinition #eidolon.fixture.agent.reviewer apiVersion="depa.flows/v1" version="1.0.0" {
  lifecycle = "Active"
} (
  <OutputSchemaRef { kind = "MessageSchema" ref = "resource://eidolon.fixture.schema.review-result" }>
  <Messages []>
  <ToolRefs []>
  <MaterialPortRefs [
    <MaterialPortRef #review-result { kind = "MaterialPort" ref = "resource://eidolon.fixture.port.review-result" }>
  ]>
)>
`
    files["Schemas/ReviewResult.xnl"] = `<MessageSchema #eidolon.fixture.schema.review-result apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Stable" schema = { type = "object" properties = { summary = { type = "string" } } required = ["summary"] additionalProperties = false } }>
`
    files["Ports/ReviewResult.xnl"] = `<MaterialPort #eidolon.fixture.port.review-result apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Active" materialKind = "ArticleMaterial" required = true cardinality = "one" } (
  <SchemaRef { kind = "MessageSchema" ref = "resource://eidolon.fixture.schema.review-result" }>
)>
`
    files["Materials/ReviewResult.xnl"] = `<ArticleMaterial #eidolon.fixture.material.review-result apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Active" value = { summary = "seed-review" } }>
`
    files["MaterialBindings/Reviewer.xnl"] = `<MaterialBinding #eidolon.fixture.binding.review-agent-task apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Active" } (
  <AgentTaskRef { workflowKind = "AICtrlWorkflow" workflowRef = "resource://eidolon.fixture.workflow.coordination" nodeId = "open-task" agentDefinitionRef = "resource://eidolon.fixture.agent.reviewer" }>
  <PortRef { kind = "MaterialPort" ref = "resource://eidolon.fixture.port.review-result" }>
  <MaterialRef { kind = "ArticleMaterial" ref = "resource://eidolon.fixture.material.review-result" }>
)>
`
    files["MaterialBindings/ReviewerData.xnl"] = `<MaterialBinding #eidolon.fixture.binding.review-data-agent-task apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Active" } (
  <AgentTaskRef { workflowKind = "AIDataWorkflow" workflowRef = "resource://eidolon.fixture.workflow.data-coordination" nodeId = "delegate-task" agentDefinitionRef = "resource://eidolon.fixture.agent.reviewer" }>
  <PortRef { kind = "MaterialPort" ref = "resource://eidolon.fixture.port.review-result" }>
  <MaterialRef { kind = "ArticleMaterial" ref = "resource://eidolon.fixture.material.review-result" }>
)>
`
    files["CtrlWorkflows/flow-code/holon-task.ts"] = `export function openTask(runtime: any) {
  return runtime.holonTasks.openTask({
    frozenTarget: runtime.holonTasks.proofForNode("open-task"),
    commandId: "create-review-task-space",
    taskSpaceId: "review-task-space",
    taskId: "review-requirements",
    taskName: "Review requirements",
    createdAt: "2026-01-01T00:00:02.000Z",
  }, { maxTasks: 16, maxRelations: 32, maxLeaseDurationMs: 60000 })
}

export function observeTask(runtime: any) {
  return runtime.holonTasks.observeTask({
    taskSpaceId: "review-task-space",
    taskId: "review-requirements",
    settlementCommandId: "settle-review-requirements",
  }, {})
}
`
    files["DataWorkflows/flow-code/holon-data.ts"] = `export async function openDataTask(runtime: any) {
  await runtime.holonTasks.openTask({
    frozenTarget: runtime.holonTasks.proofForNode("delegate-task"),
    commandId: "create-data-review-task-space",
    taskSpaceId: "data-review-task-space",
    taskId: "data-review-requirements",
    taskName: "Review data requirements",
    createdAt: "2026-01-01T00:00:02.000Z",
  }, { maxTasks: 16, maxRelations: 32, maxLeaseDurationMs: 60000 })
  return { taskSpaceId: "data-review-task-space" }
}

export async function consumeDataTask(runtime: any) {
  const consumed = await runtime.holonTasks.consumeTask({
    frozenTarget: runtime.holonTasks.proofForNode("delegate-task"),
    taskSpaceId: "data-review-task-space",
    taskId: "data-review-requirements",
    settlementCommandId: "settle-data-review-requirements",
  }, {})
  return { summary: consumed.output.summary }
}

export function passData(_runtime: any, input: unknown) {
  return input
}
`
    files["CtrlWorkflows/Coordination.xnl"] = holonWorkflowSource("sha256:" + "0".repeat(64), input.workflowEffectiveAt)
    files["DataWorkflows/DataCoordination.xnl"] = holonDataWorkflowSource("sha256:" + "0".repeat(64), input.workflowEffectiveAt)
  }
  bindings.forEach((value, index) => {
    files[`Bindings/${["AI", "Human", "Service", "Hybrid"][index]}.xnl`] =
      `<HolonExecutionBinding #${value.bindingRef.slice("resource://".length)} apiVersion="eidolon.ai/v1" version="1.0.0" {
  bindingBytesBase64 = "${Buffer.from(canonicalHolonExecutionBindingBytes(value)).toString("base64")}"
}>
`
  })
  for (const id of dependencies) {
    if (id === input.omitDependency) continue
    files[`Dependencies/${id}.xnl`] =
      `<HolonExecutionDependency #eidolon.fixture.dep.${id} apiVersion="eidolon.ai/v1" version="1.0.0" { lifecycle = "Active" }>
`
  }
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, content, "utf8")
  }
  if (input.withWorkflow) {
    const snapshot = await new EidolonAppResourceRegistryAdapter({
      layers: [{ id: "workspace", rootDir: root }],
    }).snapshot()
    const bindingDigest = snapshot.contentIdentities.get("eidolon.fixture.binding.ai")!.contentDigest
    await writeFile(path.join(root, "CtrlWorkflows", "Coordination.xnl"), holonWorkflowSource(bindingDigest, input.workflowEffectiveAt), "utf8")
    await writeFile(path.join(root, "DataWorkflows", "DataCoordination.xnl"), holonDataWorkflowSource(bindingDigest, input.workflowEffectiveAt), "utf8")
  }
  return root
}

function holonWorkflowSource(bindingDigest: string, effectiveAt = "2026-01-01T00:00:00.000Z"): string {
  return `<AICtrlWorkflow #eidolon.fixture.workflow.coordination apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #eidolon.fixture.workflow.coordination>
) [
  <Run #open-task { src = "vfs://./flow-code/holon-task.ts#openTask" config = {
    holonTaskTarget = {
      kind = "holon-task-target"
      schemaVersion = "ai-workflow.holon-task-target/v1"
      invocation = { workflowKind = "AICtrlWorkflow" workflowRef = "resource://eidolon.fixture.workflow.coordination" nodeId = "open-task" invocationId = "review-invocation" }
      holon = { rootHolonRef = "holon-review-team" effectiveAt = "${effectiveAt}" }
      executionBinding = { ref = "resource://eidolon.fixture.binding.ai" digest = "${bindingDigest}" }
      taskSpace = { profileRef = "resource://eidolon.fixture.dep.task-profile" policyRef = "resource://eidolon.fixture.dep.agent-runtime" requiredRoleRefs = ["role-reviewer"] requiredCapabilityRefs = ["resource://eidolon.fixture.dep.capability"] }
      output = { schemaRef = "resource://eidolon.fixture.schema.review-result" materialPortRefs = ["resource://eidolon.fixture.port.review-result"] }
    }
  } }>
  <ExternalJob #await-task { signalKind = "holon.task.settled" signalKey = "review-task-space" }>
  <Run #observe-task { src = "vfs://./flow-code/holon-task.ts#observeTask" }>
  <Return #done>
]>
`
}

function holonDataWorkflowSource(bindingDigest: string, effectiveAt = "2026-01-01T00:00:00.000Z"): string {
  return `<AIDataWorkflow #eidolon.fixture.workflow.data-coordination apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #eidolon.fixture.workflow.data-coordination { inputPorts = ["requirements"] outputPorts = ["summary"] }>
) [
  <EntryNode #entry>
  <TransformNode #delegate-task { inputs = { requirements = "flow-port://#entry/requirements" } outputs = ["taskSpaceId"] src = "vfs://./flow-code/holon-data.ts#openDataTask" config = {
    holonTaskTarget = {
      kind = "holon-task-target"
      schemaVersion = "ai-workflow.holon-task-target/v1"
      invocation = { workflowKind = "AIDataWorkflow" workflowRef = "resource://eidolon.fixture.workflow.data-coordination" nodeId = "delegate-task" invocationId = "data-review-invocation" }
      holon = { rootHolonRef = "holon-review-team" effectiveAt = "${effectiveAt}" }
      executionBinding = { ref = "resource://eidolon.fixture.binding.ai" digest = "${bindingDigest}" }
      taskSpace = { profileRef = "resource://eidolon.fixture.dep.task-profile" policyRef = "resource://eidolon.fixture.dep.agent-runtime" requiredRoleRefs = ["role-reviewer"] requiredCapabilityRefs = ["resource://eidolon.fixture.dep.capability"] }
      output = { schemaRef = "resource://eidolon.fixture.schema.review-result" materialPortRefs = ["resource://eidolon.fixture.port.review-result"] }
    }
  } }>
  <TransformNode #await-task { inputs = { taskSpaceId = "flow-port://#delegate-task/taskSpaceId" } outputs = ["settled"] src = "vfs://./flow-code/holon-data.ts#passData" config = { node_type = "manual" } }>
  <TransformNode #consume-task { inputs = { settled = "flow-port://#await-task/settled" } outputs = ["summary"] src = "vfs://./flow-code/holon-data.ts#consumeDataTask" }>
  <ReturnNode #return { inputs = { summary = "flow-port://#consume-task/summary" } }>
]>
`
}

function workflowTaskFacts(
  admitted: Awaited<ReturnType<typeof materializeHolonDeploymentDefinition>>,
) {
  const bindingContentDigest = admitted.bindingFreezeReceipt.closure.find(
    ({ resourceId }) => resourceId === admitted.definition.bindingRef.slice("resource://".length),
  )!.contentDigest
  const target = Object.freeze({
    kind: "holon-task-target" as const,
    schemaVersion: "ai-workflow.holon-task-target/v1" as const,
    invocation: Object.freeze({
      workflowKind: "AICtrlWorkflow" as const,
      workflowRef: "resource://eidolon.fixture.workflow.coordination" as const,
      nodeId: "delegate-review",
      invocationId: "invocation-review-1",
    }),
    holon: Object.freeze({
      rootHolonRef: admitted.definition.rootHolonRef,
      effectiveAt: admitted.bindingProjection.snapshot.effectiveAt,
    }),
    executionBinding: Object.freeze({
      ref: admitted.definition.bindingRef,
      digest: bindingContentDigest,
    }),
    taskSpace: Object.freeze({
      profileRef: "resource://eidolon.fixture.dep.task-profile" as const,
      policyRef: "resource://eidolon.fixture.dep.agent-runtime" as const,
      requiredRoleRefs: Object.freeze(["role-reviewer"]),
      requiredCapabilityRefs: Object.freeze(["resource://eidolon.fixture.dep.capability" as const]),
    }),
    output: Object.freeze({
      schemaRef: "resource://eidolon.fixture.dep.material" as const,
      materialPortRefs: Object.freeze(["resource://eidolon.fixture.dep.material" as const]),
    }),
  })
  const snapshotReceipt = Object.freeze({
    kind: "holon-task-snapshot-receipt" as const,
    schemaVersion: "ai-workflow.holon-task-snapshot-receipt/v1" as const,
    taskSpaceId: "workflow-task-space",
    holonRef: admitted.definition.rootHolonRef,
    effectiveAt: admitted.bindingProjection.snapshot.effectiveAt,
    holonSnapshotRef: admitted.bindingProjection.snapshot.snapshotId,
    holonSnapshotDigest: admitted.bindingProjection.snapshot.treeDigest,
    snapshotArtifactDigest: admitted.bindingProjection.snapshot.treeDigest,
    issuerReceiptId: admitted.definition.snapshotReceiptDigest,
    issuerReceiptArtifactDigest: admitted.definition.snapshotReceiptDigest,
    executionBindingRef: admitted.definition.bindingRef,
    executionBindingDigest: bindingContentDigest,
    eligibleMemberRefs: Object.freeze(["member-reviewer"]),
    eligibleRoleRefs: Object.freeze(["role-reviewer"]),
  })
  return Object.freeze({ target, snapshotReceipt })
}

describe("HolonExecutionBinding shared registry projection", () => {
  it("loads all adapters from one registry and treats principalKind as descriptive evidence only", async () => {
    const humanRoot = await writeHolonPackage({ principalKind: "human" })
    const aiRoot = await writeHolonPackage({ principalKind: "ai" })
    const humanAdapter = new EidolonAppResourceRegistryAdapter({
      layers: [{ id: "workspace", rootDir: humanRoot }],
    })
    const aiAdapter = new EidolonAppResourceRegistryAdapter({
      layers: [{ id: "workspace", rootDir: aiRoot }],
    })

    const human = await humanAdapter.listHolonExecutionBindings()
    const ai = await aiAdapter.listHolonExecutionBindings()

    expect(human.map((item) => item.binding.adapter.kind))
      .toEqual(["ai-agent", "human-endpoint", "hybrid", "service"])
    expect(ai.map((item) => item.binding.adapter.kind)).toEqual(human.map((item) => item.binding.adapter.kind))
    expect(human.every((item) => item.snapshot.snapshotId
      === issuerEvidenceByPackageRoot.get(humanRoot)?.provenance.snapshotRef)).toBe(true)
    expect(human.every((item) => item.receipt.sourceAuthorityId === "holarchy-file-xnl-main")).toBe(true)
    expect(human.every((item) => item.snapshot.treeDigest
      === issuerEvidenceByPackageRoot.get(humanRoot)?.digests.snapshotTree)).toBe(true)
    expect(human.every(Object.isFrozen)).toBe(true)
  })

  it("rejects an invalid issuer receipt and an unresolved adapter dependency", async () => {
    const corrupt = new EidolonAppResourceRegistryAdapter({
      layers: [{ id: "workspace", rootDir: await writeHolonPackage({ corruptReceipt: true }) }],
    })
    await expect(corrupt.snapshot()).rejects.toThrow(/receipt|canonical|JSON/i)

    const incomplete = new EidolonAppResourceRegistryAdapter({
      layers: [{ id: "workspace", rootDir: await writeHolonPackage({ omitDependency: "service-adapter" }) }],
    })
    await expect(incomplete.snapshot()).rejects.toThrow(/service-adapter.*not present/i)
  })

  it("freezes immutable organization, adapter and Agent closure proof from the admitted snapshot", async () => {
    const root = await writeHolonPackage()
    const issuerEvidence = issuerEvidenceByPackageRoot.get(root)!
    const adapter = new EidolonAppResourceRegistryAdapter({
      layers: [{ id: "workspace", rootDir: root }],
    })
    const receipt = await adapter.freezeHolonExecutionBinding(
      "resource://eidolon.fixture.binding.hybrid",
    )

    expect(Object.isFrozen(receipt)).toBe(true)
    expect(Object.isFrozen(receipt.closure)).toBe(true)
    expect(Object.isFrozen(receipt.agentProofs)).toBe(true)
    expect(receipt.snapshotTreeDigest).toBe(issuerEvidence.digests.snapshotTree)
    expect(receipt.snapshotReceiptDigest).toBe(issuerEvidence.digests.issuanceReceiptBytes)
    expect(receipt).toMatchObject({
      schemaVersion: "eidolon.holon-execution-binding-freeze/v1",
      bindingRef: "resource://eidolon.fixture.binding.hybrid",
      snapshotRef: "resource://eidolon.fixture.organization.review-team",
      snapshotTreeDigest: expect.stringMatching(/^sha256:/),
      snapshotReceiptDigest: expect.stringMatching(/^sha256:/),
      bindingBytesDigest: expect.stringMatching(/^sha256:/),
      semanticFingerprint: expect.stringMatching(/^sha256:/),
      agentProofs: [{
        agentDefinitionRef: "resource://eidolon.fixture.agent.reviewer",
        agentContentDigest: expect.stringMatching(/^sha256:/),
        snapshotRevision: expect.stringMatching(/^sha256:/),
      }],
    })
    expect(receipt.closure.map(({ resourceId }) => resourceId)).toContain("eidolon.fixture.binding.ai")
    expect(receipt.closure.map(({ resourceId }) => resourceId)).toContain("eidolon.fixture.binding.human")
    const admittedSource = await readFile(path.join(root, "Organization", "ReviewTeam.xnl"), "utf8")
    expect(admittedSource).toContain(Buffer.from(issuerEvidence.snapshotBytes).toString("base64"))
    expect(admittedSource).toContain(Buffer.from(issuerEvidence.issuanceReceiptBytes).toString("base64"))
    expect(assertHolonExecutionBindingFreezeReceipt(receipt)).toBe(receipt)

    const forged = Object.freeze({ ...receipt })
    expect(() => assertHolonExecutionBindingFreezeReceipt(forged)).toThrow("UNTRUSTED")

    await rm(root, { recursive: true, force: true })
    expect(assertHolonExecutionBindingFreezeReceipt(receipt).semanticFingerprint)
      .toBe(receipt.semanticFingerprint)
  })

  it("materializes a frozen deployment definition and reconstructs its authentic proof without live sources", async () => {
    const liveRoot = await writeHolonPackage()
    const issuerEvidence = issuerEvidenceByPackageRoot.get(liveRoot)!
    const supportRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-holon-deployment-"))
    temporaryRoots.push(supportRoot)
    const registry = new EidolonAppResourceRegistryAdapter({
      layers: [{ id: "workspace", rootDir: liveRoot }],
    })

    const admitted = await materializeHolonDeploymentDefinition({
      supportRoot,
      resourceRegistry: registry,
    }, {
      deploymentId: "review-deployment",
      bindingRef: "resource://eidolon.fixture.binding.hybrid",
    }, {})

    expect(admitted.definition.schemaVersion).toBe("eidolon.holon-deployment-definition/v1")
    expect(admitted.definition.deploymentId).toBe("review-deployment")
    expect(admitted.definition.rootHolonRef).toBe("holon-review-team")
    expect(admitted.definition.bindingRef).toBe("resource://eidolon.fixture.binding.hybrid")
    expect(admitted.definition.snapshotRef)
      .toBe("resource://eidolon.fixture.organization.review-team")
    expect(admitted.definition.bindingSemanticFingerprint)
      .toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(admitted.definition.files.map((file) => file.path)).toContain(
      ".agent-resources/workspace/Organization/ReviewTeam.xnl",
    )
    expect(await readdir(admitted.definitionDir)).not.toContain("runtime")

    await writeFile(
      path.join(liveRoot, "Organization", "ReviewTeam.xnl"),
      "<InvalidLiveSource />\n",
      "utf8",
    )
    await rm(liveRoot, { recursive: true, force: true })

    const recovered = await loadHolonDeploymentDefinition({ supportRoot }, {
      deploymentId: "review-deployment",
    }, {})
    expect(recovered.definition).toEqual(admitted.definition)
    expect(recovered.bindingProjection.snapshot).toEqual(issuerEvidence.snapshot)
    expect(recovered.bindingProjection.receipt).toEqual(issuerEvidence.issuanceReceipt)
    expect(recovered.bindingFreezeReceipt.semanticFingerprint)
      .toBe(admitted.definition.bindingSemanticFingerprint)
    expect(assertHolonExecutionBindingFreezeReceipt(recovered.bindingFreezeReceipt))
      .toBe(recovered.bindingFreezeReceipt)
  })

  it("rejects a linked deployments root before any external definition mutation", async () => {
    const liveRoot = await writeHolonPackage()
    const supportRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-holon-support-boundary-"))
    const externalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-holon-external-boundary-"))
    temporaryRoots.push(supportRoot, externalRoot)
    await symlink(externalRoot, path.join(supportRoot, "holon-deployments"))
    const registry = new EidolonAppResourceRegistryAdapter({
      layers: [{ id: "workspace", rootDir: liveRoot }],
    })

    await expect(materializeHolonDeploymentDefinition({
      supportRoot,
      resourceRegistry: registry,
    }, {
      deploymentId: "linked-deployment",
      bindingRef: "resource://eidolon.fixture.binding.hybrid",
    }, {})).rejects.toThrow(/physical directory/)
    expect(await readdir(externalRoot)).toEqual([])
  })

  it("commits closed lifecycle facts and rolls a prepared head forward after fresh reconstruction", async () => {
    const liveRoot = await writeHolonPackage()
    const supportRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-holon-runtime-"))
    temporaryRoots.push(supportRoot)
    await materializeHolonDeploymentDefinition({
      supportRoot,
      resourceRegistry: new EidolonAppResourceRegistryAdapter({
        layers: [{ id: "workspace", rootDir: liveRoot }],
      }),
    }, {
      deploymentId: "runtime-deployment",
      bindingRef: "resource://eidolon.fixture.binding.hybrid",
    }, {})

    const store = new FileHolonDeploymentRuntimeStore({
      supportRoot,
      faultAt: "after-transaction-prepared",
    })
    const initial = await store.open("runtime-deployment")
    expect(initial.revision).toBe(0)
    const address = {
      schemaVersion: "depa-actor-address/v1" as const,
      namespace: "eidolon-holon",
      deploymentId: "runtime-deployment",
      actorKind: "coordinator",
      logicalKey: "holon-review-team",
    }
    const receipt = {
      schemaVersion: "depa-actor-registration/v1" as const,
      address,
      ownerRevision: "owner-revision-1",
      snapshotReceipt: "owner-snapshot-1",
      handlerIdentity: "eidolon-holon-coordinator-v1",
      registrationId: "coordinator-registration-1",
    }
    const next = normalizeHolonDeploymentRuntimeSnapshot({
      ...initial,
      revision: 1,
      coordinators: [{
        holonRef: "holon-review-team",
        status: "ready",
        actorRef: "generic-actor-coordinator-1",
        registrationReceipt: receipt,
      }],
      members: [{
        runtimeRef: "member-runtime-reviewer",
        holonRef: "holon-review-team",
        memberRef: "member-reviewer",
        isolation: { mode: "shared" },
        status: "ready",
        actorRef: "generic-actor-member-1",
        registrationReceipt: {
          ...receipt,
          address: { ...address, actorKind: "member", logicalKey: "member-reviewer" },
          handlerIdentity: "eidolon-holon-member-v1",
          registrationId: "member-registration-1",
        },
        sessions: [{
          mode: "task-attempt",
          taskSpaceId: "task-space-1",
          taskId: "task-1",
          claimId: "claim-1",
          attempt: 1,
          sessionRef: "generic-session-task-attempt-1",
        }],
      }],
      subscriptions: [{
        taskSpaceId: "task-space-1",
        holonRef: "holon-review-team",
        cursor: "task-space-revision-0",
        status: "observing",
      }],
    })
    expect(() => normalizeHolonDeploymentRuntimeSnapshot({
      ...next,
      members: [{ ...next.members[0], conversationHistory: [] }],
    })).toThrow(/unsupported field/i)

    await expect(store.commit({
      deploymentId: "runtime-deployment",
      expectedRevision: 0,
      next,
    })).rejects.toThrow("after-transaction-prepared")

    const recoveredStore = new FileHolonDeploymentRuntimeStore({ supportRoot })
    const recovered = await recoveredStore.load("runtime-deployment")
    expect(recovered).toEqual(next)
    expect(Object.isFrozen(recovered.members[0]?.sessions)).toBe(true)
    const runtimeRoot = path.join(
      supportRoot,
      "holon-deployments",
      "runtime-deployment",
      "runtime",
    )
    expect((await readdir(runtimeRoot)).sort((left, right) => (
      left < right ? -1 : left > right ? 1 : 0
    ))).toEqual([
      "head.json",
      "receipts",
      "records",
      "transactions",
      "trees",
    ])
    const physical = JSON.stringify(await directoryTree(runtimeRoot))
    expect(physical).not.toMatch(/mailbox|conversation|history|snapshot/i)
    await expect(recoveredStore.commit({
      deploymentId: "runtime-deployment",
      expectedRevision: 0,
      next,
    })).rejects.toThrow(/revision|CAS/i)

    await writeFile(path.join(runtimeRoot, "runtime.lock"), JSON.stringify({
      schemaVersion: "eidolon.holon-deployment-runtime-lock/v1",
      token: "dead-owner-token",
      pid: 2_147_483_647,
      createdAtMs: 1,
    }), "utf8")
    expect(await new FileHolonDeploymentRuntimeStore({ supportRoot }).load("runtime-deployment"))
      .toEqual(next)
    expect(await readdir(runtimeRoot)).not.toContain("runtime.lock")
  })

  it("reuses one MemberRuntime while isolating task-attempt sessions and requiring explicit targeted selectors", async () => {
    const liveRoot = await writeHolonPackage()
    const supportRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-holon-member-runtime-"))
    temporaryRoots.push(supportRoot)
    await materializeHolonDeploymentDefinition({
      supportRoot,
      resourceRegistry: new EidolonAppResourceRegistryAdapter({
        layers: [{ id: "workspace", rootDir: liveRoot }],
      }),
    }, {
      deploymentId: "member-deployment",
      bindingRef: "resource://eidolon.fixture.binding.hybrid",
    }, {})
    const store = new FileHolonDeploymentRuntimeStore({ supportRoot })
    await store.open("member-deployment")
    let actorCreates = 0
    const actorOwner: HolonMemberActorOwnerPort = {
      ensureMemberActor: (input) => {
        actorCreates += 1
        return Object.freeze({
          actorRef: `generic-actor:${input.runtimeRef}`,
          registrationReceipt: Object.freeze({
            schemaVersion: "depa-actor-registration/v1" as const,
            address: Object.freeze({
              schemaVersion: "depa-actor-address/v1" as const,
              namespace: "eidolon-holon",
              deploymentId: input.deploymentId,
              actorKind: "member",
              logicalKey: input.runtimeRef,
            }),
            ownerRevision: "generic-owner-1",
            snapshotReceipt: "generic-owner-snapshot-1",
            handlerIdentity: "eidolon-holon-member-v1",
            registrationId: `registration:${input.runtimeRef}`,
          }),
        })
      },
    }
    const sessionCalls: string[] = []
    const sessions: HolonMemberSessionOwnerPort = {
      ensureTaskAttemptSession: (input) => {
        sessionCalls.push(input.scopeRef)
        return Object.freeze({ sessionRef: `generic-session:${input.scopeRef}` })
      },
      resolveTargetedAgentSession: (input) => {
        sessionCalls.push(JSON.stringify(input.selector))
        return Object.freeze({
          sessionRef: "generic-session:targeted-agent",
          agentDefinitionRef: "resource://eidolon.fixture.agent.reviewer" as const,
        })
      },
    }
    const runtime = { store, actorOwner, sessions }
    const base = {
      deploymentId: "member-deployment",
      bindingRef: "resource://eidolon.fixture.binding.hybrid",
      holonRef: "holon-review-team",
      memberRef: "member-reviewer",
    }
    const first = await ensureHolonMemberRuntime(runtime, {
      ...base,
      taskAttempt: {
        taskSpaceId: "task-space-1",
        taskId: "task-1",
        claimId: "claim-1",
        attempt: 1,
        workflowInstanceId: "workflow-instance-1",
        runId: "workflow-run-1",
      },
      session: { mode: "task-attempt" },
    }, {})
    const second = await ensureHolonMemberRuntime(runtime, {
      ...base,
      taskAttempt: {
        taskSpaceId: "task-space-2",
        taskId: "task-2",
        claimId: "claim-2",
        attempt: 1,
      },
      session: { mode: "task-attempt" },
    }, {})
    const byName = await ensureHolonMemberRuntime(runtime, {
      ...base,
      taskAttempt: {
        taskSpaceId: "task-space-3",
        taskId: "task-3",
        claimId: "claim-3",
        attempt: 1,
      },
      session: {
        mode: "targeted-agent-instance",
        selector: { byName: "requirements-reviewer" },
      },
    }, {})
    const byId = await ensureHolonMemberRuntime(runtime, {
      ...base,
      taskAttempt: {
        taskSpaceId: "task-space-4",
        taskId: "task-4",
        claimId: "claim-4",
        attempt: 1,
      },
      session: {
        mode: "targeted-agent-instance",
        selector: { byId: "agent-instance-1" },
      },
    }, {})

    expect(new Set([first.runtimeRef, second.runtimeRef, byName.runtimeRef, byId.runtimeRef]).size).toBe(1)
    expect(actorCreates).toBe(1)
    expect(first.sessionRef).not.toBe(second.sessionRef)
    expect(byName.sessionRef).toBe("generic-session:targeted-agent")
    expect(byId.sessionRef).toBe("generic-session:targeted-agent")
    expect(sessionCalls).toHaveLength(4)
    expect((await store.load("member-deployment")).members).toHaveLength(1)

    await expect(ensureHolonMemberRuntime(runtime, {
      ...base,
      runtime: { mode: "isolated", scope: "task-space", isolationKey: "isolated-1" },
      taskAttempt: {
        taskSpaceId: "task-space-5",
        taskId: "task-5",
        claimId: "claim-5",
        attempt: 1,
      },
      session: { mode: "task-attempt" },
    }, {})).rejects.toThrow(/not authorize isolation/i)
    await expect(ensureHolonMemberRuntime(runtime, {
      ...base,
      taskAttempt: {
        taskSpaceId: "task-space-6",
        taskId: "task-6",
        claimId: "claim-6",
        attempt: 1,
      },
      session: {
        mode: "targeted-agent-instance",
        selector: { byId: "agent-instance-1", byName: "ambiguous" },
      },
    }, {})).rejects.toThrow(/exactly one|selector/i)

    const isolatedLiveRoot = await writeHolonPackage({ runtimeMode: "isolated-task-runtime" })
    await materializeHolonDeploymentDefinition({
      supportRoot,
      resourceRegistry: new EidolonAppResourceRegistryAdapter({
        layers: [{ id: "workspace", rootDir: isolatedLiveRoot }],
      }),
    }, {
      deploymentId: "isolated-deployment",
      bindingRef: "resource://eidolon.fixture.binding.hybrid",
    }, {})
    const isolatedStore = new FileHolonDeploymentRuntimeStore({ supportRoot })
    await isolatedStore.open("isolated-deployment")
    const isolatedRuntime = { store: isolatedStore, actorOwner, sessions }
    const isolatedBase = { ...base, deploymentId: "isolated-deployment" }
    const isolatedA = await ensureHolonMemberRuntime(isolatedRuntime, {
      ...isolatedBase,
      runtime: { mode: "isolated", scope: "task-space", isolationKey: "isolation-a" },
      taskAttempt: {
        taskSpaceId: "isolated-space-a",
        taskId: "task-a",
        claimId: "claim-a",
        attempt: 1,
      },
      session: { mode: "task-attempt" },
    }, {})
    const isolatedAReplay = await ensureHolonMemberRuntime(isolatedRuntime, {
      ...isolatedBase,
      runtime: { mode: "isolated", scope: "task-space", isolationKey: "isolation-a" },
      taskAttempt: {
        taskSpaceId: "isolated-space-a",
        taskId: "task-a",
        claimId: "claim-a",
        attempt: 1,
      },
      session: { mode: "task-attempt" },
    }, {})
    const isolatedB = await ensureHolonMemberRuntime(isolatedRuntime, {
      ...isolatedBase,
      runtime: { mode: "isolated", scope: "workflow-run", isolationKey: "isolation-b" },
      taskAttempt: {
        taskSpaceId: "isolated-space-b",
        taskId: "task-b",
        claimId: "claim-b",
        attempt: 1,
      },
      session: { mode: "task-attempt" },
    }, {})
    expect(isolatedAReplay.runtimeRef).toBe(isolatedA.runtimeRef)
    expect(isolatedB.runtimeRef).not.toBe(isolatedA.runtimeRef)
    expect((await isolatedStore.load("isolated-deployment")).members).toHaveLength(2)
    await expect(ensureHolonMemberRuntime(isolatedRuntime, {
      ...isolatedBase,
      taskAttempt: {
        taskSpaceId: "missing-policy",
        taskId: "task-missing",
        claimId: "claim-missing",
        attempt: 1,
      },
      session: { mode: "task-attempt" },
    }, {})).rejects.toThrow(/requires an explicit isolated runtime policy/i)
  })

  it("lets one Coordinator claim a frozen organization task without workflow Member preselection", async () => {
    const liveRoot = await writeHolonPackage()
    const supportRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-holon-coordinator-"))
    temporaryRoots.push(supportRoot)
    const admitted = await materializeHolonDeploymentDefinition({
      supportRoot,
      resourceRegistry: new EidolonAppResourceRegistryAdapter({
        layers: [{ id: "workspace", rootDir: liveRoot }],
      }),
    }, {
      deploymentId: "coordinator-deployment",
      bindingRef: "resource://eidolon.fixture.binding.service",
    }, {})
    const bindingContentDigest = admitted.bindingFreezeReceipt.closure.find(
      ({ resourceId }) => resourceId === "eidolon.fixture.binding.service",
    )!.contentDigest
    const store = new FileHolonDeploymentRuntimeStore({ supportRoot })
    await store.open("coordinator-deployment")
    const target = {
      kind: "holon-task-target" as const,
      schemaVersion: "ai-workflow.holon-task-target/v1" as const,
      invocation: {
        workflowKind: "AICtrlWorkflow" as const,
        workflowRef: "resource://eidolon.fixture.workflow.coordination" as const,
        nodeId: "delegate-review",
        invocationId: "invocation-review-1",
      },
      holon: {
        rootHolonRef: "holon-review-team",
        effectiveAt: admitted.bindingProjection.snapshot.effectiveAt,
      },
      executionBinding: {
        ref: admitted.definition.bindingRef,
        digest: bindingContentDigest,
      },
      taskSpace: {
        profileRef: "resource://eidolon.fixture.dep.task-profile" as const,
        policyRef: "resource://eidolon.fixture.dep.service-runtime" as const,
        requiredRoleRefs: ["role-reviewer"],
        requiredCapabilityRefs: ["resource://eidolon.fixture.dep.capability" as const],
      },
      output: {
        schemaRef: "resource://eidolon.fixture.dep.material" as const,
        materialPortRefs: ["resource://eidolon.fixture.dep.material" as const],
      },
    }
    const snapshotReceipt = {
      kind: "holon-task-snapshot-receipt" as const,
      schemaVersion: "ai-workflow.holon-task-snapshot-receipt/v1" as const,
      taskSpaceId: "organization-task-space",
      holonRef: admitted.definition.rootHolonRef,
      effectiveAt: admitted.bindingProjection.snapshot.effectiveAt,
      holonSnapshotRef: admitted.bindingProjection.snapshot.snapshotId,
      holonSnapshotDigest: admitted.bindingProjection.snapshot.treeDigest,
      snapshotArtifactDigest: admitted.bindingProjection.snapshot.treeDigest,
      issuerReceiptId: admitted.definition.snapshotReceiptDigest,
      issuerReceiptArtifactDigest: admitted.definition.snapshotReceiptDigest,
      executionBindingRef: admitted.definition.bindingRef,
      executionBindingDigest: bindingContentDigest,
      eligibleMemberRefs: ["member-reviewer"],
      eligibleRoleRefs: ["role-reviewer"],
    }
    const owner = new InMemoryTaskSpaceOwner()
    const taskManager = { owner }
    const managerConfig = { maxTasks: 8, maxRelations: 8, maxLeaseDurationMs: 60_000 }
    await createTaskSpace(taskManager, {
      kind: "task-space.create",
      commandId: "create-organization-task",
      taskSpaceId: snapshotReceipt.taskSpaceId,
      createdAt: "2026-01-01T00:00:02.000Z",
      definition: {
        kind: "task-space-definition",
        taskSpaceId: snapshotReceipt.taskSpaceId,
        name: "Review requirements",
        schemaVersion: 1,
        tasks: [{
          kind: "task",
          taskId: "review-requirements",
          name: "Review requirements",
          order: 0,
          profile: createAIOrganizationTaskProfile(target, snapshotReceipt),
          inputArtifacts: [],
        }],
        relations: [{
          kind: "parent-child",
          relationId: "root:review-requirements",
          parentTaskId: null,
          childTaskId: "review-requirements",
          order: 0,
        }],
      },
    }, managerConfig)

    let coordinatorCreates = 0
    const actorOwner: HolonCoordinatorActorOwnerPort = {
      ensureCoordinatorActor: (input) => {
        coordinatorCreates += 1
        return Object.freeze({
          actorRef: `generic-actor:${input.coordinatorRef}`,
          registrationReceipt: Object.freeze({
            schemaVersion: "depa-actor-registration/v1" as const,
            address: Object.freeze({
              schemaVersion: "depa-actor-address/v1" as const,
              namespace: "eidolon-holon",
              deploymentId: input.deploymentId,
              actorKind: "coordinator",
              logicalKey: input.coordinatorRef,
            }),
            ownerRevision: "generic-owner-1",
            snapshotReceipt: "generic-owner-snapshot-1",
            handlerIdentity: "eidolon-holon-coordinator-v1",
            registrationId: `registration:${input.coordinatorRef}`,
          }),
        })
      },
    }
    const runtime = { store, taskManager, actorOwner }
    const input = {
      deploymentId: "coordinator-deployment",
      bindingRef: admitted.definition.bindingRef,
      holonRef: admitted.definition.rootHolonRef,
      taskSpaceId: snapshotReceipt.taskSpaceId,
      taskId: "review-requirements",
      commandId: "assign-review-requirements",
      claimedAt: "2026-01-01T00:00:03.000Z",
      leaseDurationMs: 30_000,
    }
    const assigned = await coordinateHolonTaskAssignment(runtime, input, managerConfig)
    const replayed = await coordinateHolonTaskAssignment(runtime, input, managerConfig)

    expect(replayed).toEqual(assigned)
    expect(assigned.memberRef).toBe("member-reviewer")
    expect(assigned.claimReceipt.claim.assigneeRef).toBe(assigned.memberRuntimeRef)
    expect(coordinatorCreates).toBe(1)
    const taskSnapshot = await owner.readSnapshot(snapshotReceipt.taskSpaceId)
    expect(taskSnapshot?.tasks[0]?.status).toBe("Claimed")
    expect(taskSnapshot?.tasks[0]?.activeClaim).toEqual(assigned.claimReceipt.claim)
    const deploymentRuntime = await store.load("coordinator-deployment")
    expect(deploymentRuntime.coordinators).toHaveLength(1)
    expect(deploymentRuntime.subscriptions).toEqual([{
      taskSpaceId: snapshotReceipt.taskSpaceId,
      holonRef: admitted.definition.rootHolonRef,
      cursor: "task-space-revision-0",
      status: "observing",
    }])
    expect(deploymentRuntime.members).toEqual([])

    const taskRevision = taskSnapshot!.revision
    const deploymentRevision = deploymentRuntime.revision
    await expect(coordinateHolonTaskAssignment(runtime, {
      ...input,
      memberRef: "member-reviewer",
      commandId: "workflow-preselected-member",
    } as never, managerConfig)).rejects.toThrow(/unsupported fields/i)
    expect((await owner.readSnapshot(snapshotReceipt.taskSpaceId))?.revision).toBe(taskRevision)
    expect((await store.load("coordinator-deployment")).revision).toBe(deploymentRevision)
    expect(coordinatorCreates).toBe(1)
  })

  it("routes every frozen execution adapter through depa-actor while generic owners retain actor and session facts", async () => {
    const supportRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-holon-local-actor-"))
    temporaryRoots.push(supportRoot)
    const genericActors = new Map<string, string>()
    const genericSessions = new Map<string, string>()
    const genericOwner: HolonGenericActorOwnerPort = {
      ensureActor: ({ address }) => {
        const identity = `${address.deploymentId}:${address.actorKind}:${address.logicalKey}`
        if (!genericActors.has(identity)) genericActors.set(identity, `generic-actor:${identity}`)
        return Object.freeze({ actorRef: genericActors.get(identity)! })
      },
      ensureTaskAttemptSession: ({ deploymentId, runtimeRef, scopeRef }) => {
        const identity = `${deploymentId}:${runtimeRef}:${scopeRef}`
        if (!genericSessions.has(identity)) genericSessions.set(identity, `generic-session:${identity}`)
        return Object.freeze({ sessionRef: genericSessions.get(identity)! })
      },
      resolveTargetedAgentSession: () => Object.freeze({
        sessionRef: "generic-session:targeted",
        agentDefinitionRef: "resource://eidolon.fixture.agent.reviewer" as const,
      }),
    }
    const calls: string[] = []
    const idempotencyKeys: string[] = []
    const handedOffTaskAttempts: unknown[] = []
    const port = (kind: string) => ({
      executeIdempotent: (input: {
        readonly idempotencyKey: string
        readonly sessionRef: string
        readonly taskAttempt: unknown
        readonly invocation: { readonly input: unknown }
      }) => {
        calls.push(kind)
        idempotencyKeys.push(input.idempotencyKey)
        handedOffTaskAttempts.push(input.taskAttempt)
        return Object.freeze({ adapter: kind, sessionRef: input.sessionRef, input: input.invocation.input })
      },
    })
    const adapters: HolonExecutionAdapterPorts = {
      aiAgent: port("ai-agent"),
      humanEndpoint: port("human-endpoint"),
      service: port("service"),
      hybrid: port("hybrid"),
    }
    const bindings = ["ai", "human", "service", "hybrid"] as const

    for (const binding of bindings) {
      const liveRoot = await writeHolonPackage({ principalKind: "ai" })
      const deploymentId = `local-${binding}-deployment`
      const admitted = await materializeHolonDeploymentDefinition({
        supportRoot,
        resourceRegistry: new EidolonAppResourceRegistryAdapter({
          layers: [{ id: "workspace", rootDir: liveRoot }],
        }),
      }, {
        deploymentId,
        bindingRef: `resource://eidolon.fixture.binding.${binding}`,
      }, {})
      const store = new FileHolonDeploymentRuntimeStore({ supportRoot })
      await store.open(deploymentId)
      const bridge = new EidolonHolonLocalActorRuntime(store, genericOwner, adapters, `bridge-${binding}`)
      const member = await ensureHolonMemberRuntime({
        store,
        actorOwner: bridge,
        sessions: bridge,
      }, {
        deploymentId,
        bindingRef: admitted.definition.bindingRef,
        holonRef: admitted.definition.rootHolonRef,
        memberRef: "member-reviewer",
        taskAttempt: {
          taskSpaceId: `task-space-${binding}`,
          taskId: `task-${binding}`,
          claimId: `claim-${binding}`,
          attempt: 1,
        },
        session: { mode: "task-attempt" },
      }, {})
      const invocation = {
        apiVersion: "eidolon.ai/v1" as const,
        kind: "HolonExecutionInvocation" as const,
        taskSpaceRef: `task-space-${binding}`,
        taskRef: `task-${binding}`,
        claimRef: `claim-${binding}`,
        invocationRef: `invocation-${binding}`,
        targetBindingRef: admitted.definition.bindingRef,
        input: { work: `review-${binding}` },
        materialRefs: ["resource://eidolon.fixture.dep.material" as const],
        resultContractRef: "resource://eidolon.fixture.dep.material" as const,
      }
      const result = await bridge.dispatchMember(member.runtimeRef, invocation)
      expect(result.output).toMatchObject({
        adapter: binding === "ai" ? "ai-agent" : binding === "human" ? "human-endpoint" : binding,
      })
      expect(handedOffTaskAttempts.at(-1)).toEqual({
        taskSpaceId: `task-space-${binding}`,
        taskId: `task-${binding}`,
        claimId: `claim-${binding}`,
        attempt: 1,
      })
      expect(idempotencyKeys.at(-1)).toBe(invocation.invocationRef)

      if (binding === "ai") {
        const load = store.load.bind(store)
        ;(store as any).load = async (requestedDeploymentId: string) => {
          const snapshot = await load(requestedDeploymentId)
          return {
            ...snapshot,
            members: snapshot.members.map((persistedMember) => ({
              ...persistedMember,
              sessions: persistedMember.sessions.map((session) => (
                session.mode === "task-attempt" ? { ...session, attempt: 0 } : session
              )),
            })),
          }
        }
        await expect(bridge.dispatchMember(member.runtimeRef, invocation))
          .rejects.toThrow(/TASK_SESSION_UNRESOLVED.*attempt identity/i)
        ;(store as any).load = load
      }

      const actorCount = genericActors.size
      const sessionCount = genericSessions.size
      await rm(liveRoot, { recursive: true, force: true })
      const recovered = new EidolonHolonLocalActorRuntime(
        new FileHolonDeploymentRuntimeStore({ supportRoot }),
        genericOwner,
        adapters,
        `bridge-${binding}-recovered`,
      )
      await recovered.recover(deploymentId)
      expect(await recovered.dispatchMember(member.runtimeRef, invocation)).toEqual(result)
      expect(genericActors.size).toBe(actorCount)
      expect(genericSessions.size).toBe(sessionCount)
      const persisted = await store.load(deploymentId)
      expect(JSON.stringify(persisted)).not.toMatch(/conversation|history|mailbox/i)
      expect(persisted.members[0]?.actorRef).toBe(member.actorRef)
      expect(persisted.members[0]?.sessions[0]?.sessionRef).toBe(member.sessionRef)
    }
    expect(calls).toEqual([
      "ai-agent", "ai-agent",
      "human-endpoint", "human-endpoint",
      "service", "service",
      "hybrid", "hybrid",
    ])
  })

  it("hosts distinct review and audit Holons with shared and explicitly isolated MemberRuntime identities", async () => {
    const supportRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-holon-multi-journey-"))
    temporaryRoots.push(supportRoot)
    const definitions = await Promise.all([
      materializeHolonDeploymentDefinition({
        supportRoot,
        resourceRegistry: new EidolonAppResourceRegistryAdapter({
          layers: [{ id: "workspace", rootDir: await writeHolonPackage({ organization: "review" }) }],
        }),
      }, {
        deploymentId: "review-shared-deployment",
        bindingRef: "resource://eidolon.fixture.binding.hybrid",
      }, {}),
      materializeHolonDeploymentDefinition({
        supportRoot,
        resourceRegistry: new EidolonAppResourceRegistryAdapter({
          layers: [{ id: "workspace", rootDir: await writeHolonPackage({
            organization: "audit",
            runtimeMode: "isolated-task-runtime",
          }) }],
        }),
      }, {
        deploymentId: "audit-isolated-deployment",
        bindingRef: "resource://eidolon.fixture.binding.hybrid",
      }, {}),
    ])
    const actorRefs = new Map<string, string>()
    const sessionRefs = new Map<string, string>()
    const owner: HolonGenericActorOwnerPort = {
      ensureActor: ({ address }) => {
        const key = `${address.deploymentId}:${address.actorKind}:${address.logicalKey}`
        if (!actorRefs.has(key)) actorRefs.set(key, `actor:${key}`)
        return Object.freeze({ actorRef: actorRefs.get(key)! })
      },
      ensureTaskAttemptSession: ({ deploymentId, runtimeRef, scopeRef }) => {
        const key = `${deploymentId}:${runtimeRef}:${scopeRef}`
        if (!sessionRefs.has(key)) sessionRefs.set(key, `session:${key}`)
        return Object.freeze({ sessionRef: sessionRefs.get(key)! })
      },
      resolveTargetedAgentSession: () => Object.freeze({
        sessionRef: "session:targeted",
        agentDefinitionRef: "resource://eidolon.fixture.agent.reviewer" as const,
      }),
    }
    const adapters: HolonExecutionAdapterPorts = {
      aiAgent: { executeIdempotent: () => null },
      humanEndpoint: { executeIdempotent: () => null },
      service: { executeIdempotent: () => null },
      hybrid: { executeIdempotent: () => null },
    }
    const reviewStore = new FileHolonDeploymentRuntimeStore({ supportRoot })
    const auditStore = new FileHolonDeploymentRuntimeStore({ supportRoot })
    await reviewStore.open("review-shared-deployment")
    await auditStore.open("audit-isolated-deployment")
    const reviewBridge = new EidolonHolonLocalActorRuntime(reviewStore, owner, adapters, "multi-review")
    const auditBridge = new EidolonHolonLocalActorRuntime(auditStore, owner, adapters, "multi-audit")
    const ensure = (
      store: FileHolonDeploymentRuntimeStore,
      bridge: EidolonHolonLocalActorRuntime,
      input: Parameters<typeof ensureHolonMemberRuntime>[1],
    ) => ensureHolonMemberRuntime({ store, actorOwner: bridge, sessions: bridge }, input, {})
    const reviewBase = {
      deploymentId: "review-shared-deployment",
      bindingRef: definitions[0]!.definition.bindingRef,
      holonRef: "holon-review-team",
      memberRef: "member-reviewer",
    }
    const reviewOne = await ensure(reviewStore, reviewBridge, {
      ...reviewBase,
      taskAttempt: { taskSpaceId: "review-space-1", taskId: "review-1", claimId: "review-claim-1", attempt: 1 },
      session: { mode: "task-attempt" },
    })
    const reviewTwo = await ensure(reviewStore, reviewBridge, {
      ...reviewBase,
      taskAttempt: { taskSpaceId: "review-space-2", taskId: "review-2", claimId: "review-claim-2", attempt: 1 },
      session: { mode: "task-attempt" },
    })
    expect(reviewTwo.runtimeRef).toBe(reviewOne.runtimeRef)
    expect(reviewTwo.sessionRef).not.toBe(reviewOne.sessionRef)

    const auditBase = {
      deploymentId: "audit-isolated-deployment",
      bindingRef: definitions[1]!.definition.bindingRef,
      holonRef: "holon-audit-team",
      memberRef: "member-auditor",
    }
    const auditOne = await ensure(auditStore, auditBridge, {
      ...auditBase,
      runtime: { mode: "isolated", scope: "task-space", isolationKey: "audit-space-1" },
      taskAttempt: { taskSpaceId: "audit-space-1", taskId: "audit-1", claimId: "audit-claim-1", attempt: 1 },
      session: { mode: "task-attempt" },
    })
    const auditReplay = await ensure(auditStore, auditBridge, {
      ...auditBase,
      runtime: { mode: "isolated", scope: "task-space", isolationKey: "audit-space-1" },
      taskAttempt: { taskSpaceId: "audit-space-1", taskId: "audit-1", claimId: "audit-claim-1", attempt: 1 },
      session: { mode: "task-attempt" },
    })
    const auditTwo = await ensure(auditStore, auditBridge, {
      ...auditBase,
      runtime: { mode: "isolated", scope: "workflow-run", isolationKey: "audit-run-2" },
      taskAttempt: { taskSpaceId: "audit-space-2", taskId: "audit-2", claimId: "audit-claim-2", attempt: 1 },
      session: { mode: "task-attempt" },
    })
    expect(auditReplay.runtimeRef).toBe(auditOne.runtimeRef)
    expect(auditTwo.runtimeRef).not.toBe(auditOne.runtimeRef)
    expect(new Set([reviewOne.runtimeRef, auditOne.runtimeRef, auditTwo.runtimeRef]).size).toBe(3)
    expect(actorRefs.size).toBe(3)
    expect((await reviewStore.load("review-shared-deployment")).members).toHaveLength(1)
    expect((await auditStore.load("audit-isolated-deployment")).members).toHaveLength(2)
  })

  it("continuously settles a dependent organization TaskSpace through the shared MemberRuntime", async () => {
    const liveRoot = await writeHolonPackage({ principalKind: "ai" })
    const supportRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-holon-task-runtime-"))
    temporaryRoots.push(supportRoot)
    const admitted = await materializeHolonDeploymentDefinition({
      supportRoot,
      resourceRegistry: new EidolonAppResourceRegistryAdapter({
        layers: [{ id: "workspace", rootDir: liveRoot }],
      }),
    }, {
      deploymentId: "workflow-task-deployment",
      bindingRef: "resource://eidolon.fixture.binding.ai",
    }, {})
    const store = new FileHolonDeploymentRuntimeStore({ supportRoot })
    await store.open("workflow-task-deployment")
    const taskManager = {
      owner: new FileTaskSpaceOwner({ root: path.join(supportRoot, "task-spaces") }),
    }
    const { target, snapshotReceipt } = workflowTaskFacts(admitted)
    const config = { maxTasks: 8, maxRelations: 8, maxLeaseDurationMs: 60_000 }
    await createTaskSpace(taskManager, {
      kind: "task-space.create",
      commandId: "create-workflow-task",
      taskSpaceId: snapshotReceipt.taskSpaceId,
      createdAt: "2026-01-01T00:00:02.000Z",
      definition: {
        kind: "task-space-definition",
        taskSpaceId: snapshotReceipt.taskSpaceId,
        name: "Review requirements",
        schemaVersion: 1,
        tasks: [
          {
            kind: "task",
            taskId: "review-requirements",
            name: "Review requirements",
            order: 0,
            profile: createAIOrganizationTaskProfile(target, snapshotReceipt),
            inputArtifacts: [],
          },
          {
            kind: "task",
            taskId: "publish-review",
            name: "Publish review",
            order: 1,
            profile: createAIOrganizationTaskProfile(target, snapshotReceipt),
            inputArtifacts: [],
          },
        ],
        relations: [
          {
            kind: "parent-child",
            relationId: "root:review-requirements",
            parentTaskId: null,
            childTaskId: "review-requirements",
            order: 0,
          },
          {
            kind: "parent-child",
            relationId: "root:publish-review",
            parentTaskId: null,
            childTaskId: "publish-review",
            order: 1,
          },
          {
            kind: "dependency",
            relationId: "review-before-publish",
            predecessorTaskId: "review-requirements",
            successorTaskId: "publish-review",
          },
        ],
      },
    }, config)

    const actorRefs = new Map<string, string>()
    const sessionRefs = new Map<string, string>()
    const genericOwner: HolonGenericActorOwnerPort = {
      ensureActor: ({ address }) => {
        const key = `${address.deploymentId}:${address.actorKind}:${address.logicalKey}`
        if (!actorRefs.has(key)) actorRefs.set(key, `actor:${key}`)
        return Object.freeze({ actorRef: actorRefs.get(key)! })
      },
      ensureTaskAttemptSession: (input) => {
        const key = `${input.deploymentId}:${input.runtimeRef}:${input.scopeRef}`
        if (!sessionRefs.has(key)) sessionRefs.set(key, `session:${key}`)
        return Object.freeze({ sessionRef: sessionRefs.get(key)! })
      },
      resolveTargetedAgentSession: () => Object.freeze({
        sessionRef: "session:targeted",
        agentDefinitionRef: "resource://eidolon.fixture.agent.reviewer" as const,
      }),
    }
    let dispatches = 0
    const bridge = new EidolonHolonLocalActorRuntime(store, genericOwner, {
      aiAgent: { executeIdempotent: async ({ invocation }) => {
        dispatches += 1
        if (invocation.taskRef === "heartbeat-review") {
          await new Promise((resolve) => setTimeout(resolve, 220))
        }
        return { summary: "approved" }
      } },
      humanEndpoint: { executeIdempotent: () => null },
      service: { executeIdempotent: () => null },
      hybrid: { executeIdempotent: () => null },
    }, "workflow-task-runtime")
    const runtime = {
      store,
      taskManager,
      actorRuntime: bridge,
      journal: new FileHolonTaskPumpJournal({ supportRoot }),
    }
    const subscription = await runtime.journal.subscribe({
      deploymentId: "workflow-task-deployment",
      bindingRef: admitted.definition.bindingRef,
      holonRef: admitted.definition.rootHolonRef,
      snapshotReceiptId: admitted.definition.snapshotReceiptDigest,
      taskSpaceId: snapshotReceipt.taskSpaceId,
      taskId: "review-requirements",
      workflowInstanceId: "workflow-instance-1",
      runId: "workflow-run-1",
      nodeId: "review-node",
      createdAt: "2026-01-01T00:00:02.000Z",
      input: { requirements: ["R1"] },
    })
    const input = {
      subscription,
      leaseDurationMs: 30_000,
      maxSteps: 8,
      observedAt: "2026-01-01T00:00:03.000Z",
    }
    const [first, raced] = await Promise.all([
      pumpHolonTaskSpace(runtime, input, config),
      pumpHolonTaskSpace({
        ...runtime,
        journal: new FileHolonTaskPumpJournal({ supportRoot }),
      }, input, config),
    ])
    const replayed = await pumpHolonTaskSpace(runtime, input, config)

    expect(first.status).toBe("terminal")
    expect(raced.status).toBe("terminal")
    expect([...first.settlements, ...raced.settlements].every(({ status }) => status === "Succeeded")).toBe(true)
    expect(replayed).toMatchObject({ status: "terminal", steps: 0, settlements: [] })
    expect(dispatches).toBe(2)
    const terminal = await taskManager.owner.readSnapshot(snapshotReceipt.taskSpaceId)
    expect(terminal?.tasks.map(({ status }) => status)).toEqual(["Succeeded", "Succeeded"])
    expect(terminal?.tasks.every(({ outputArtifacts }) => (
      outputArtifacts[0]?.name === "resource://eidolon.fixture.dep.material"
    ))).toBe(true)
    const history = await taskManager.owner.readHistory(snapshotReceipt.taskSpaceId)
    expect(history.filter(({ kind }) => kind === "task.claimed")).toHaveLength(2)
    expect(history.filter(({ kind }) => kind === "task.settled")).toHaveLength(2)

    const firstDefinition = terminal!.definition.tasks[0]!
    await replanTask(taskManager, {
      kind: "task.replan",
      commandId: "add-heartbeat-review",
      taskSpaceId: snapshotReceipt.taskSpaceId,
      expectedRevision: terminal!.revision,
      plan: {
        kind: "task-plan",
        planId: "heartbeat-review-plan",
        reason: "Exercise canonical pump heartbeat before recovering one claimed attempt.",
        tasks: [
          ...terminal!.definition.tasks,
          { ...firstDefinition, taskId: "heartbeat-review", name: "Heartbeat review", order: 2 },
        ],
        relations: [
          ...terminal!.definition.relations,
          {
            kind: "parent-child",
            relationId: "root:heartbeat-review",
            parentTaskId: null,
            childTaskId: "heartbeat-review",
            order: 2,
          },
        ],
      },
      replannedAt: "2026-01-01T00:00:04.000Z",
    }, config)
    const heartbeatReady = (await taskManager.owner.readSnapshot(snapshotReceipt.taskSpaceId))!
    const heartbeatIds = deriveHolonTaskPumpExecutionIds({
      taskSpaceId: snapshotReceipt.taskSpaceId,
      taskId: "heartbeat-review",
      attempt: 1,
      leaseEpoch: 1,
      claimedAt: "2026-01-01T00:00:05.000Z",
    })
    const sharedRuntimeRef = holonMemberRuntimeRef({
      deploymentId: "workflow-task-deployment",
      memberRef: "member-reviewer",
      runtime: { mode: "shared" },
    })
    const heartbeatClaim = await claimTask(taskManager, {
      kind: "task.claim",
      commandId: heartbeatIds.assignmentCommandId,
      taskSpaceId: snapshotReceipt.taskSpaceId,
      expectedRevision: heartbeatReady.revision,
      taskId: "heartbeat-review",
      assigneeRef: sharedRuntimeRef,
      claimedAt: "2026-01-01T00:00:05.000Z",
      leaseDurationMs: 100,
    }, config)
    let heartbeatPumped: Awaited<ReturnType<typeof pumpHolonTaskSpace>> | undefined
    for (let wake = 0; wake < 8; wake += 1) {
      heartbeatPumped = await pumpHolonTaskSpace(runtime, {
        ...input,
        leaseDurationMs: 100,
        observedAt: `2026-01-01T00:00:05.${String(60 + wake * 10).padStart(3, "0")}Z`,
      }, config)
      if (heartbeatPumped.status !== "yielded") break
    }
    expect(heartbeatPumped.status).toBe("terminal")
    const heartbeatHistory = await taskManager.owner.readHistory(snapshotReceipt.taskSpaceId)
    expect(heartbeatHistory.filter(({ kind }) => kind === "task.claim-heartbeat-recorded").length).toBeGreaterThan(2)
    expect(heartbeatClaim.receipt.claim.expiresAt).toBe("2026-01-01T00:00:05.100Z")

    const afterHeartbeat = (await taskManager.owner.readSnapshot(snapshotReceipt.taskSpaceId))!
    await replanTask(taskManager, {
      kind: "task.replan",
      commandId: "add-expired-review",
      taskSpaceId: snapshotReceipt.taskSpaceId,
      expectedRevision: afterHeartbeat.revision,
      plan: {
        kind: "task-plan",
        planId: "expired-review-plan",
        reason: "Exercise expiry, reclaim and stale result fencing.",
        tasks: [
          ...afterHeartbeat.definition.tasks,
          { ...firstDefinition, taskId: "expired-review", name: "Expired review", order: 3 },
        ],
        relations: [
          ...afterHeartbeat.definition.relations,
          {
            kind: "parent-child",
            relationId: "root:expired-review",
            parentTaskId: null,
            childTaskId: "expired-review",
            order: 3,
          },
        ],
      },
      replannedAt: "2026-01-01T00:00:06.000Z",
    }, config)
    const expiredReady = (await taskManager.owner.readSnapshot(snapshotReceipt.taskSpaceId))!
    const expiredIds = deriveHolonTaskPumpExecutionIds({
      taskSpaceId: snapshotReceipt.taskSpaceId,
      taskId: "expired-review",
      attempt: 1,
      leaseEpoch: 1,
      claimedAt: "2026-01-01T00:00:07.000Z",
    })
    const expiredClaim = await claimTask(taskManager, {
      kind: "task.claim",
      commandId: expiredIds.assignmentCommandId,
      taskSpaceId: snapshotReceipt.taskSpaceId,
      expectedRevision: expiredReady.revision,
      taskId: "expired-review",
      assigneeRef: sharedRuntimeRef,
      claimedAt: "2026-01-01T00:00:07.000Z",
      leaseDurationMs: 10,
    }, config)
    const staleIntent = createHolonTaskPumpDispatchIntent({
      deploymentId: "workflow-task-deployment",
      taskSpaceId: snapshotReceipt.taskSpaceId,
      taskId: "expired-review",
      claimId: expiredClaim.receipt.claim.claimId,
      attempt: expiredClaim.receipt.claim.attempt,
      leaseEpoch: expiredClaim.receipt.claim.leaseEpoch,
      invocationRef: expiredIds.invocationRef,
      input: subscription.input,
      preparedAt: expiredClaim.receipt.claim.claimedAt,
    })
    await runtime.journal.dispatch(staleIntent, async () => ({ summary: "late-attempt-one" }))
    const reclaimed = await pumpHolonTaskSpace(runtime, {
      ...input,
      observedAt: "2026-01-01T00:00:07.020Z",
    }, config)
    expect(reclaimed.status).toBe("terminal")
    const afterReclaim = (await taskManager.owner.readSnapshot(snapshotReceipt.taskSpaceId))!
    expect(afterReclaim.tasks.find(({ taskId }) => taskId === "expired-review")).toMatchObject({
      status: "Succeeded",
      attempt: 2,
      leaseEpoch: 2,
    })
    await expect(executeHolonWorkflowTask(runtime, {
      deploymentId: "workflow-task-deployment",
      bindingRef: admitted.definition.bindingRef,
      holonRef: admitted.definition.rootHolonRef,
      taskSpaceId: snapshotReceipt.taskSpaceId,
      taskId: "expired-review",
      workflowInstanceId: "workflow-instance-1",
      runId: "workflow-run-1",
      ...expiredIds,
      claimedAt: "2026-01-01T00:00:07.000Z",
      startedAt: "2026-01-01T00:00:07.001Z",
      settledAt: "2026-01-01T00:00:07.002Z",
      leaseDurationMs: 10,
      input: subscription.input,
    }, config)).rejects.toThrow(/ATTEMPT_STALE|RESULT_STALE/)
    const finalHistory = await taskManager.owner.readHistory(snapshotReceipt.taskSpaceId)
    expect(finalHistory.filter((event) => (
      event.kind === "task.claim-expired" && event.taskId === "expired-review"
    ))).toHaveLength(1)
    expect((await store.load("workflow-task-deployment")).members).toHaveLength(1)
  }, 240_000)

  it("admits HolonAssign and ActorAssign only through one exact frozen workflow binding", async () => {
    const liveRoot = await writeHolonPackage({ principalKind: "ai", withWorkflow: true })
    const parent = await mkdtemp(path.join(os.tmpdir(), "eidolon-holon-product-assignment-"))
    temporaryRoots.push(parent)
    const component = createWorkflowComponent({
      workspaceRoot: path.join(parent, "workflows"),
      resourceLayers: [{ id: "workspace", rootDir: liveRoot }],
    })
    let providerCalls = 0
    const actor = createActor({
      key: "main",
      id: "holon-product-assignment-runtime",
      llmClient: {
        type: "openai",
        async createStream() {
          async function* stream() {}
          return { stream: stream() }
        },
      },
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async (vm, child) => {
          providerCalls += 1
          const message = {
            role: "assistant" as const,
            content: JSON.stringify({ summary: `product-assignment-${providerCalls}` }),
          }
          appendLiveHistoryMessageToConversationDomainRuntime({
            vm,
            actorKey: child.key,
            actorId: child.id,
            message,
          })
          return message
        },
      },
    })
    const toolRegistry = composeToolRegistry()
    const runtime = {
      vm: createVM({
        controlActorKey: actor.key,
        actors: { [actor.key]: actor },
        registries: { toolRegistry, agentRegistry: new AgentRegistry({}) },
        outerCtx: {
          workDir: parent,
          metadata: {
            sessionDir: path.join(parent, "runtime-session"),
            aiWorkflow: {
              roots: { workspaceRoot: path.join(parent, "workflows") },
              holonAutomaticPump: false,
            },
            resourcePackages: { layers: [{ id: "workspace", rootDir: liveRoot }] },
          },
        },
      }),
      actor,
    } as any
    ensureVmRuntimeContext(runtime.vm).driver = createAiAgentOrchestratorDriver({
      fibers: [{
        fiberId: `${actor.key}:${actor.id}`,
        vm: runtime.vm,
        actor,
        messages: actor.messages,
        basePriority: 1,
      }],
      runStep: async () => ({ kind: "yield" as const }),
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })
    bindWorkflowComponentToRuntime(runtime, component)
    const service = new WorkflowRuntimeService(runtime)
    const instance = await service.createInstance({
      workflowRef: "resource://eidolon.fixture.workflow.coordination",
      instanceId: "holon-product-assignment-instance",
      initialInput: { requirements: ["P1"] },
    })
    expect(await service.start({
      instanceId: instance.instanceId,
      runId: "holon-product-assignment-run",
      confirmed: true,
    })).toMatchObject({ status: "Waiting", terminal: false })

    const holon = JSON.parse(String(await ToolFuncRegistry.call(toolRegistry, "HolonCreate", runtime.vm, actor, {
      governance: "autonomous",
      name: "holon-review-team",
    })))
    expect(holon.ok).toBe(true)

    const calls = [
      ["HolonAssign", "final", "Review the product requirement", "call-product-final"],
      ["ActorAssign", "none", "Review the implementation evidence", "call-product-none"],
      ["HolonAssign", "stream", "Review the release evidence", "call-product-stream"],
    ] as const
    const receipts: any[] = []
    for (const [tool, mode, content, toolCallId] of calls) {
      const receipt = JSON.parse(String(await ToolFuncRegistry.call(toolRegistry, tool, runtime.vm, actor, {
        target: holon.holon_id,
        mode,
        content,
      }, { toolCallId })))
      expect(receipt).toMatchObject({
        ok: true,
        accepted: true,
        governance: "autonomous",
        holon_id: holon.holon_id,
        reply_mode: mode,
        workflow_run_id: "holon-product-assignment-run",
        workflow_instance_id: instance.instanceId,
        node_id: "open-task",
      })
      expect(receipt.open_receipt_id).toMatch(/^receipt:/)
      expect(receipt.snapshot_receipt_id).toMatch(/^sha256:/)
      expect(receipt.subscription_id).toMatch(/^sha256:/)
      if (mode === "final") {
        expect(receipt).toMatchObject({
          completion_status: "settled",
          terminal_status: "Succeeded",
        })
        expect(receipt.settlement_receipt_id).toMatch(/^receipt:/)
      } else {
        expect(receipt).toMatchObject({
          completion_status: mode === "none" ? "not_requested" : "waiting",
          settlement_receipt_id: null,
          terminal_status: null,
        })
      }
      receipts.push(receipt)
    }
    const instanceRoot = path.join(
      parent,
      "runtime-session",
      "workflow-runtime",
      "instances",
      instance.instanceId,
    )
    const owner = new FileTaskSpaceOwner({ root: path.join(instanceRoot, "task-spaces") })
    const backgroundDeadline = Date.now() + 60_000
    let assignmentSnapshots = await Promise.all(
      receipts.map(({ task_space_id }) => owner.readSnapshot(task_space_id)),
    )
    while (Date.now() < backgroundDeadline
      && !assignmentSnapshots.every((snapshot) => snapshot?.tasks[0]?.status === "Succeeded")) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      assignmentSnapshots = await Promise.all(
        receipts.map(({ task_space_id }) => owner.readSnapshot(task_space_id)),
      )
    }
    expect(assignmentSnapshots.map((snapshot) => snapshot?.tasks[0]?.status))
      .toEqual(["Succeeded", "Succeeded", "Succeeded"])
    expect(providerCalls).toBe(3)
    const replayed = JSON.parse(String(await ToolFuncRegistry.call(
      toolRegistry,
      calls[0][0],
      runtime.vm,
      actor,
      { target: holon.holon_id, mode: calls[0][1], content: calls[0][2] },
      { toolCallId: calls[0][3] },
    )))
    expect(replayed).toEqual(receipts[0])
    expect(providerCalls).toBe(3)
    expect(new Set(receipts.map(({ task_space_id }) => task_space_id)).size).toBe(3)
    const ambiguousInstance = await service.createInstance({
      workflowRef: "resource://eidolon.fixture.workflow.coordination",
      instanceId: "holon-product-assignment-ambiguous-instance",
      initialInput: { requirements: ["P2"] },
    })
    expect(await service.start({
      instanceId: ambiguousInstance.instanceId,
      runId: "holon-product-assignment-ambiguous-run",
      confirmed: true,
    })).toMatchObject({ status: "Waiting", terminal: false })
    const ambiguous = JSON.parse(String(await ToolFuncRegistry.call(
      toolRegistry,
      "HolonAssign",
      runtime.vm,
      actor,
      { target: holon.holon_id, mode: "final", content: "must not guess a workflow context" },
      { toolCallId: "call-product-ambiguous" },
    )))
    expect(ambiguous).toMatchObject({
      ok: false,
      error: "canonical_holon_binding_ambiguous",
      holon_id: holon.holon_id,
    })
    expect(ambiguous.authority_ids).toHaveLength(2)
    expect(providerCalls).toBe(3)
    for (const receipt of receipts) {
      expect((await owner.readSnapshot(receipt.task_space_id))?.tasks).toEqual([
        expect.objectContaining({ taskId: receipt.task_id, status: "Succeeded" }),
      ])
      expect((await owner.readHistory(receipt.task_space_id)).filter(({ kind }) => kind === "task.settled"))
        .toHaveLength(1)
    }
    const governanceActor = runtime.vm.actors[`holon:${holon.holon_id}`]
    expect(governanceActor?.holonState).not.toHaveProperty("tasks")
    expect(governanceActor?.holonState).not.toHaveProperty("taskOwnership")
  }, 240_000)

  it("automatically pumps Ctrl and Data Holon TaskSpaces and consumes their settlements", async () => {
    const liveRoot = await writeHolonPackage({ principalKind: "ai", withWorkflow: true })
    const parent = await mkdtemp(path.join(os.tmpdir(), "eidolon-holon-auto-product-"))
    temporaryRoots.push(parent)
    const component = createWorkflowComponent({
      workspaceRoot: path.join(parent, "workflows"),
      resourceLayers: [{ id: "workspace", rootDir: liveRoot }],
    })
    const aiWorkflowMetadata = {
      roots: { workspaceRoot: path.join(parent, "workflows") },
      holonAutomaticPump: true,
    }
    let providerCalls = 0
    const actor = createActor({
      key: "main",
      id: "holon-auto-runtime",
      llmClient: {
        type: "openai",
        async createStream() {
          async function* stream() {}
          return { stream: stream() }
        },
      },
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async (vm, child) => {
          providerCalls += 1
          const message = {
            role: "assistant" as const,
            content: JSON.stringify({ summary: "automatically-approved" }),
          }
          appendLiveHistoryMessageToConversationDomainRuntime({
            vm,
            actorKey: child.key,
            actorId: child.id,
            message,
          })
          return message
        },
      },
    })
    const runtime = {
      vm: createVM({
        controlActorKey: actor.key,
        actors: { [actor.key]: actor },
        registries: { toolRegistry: composeToolRegistry(), agentRegistry: new AgentRegistry({}) },
        outerCtx: {
          workDir: parent,
          metadata: {
            sessionDir: path.join(parent, "runtime-session"),
            aiWorkflow: aiWorkflowMetadata,
            resourcePackages: { layers: [{ id: "workspace", rootDir: liveRoot }] },
          },
        },
      }),
      actor,
    } as any
    bindWorkflowComponentToRuntime(runtime, component)
    const service = new WorkflowRuntimeService(runtime)
    const ctrlInstance = await service.createInstance({
      workflowRef: "resource://eidolon.fixture.workflow.coordination",
      instanceId: "holon-auto-ctrl-instance",
      initialInput: { requirements: ["C1"] },
    })
    const dataInstance = await service.createInstance({
      workflowRef: "resource://eidolon.fixture.workflow.data-coordination",
      instanceId: "holon-auto-data-instance",
      initialInput: { requirements: ["D1"] },
    })
    const replanInstance = await service.createInstance({
      workflowRef: "resource://eidolon.fixture.workflow.coordination",
      instanceId: "holon-auto-replan-instance",
      initialInput: { requirements: ["R2"] },
    })
    const yieldedInstance = await service.createInstance({
      workflowRef: "resource://eidolon.fixture.workflow.coordination",
      instanceId: "holon-auto-yielded-instance",
      initialInput: { requirements: ["Y1"] },
    })
    const waitingProbeInstance = await service.createInstance({
      workflowRef: "resource://eidolon.fixture.workflow.coordination",
      instanceId: "holon-auto-waiting-probe-instance",
      initialInput: { requirements: ["W1"] },
    })
    await rm(liveRoot, { recursive: true, force: true })

    const ctrl = await service.start({
      instanceId: ctrlInstance.instanceId,
      runId: "holon-auto-ctrl-run",
      confirmed: true,
    })
    expect(ctrl).toMatchObject({ status: "Completed", terminal: true })
    const data = await new WorkflowRuntimeService(runtime).start({
      instanceId: dataInstance.instanceId,
      runId: "holon-auto-data-run",
      confirmed: true,
    })
    expect(data).toMatchObject({
      status: "Succeeded",
      terminal: true,
      output: { summary: "automatically-approved" },
    })
    expect(providerCalls).toBe(2)

    const coordinatorFacetKey = "eidolon.holon-task-space-coordinator-actors/v1"
    const coordinatorActors = runtime.vm.actorRuntime.ensureFacet<Map<string, unknown>>(
      coordinatorFacetKey,
      () => new Map<string, unknown>(),
    )
    expect(coordinatorActors.size).toBe(2)
    const coordinatorActivations = new Map(coordinatorActors)

    const recoveredCtrl = await new WorkflowRuntimeService(runtime).continueHolonRun("holon-auto-ctrl-run")
    const recoveredData = await new WorkflowRuntimeService(runtime).continueHolonRun("holon-auto-data-run")
    expect(recoveredCtrl).toMatchObject({ status: "Completed", terminal: true })
    expect(recoveredData).toMatchObject({ status: "Succeeded", terminal: true })
    expect(providerCalls).toBe(2)
    expect(runtime.vm.actorRuntime.ensureFacet(coordinatorFacetKey, () => new Map()))
      .toBe(coordinatorActors)
    expect(new Map(coordinatorActors)).toEqual(coordinatorActivations)

    for (const [instanceId, taskSpaceId] of [
      [ctrlInstance.instanceId, "review-task-space"],
      [dataInstance.instanceId, "data-review-task-space"],
    ] as const) {
      const instanceRoot = path.join(parent, "runtime-session", "workflow-runtime", "instances", instanceId)
      const owner = new FileTaskSpaceOwner({ root: path.join(instanceRoot, "task-spaces") })
      const snapshot = await owner.readSnapshot(taskSpaceId)
      const history = await owner.readHistory(taskSpaceId)
      expect(snapshot?.tasks.every(({ status }) => status === "Succeeded")).toBe(true)
      expect(history.filter(({ kind }) => kind === "task.claimed")).toHaveLength(1)
      expect(history.filter(({ kind }) => kind === "task.settled")).toHaveLength(1)
    }

    aiWorkflowMetadata.holonAutomaticPump = false
    expect(await service.start({
      instanceId: replanInstance.instanceId,
      runId: "holon-auto-replan-run",
      confirmed: true,
    })).toMatchObject({ status: "Waiting" })
    await writeHolonPackage({
      principalKind: "ai",
      withWorkflow: true,
      rootDir: liveRoot,
      effectiveAt: "2026-02-01T00:00:00.000Z",
    })
    aiWorkflowMetadata.holonAutomaticPump = true
    const replanned = await service.replanHolonTask({
      runId: "holon-auto-replan-run",
      nodeId: "open-task",
      taskSpaceId: "review-task-space",
      previousTaskId: "review-requirements",
      successorTaskId: "review-requirements-v2",
      successorTaskName: "Review requirements after organization replan",
      successorEffectiveAt: "2026-02-01T00:00:00.000Z",
      cancelCommandId: "cancel-auto-review-for-replan",
      replanCommandId: "replan-auto-review-v2",
      planId: "auto-review-plan-v2",
      replannedAt: "2026-02-01T00:00:01.000Z",
    })
    expect(replanned.successorSnapshotReceipt.effectiveAt).toBe("2026-02-01T00:00:00.000Z")
    const ctrlRoot = path.join(
      parent,
      "runtime-session",
      "workflow-runtime",
      "instances",
      replanInstance.instanceId,
    )
    const ctrlOwner = new FileTaskSpaceOwner({ root: path.join(ctrlRoot, "task-spaces") })
    const replannedSnapshot = await ctrlOwner.readSnapshot("review-task-space")
    const replannedHistory = await ctrlOwner.readHistory("review-task-space")
    expect(replannedSnapshot?.tasks.find(({ taskId }) => taskId === "review-requirements-v2")?.status)
      .toBe("Succeeded")
    expect(await service.status("holon-auto-replan-run"))
      .toMatchObject({ status: "Completed", terminal: true })
    expect(providerCalls).toBe(3)
    expect(replannedHistory.filter(({ kind }) => kind === "task.claimed")).toHaveLength(1)
    expect(replannedHistory.filter(({ kind }) => kind === "task.settled")).toHaveLength(1)

    aiWorkflowMetadata.holonAutomaticPump = false
    expect(await service.start({
      instanceId: yieldedInstance.instanceId,
      runId: "holon-auto-yielded-run",
      confirmed: true,
    })).toMatchObject({ status: "Waiting" })
    const yieldedRoot = path.join(
      parent,
      "runtime-session",
      "workflow-runtime",
      "instances",
      yieldedInstance.instanceId,
    )
    const yieldedOwner = new FileTaskSpaceOwner({ root: path.join(yieldedRoot, "task-spaces") })
    const yieldedReady = (await yieldedOwner.readSnapshot("review-task-space"))!
    const yieldedClaimedAt = "2026-02-01T00:00:02.000Z"
    const yieldedClaim = await claimTask({ owner: yieldedOwner }, {
      kind: "task.claim",
      commandId: "external-claim-before-bounded-yield",
      taskSpaceId: "review-task-space",
      expectedRevision: yieldedReady.revision,
      taskId: "review-requirements",
      assigneeRef: "external-worker-before-bounded-yield",
      claimedAt: yieldedClaimedAt,
      leaseDurationMs: 10,
    }, { maxTasks: 16, maxRelations: 32, maxLeaseDurationMs: 60_000 })
    aiWorkflowMetadata.holonAutomaticPump = true
    expect(await new WorkflowRuntimeService(runtime, { holonPumpMaxSteps: 1 }).continueHolonRun(
      "holon-auto-yielded-run",
      new Date(Date.parse(yieldedClaim.receipt.claim.expiresAt) + 1).toISOString(),
    )).toMatchObject({ status: "Completed", terminal: true })
    expect(providerCalls).toBe(4)
    const yieldedHistory = await yieldedOwner.readHistory("review-task-space")
    expect(yieldedHistory.filter(({ kind }) => kind === "task.claim-expired")).toHaveLength(1)
    expect(yieldedHistory.filter(({ kind }) => kind === "task.settled")).toHaveLength(1)

    aiWorkflowMetadata.holonAutomaticPump = false
    expect(await service.start({
      instanceId: waitingProbeInstance.instanceId,
      runId: "holon-auto-waiting-probe-run",
      confirmed: true,
    })).toMatchObject({ status: "Waiting" })
    const waitingProbeRoot = path.join(
      parent,
      "runtime-session",
      "workflow-runtime",
      "instances",
      waitingProbeInstance.instanceId,
    )
    const waitingProbeOwner = new FileTaskSpaceOwner({ root: path.join(waitingProbeRoot, "task-spaces") })
    const waitingProbeReady = (await waitingProbeOwner.readSnapshot("review-task-space"))!
    const waitingProbeClaimedAt = new Date().toISOString()
    const waitingProbeClaim = await claimTask({ owner: waitingProbeOwner }, {
      kind: "task.claim",
      commandId: "external-live-claim-before-change-probe",
      taskSpaceId: "review-task-space",
      expectedRevision: waitingProbeReady.revision,
      taskId: "review-requirements",
      assigneeRef: "external-worker-before-change-probe",
      claimedAt: waitingProbeClaimedAt,
      leaseDurationMs: 60_000,
    }, { maxTasks: 16, maxRelations: 32, maxLeaseDurationMs: 60_000 })
    aiWorkflowMetadata.holonAutomaticPump = true
    const waitingProbeService = new WorkflowRuntimeService(runtime, { holonPumpWaitingProbeMs: 10 })
    expect(await waitingProbeService.continueHolonRun(
      "holon-auto-waiting-probe-run",
      waitingProbeClaimedAt,
    )).toMatchObject({ status: "Waiting", terminal: false })
    await expireTaskClaim({ owner: waitingProbeOwner }, {
      kind: "task.claim-expire",
      commandId: "external-unlock-for-change-probe",
      taskSpaceId: "review-task-space",
      expectedRevision: waitingProbeClaim.snapshot.revision,
      claim: waitingProbeClaim.receipt.claim,
      observedAt: waitingProbeClaim.receipt.claim.expiresAt,
    }, { maxTasks: 16, maxRelations: 32, maxLeaseDurationMs: 60_000 })
    let waitingProbeProjection: any
    const waitingProbeDeadline = Date.now() + 60_000
    while (Date.now() < waitingProbeDeadline) {
      waitingProbeProjection = await waitingProbeService.status("holon-auto-waiting-probe-run")
      if (waitingProbeProjection?.terminal) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    expect(waitingProbeProjection).toMatchObject({ status: "Completed", terminal: true })
    expect(providerCalls).toBe(5)
    await rm(liveRoot, { recursive: true, force: true })
  }, 240_000)

  it("correlates two Data Holon subscriptions with their exact manual wait nodes", async () => {
    const liveRoot = await writeHolonPackage({ principalKind: "ai", withWorkflow: true })
    const snapshot = await new EidolonAppResourceRegistryAdapter({
      layers: [{ id: "workspace", rootDir: liveRoot }],
    }).snapshot()
    const bindingDigest = snapshot.contentIdentities.get("eidolon.fixture.binding.ai")!.contentDigest
    const target = (nodeId: string, invocationId: string) => `{
      kind = "holon-task-target"
      schemaVersion = "ai-workflow.holon-task-target/v1"
      invocation = { workflowKind = "AIDataWorkflow" workflowRef = "resource://eidolon.fixture.workflow.data-coordination-multi" nodeId = "${nodeId}" invocationId = "${invocationId}" }
      holon = { rootHolonRef = "holon-review-team" effectiveAt = "2026-01-01T00:00:00.000Z" }
      executionBinding = { ref = "resource://eidolon.fixture.binding.ai" digest = "${bindingDigest}" }
      taskSpace = { profileRef = "resource://eidolon.fixture.dep.task-profile" policyRef = "resource://eidolon.fixture.dep.agent-runtime" requiredRoleRefs = ["role-reviewer"] requiredCapabilityRefs = ["resource://eidolon.fixture.dep.capability"] }
      output = { schemaRef = "resource://eidolon.fixture.schema.review-result" materialPortRefs = ["resource://eidolon.fixture.port.review-result"] }
    }`
    await writeFile(path.join(liveRoot, "DataWorkflows", "MultiCoordination.xnl"), `<AIDataWorkflow #eidolon.fixture.workflow.data-coordination-multi apiVersion="depa.flows/v1" version="1.0.0" (
  <FlowContract #eidolon.fixture.workflow.data-coordination-multi { inputPorts = ["requirements"] outputPorts = ["summaryA" "summaryB"] }>
) [
  <EntryNode #entry>
  <TransformNode #delegate-a { inputs = { requirements = "flow-port://#entry/requirements" } outputs = ["spaceA"] src = "vfs://./flow-code/holon-multi-data.ts#openA" config = { holonTaskTarget = ${target("delegate-a", "multi-a")} } }>
  <TransformNode #delegate-b { inputs = { requirements = "flow-port://#entry/requirements" } outputs = ["spaceB"] src = "vfs://./flow-code/holon-multi-data.ts#openB" config = { holonTaskTarget = ${target("delegate-b", "multi-b")} } }>
  <TransformNode #await-a { inputs = { spaceA = "flow-port://#delegate-a/spaceA" } outputs = ["settledA"] src = "vfs://./flow-code/holon-multi-data.ts#pass" config = { node_type = "manual" } }>
  <TransformNode #await-b { inputs = { spaceB = "flow-port://#delegate-b/spaceB" } outputs = ["settledB"] src = "vfs://./flow-code/holon-multi-data.ts#pass" config = { node_type = "manual" } }>
  <TransformNode #consume-a { inputs = { settledA = "flow-port://#await-a/settledA" } outputs = ["summaryA"] src = "vfs://./flow-code/holon-multi-data.ts#consumeA" }>
  <TransformNode #consume-b { inputs = { settledB = "flow-port://#await-b/settledB" } outputs = ["summaryB"] src = "vfs://./flow-code/holon-multi-data.ts#consumeB" }>
  <ReturnNode #return { inputs = { summaryA = "flow-port://#consume-a/summaryA" summaryB = "flow-port://#consume-b/summaryB" } }>
]>
`, "utf8")
    await writeFile(path.join(liveRoot, "DataWorkflows", "flow-code", "holon-multi-data.ts"), `
async function open(runtime: any, nodeId: string, taskSpaceId: string, taskId: string) {
  await runtime.holonTasks.openTask({
    frozenTarget: runtime.holonTasks.proofForNode(nodeId),
    commandId: "create-" + taskSpaceId,
    taskSpaceId,
    taskId,
    taskName: taskId,
    createdAt: "2026-01-01T00:00:02.000Z",
  }, { maxTasks: 16, maxRelations: 32, maxLeaseDurationMs: 60000 })
}
export async function openA(runtime: any) { await open(runtime, "delegate-a", "multi-space-a", "multi-task-a"); return { spaceA: "multi-space-a" } }
export async function openB(runtime: any) { await open(runtime, "delegate-b", "multi-space-b", "multi-task-b"); return { spaceB: "multi-space-b" } }
export function pass(_runtime: any, input: unknown) { return input }
export async function consumeA(runtime: any) {
  const value = await runtime.holonTasks.consumeTask({ frozenTarget: runtime.holonTasks.proofForNode("delegate-a"), taskSpaceId: "multi-space-a", taskId: "multi-task-a", settlementCommandId: "semantic-a" }, {})
  return { summaryA: value.output.summary }
}
export async function consumeB(runtime: any) {
  const value = await runtime.holonTasks.consumeTask({ frozenTarget: runtime.holonTasks.proofForNode("delegate-b"), taskSpaceId: "multi-space-b", taskId: "multi-task-b", settlementCommandId: "semantic-b" }, {})
  return { summaryB: value.output.summary }
}
`, "utf8")
    for (const [suffix, nodeId] of [["A", "delegate-a"], ["B", "delegate-b"]] as const) {
      await writeFile(path.join(liveRoot, "MaterialBindings", `ReviewerMulti${suffix}.xnl`), `<MaterialBinding #eidolon.fixture.binding.review-data-multi-${suffix.toLowerCase()} apiVersion="depa.flows/v1" version="1.0.0" { lifecycle = "Active" } (
  <AgentTaskRef { workflowKind = "AIDataWorkflow" workflowRef = "resource://eidolon.fixture.workflow.data-coordination-multi" nodeId = "${nodeId}" agentDefinitionRef = "resource://eidolon.fixture.agent.reviewer" }>
  <PortRef { kind = "MaterialPort" ref = "resource://eidolon.fixture.port.review-result" }>
  <MaterialRef { kind = "ArticleMaterial" ref = "resource://eidolon.fixture.material.review-result" }>
)>
`, "utf8")
    }

    const parent = await mkdtemp(path.join(os.tmpdir(), "eidolon-holon-multi-data-"))
    temporaryRoots.push(parent)
    const component = createWorkflowComponent({
      workspaceRoot: path.join(parent, "workflows"),
      resourceLayers: [{ id: "workspace", rootDir: liveRoot }],
    })
    let providerCalls = 0
    const actor = createActor({
      key: "main",
      id: "holon-multi-data-runtime",
      llmClient: { type: "openai", async createStream() { async function* stream() {}; return { stream: stream() } } },
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async (vm, child) => {
          providerCalls += 1
          const message = { role: "assistant" as const, content: JSON.stringify({ summary: child.id }) }
          appendLiveHistoryMessageToConversationDomainRuntime({ vm, actorKey: child.key, actorId: child.id, message })
          return message
        },
      },
    })
    const runtime = {
      vm: createVM({
        controlActorKey: actor.key,
        actors: { [actor.key]: actor },
        registries: { toolRegistry: composeToolRegistry(), agentRegistry: new AgentRegistry({}) },
        outerCtx: { workDir: parent, metadata: {
          sessionDir: path.join(parent, "runtime-session"),
          aiWorkflow: { roots: { workspaceRoot: path.join(parent, "workflows") } },
          resourcePackages: { layers: [{ id: "workspace", rootDir: liveRoot }] },
        } },
      }),
      actor,
    } as any
    bindWorkflowComponentToRuntime(runtime, component)
    const service = new WorkflowRuntimeService(runtime)
    const instance = await service.createInstance({
      workflowRef: "resource://eidolon.fixture.workflow.data-coordination-multi",
      instanceId: "holon-multi-data-instance",
      initialInput: { requirements: ["M1"] },
    })
    await rm(liveRoot, { recursive: true, force: true })
    const completed = await service.start({ instanceId: instance.instanceId, runId: "holon-multi-data-run", confirmed: true })
    expect(completed).toMatchObject({ status: "Succeeded", terminal: true })
    expect(providerCalls).toBe(2)
    const waits = completed.nodes.filter(({ id }: any) => id === "await-a" || id === "await-b")
    expect(waits.map(({ result }: any) => result.output).sort((left: any, right: any) => (
      Object.keys(left)[0]!.localeCompare(Object.keys(right)[0]!)
    ))).toEqual([
      { settledA: expect.stringContaining("receipt:holon-pump-settle-") },
      { settledB: expect.stringContaining("receipt:holon-pump-settle-") },
    ])
    expect(waits[0]!.result.output).not.toEqual(waits[1]!.result.output)
    const instanceRoot = path.join(parent, "runtime-session", "workflow-runtime", "instances", instance.instanceId)
    const owner = new FileTaskSpaceOwner({ root: path.join(instanceRoot, "task-spaces") })
    for (const taskSpaceId of ["multi-space-a", "multi-space-b"]) {
      expect((await owner.readHistory(taskSpaceId)).filter(({ kind }) => kind === "task.settled")).toHaveLength(1)
    }
  }, 30_000)

  it("recovers both effect-result and settlement-Flow crash windows without redispatching the Agent", async () => {
    const liveRoot = await writeHolonPackage({ principalKind: "ai", withWorkflow: true })
    const parent = await mkdtemp(path.join(os.tmpdir(), "eidolon-holon-auto-recovery-"))
    temporaryRoots.push(parent)
    const component = createWorkflowComponent({
      workspaceRoot: path.join(parent, "workflows"),
      resourceLayers: [{ id: "workspace", rootDir: liveRoot }],
    })
    let providerCalls = 0
    const actor = createActor({
      key: "main",
      id: "holon-recovery-runtime",
      llmClient: {
        type: "openai",
        async createStream() {
          async function* stream() {}
          return { stream: stream() }
        },
      },
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async (vm, child) => {
          providerCalls += 1
          const message = { role: "assistant" as const, content: JSON.stringify({ summary: "recovered" }) }
          appendLiveHistoryMessageToConversationDomainRuntime({ vm, actorKey: child.key, actorId: child.id, message })
          return message
        },
      },
    })
    const aiWorkflowMetadata = {
      roots: { workspaceRoot: path.join(parent, "workflows") },
      holonAutomaticPump: false,
    }
    const runtime = {
      vm: createVM({
        controlActorKey: actor.key,
        actors: { [actor.key]: actor },
        registries: { toolRegistry: composeToolRegistry(), agentRegistry: new AgentRegistry({}) },
        outerCtx: {
          workDir: parent,
          metadata: {
            sessionId: "holon-recovery-runtime-session",
            sessionDir: path.join(parent, "runtime-session"),
            aiWorkflow: aiWorkflowMetadata,
            resourcePackages: { layers: [{ id: "workspace", rootDir: liveRoot }] },
          },
        },
      }),
      actor,
    } as any
    bindWorkflowComponentToRuntime(runtime, component)
    const service = new WorkflowRuntimeService(runtime)
    const instance = await service.createInstance({
      workflowRef: "resource://eidolon.fixture.workflow.coordination",
      instanceId: "holon-auto-recovery-instance",
      initialInput: { requirements: ["R1"] },
    })
    const effectInstance = await service.createInstance({
      workflowRef: "resource://eidolon.fixture.workflow.coordination",
      instanceId: "holon-effect-recovery-instance",
      initialInput: { requirements: ["R2"] },
    })
    const providerEffectInstance = await service.createInstance({
      workflowRef: "resource://eidolon.fixture.workflow.coordination",
      instanceId: "holon-provider-effect-recovery-instance",
      initialInput: { requirements: ["R3"] },
    })
    await rm(liveRoot, { recursive: true, force: true })
    expect(await service.start({ instanceId: instance.instanceId, runId: "holon-auto-recovery-run", confirmed: true }))
      .toMatchObject({ status: "Waiting" })

    aiWorkflowMetadata.holonAutomaticPump = true
    const faulted = new WorkflowRuntimeService(runtime, {
      holonFaults: {
        afterTaskSpaceSettlement: () => { throw new Error("INJECTED_POST_SETTLEMENT_PRE_FLOW_CONSUME_CRASH") },
      },
    })
    await expect(faulted.continueHolonRun("holon-auto-recovery-run"))
      .rejects.toThrow(/INJECTED_POST_SETTLEMENT_PRE_FLOW_CONSUME_CRASH/)
    expect(providerCalls).toBe(1)

    const recovered = await new WorkflowRuntimeService(runtime).start({
      instanceId: instance.instanceId,
      runId: "holon-auto-recovery-run",
      confirmed: true,
    })
    expect(recovered).toMatchObject({ status: "Completed", terminal: true })
    expect(providerCalls).toBe(1)
    const instanceRoot = path.join(parent, "runtime-session", "workflow-runtime", "instances", instance.instanceId)
    const freshOwner = new FileTaskSpaceOwner({ root: path.join(instanceRoot, "task-spaces") })
    const history = await freshOwner.readHistory("review-task-space")
    expect(history.filter(({ kind }) => kind === "task.claimed")).toHaveLength(1)
    expect(history.filter(({ kind }) => kind === "task.settled")).toHaveLength(1)

    aiWorkflowMetadata.holonAutomaticPump = false
    expect(await service.start({
      instanceId: effectInstance.instanceId,
      runId: "holon-effect-recovery-run",
      confirmed: true,
    })).toMatchObject({ status: "Waiting" })
    aiWorkflowMetadata.holonAutomaticPump = true
    const effectFaulted = new WorkflowRuntimeService(runtime, {
      holonJournalFaults: {
        afterEffect: () => { throw new Error("INJECTED_EFFECT_RESULT_PERSISTENCE_CRASH") },
      },
    })
    await expect(effectFaulted.continueHolonRun("holon-effect-recovery-run"))
      .rejects.toThrow(/INJECTED_EFFECT_RESULT_PERSISTENCE_CRASH/)
    expect(providerCalls).toBe(2)
    const effectRoot = path.join(
      parent,
      "runtime-session",
      "workflow-runtime",
      "instances",
      effectInstance.instanceId,
    )
    const effectOwner = new FileTaskSpaceOwner({ root: path.join(effectRoot, "task-spaces") })
    const effectClaim = (await effectOwner.readSnapshot("review-task-space"))
      ?.tasks.find(({ taskId }) => taskId === "review-requirements")?.activeClaim
    expect(effectClaim).toBeTruthy()
    const effectRecovered = await new WorkflowRuntimeService(runtime).continueHolonRun(
      "holon-effect-recovery-run",
      new Date(Date.parse(effectClaim!.expiresAt) + 1).toISOString(),
    )
    expect(effectRecovered).toMatchObject({ status: "Completed", terminal: true })
    expect(providerCalls).toBe(2)

    aiWorkflowMetadata.holonAutomaticPump = false
    expect(await service.start({
      instanceId: providerEffectInstance.instanceId,
      runId: "holon-provider-effect-recovery-run",
      confirmed: true,
    })).toMatchObject({ status: "Waiting" })
    aiWorkflowMetadata.holonAutomaticPump = true
    const providerFaulted = new WorkflowRuntimeService(runtime, {
      holonEffectFaults: {
        afterResourceAgentResultPersistence: () => { throw new Error("INJECTED_PROVIDER_RESULT_EVIDENCE_CRASH") },
      },
    })
    await expect(providerFaulted.continueHolonRun("holon-provider-effect-recovery-run"))
      .rejects.toThrow(/INJECTED_PROVIDER_RESULT_EVIDENCE_CRASH/)
    expect(providerCalls).toBe(3)
    const providerEffectRoot = path.join(
      parent,
      "runtime-session",
      "workflow-runtime",
      "instances",
      providerEffectInstance.instanceId,
    )
    const [providerEffectDeploymentId] = await readdir(path.join(providerEffectRoot, "holon-deployments"))
    expect(providerEffectDeploymentId).toBeTruthy()
    const providerCoordinatorKey = `${providerEffectDeploymentId}\u0000holon-review-team`
    const originalCoordinatorActors = runtime.vm.actorRuntime.ensureFacet<Map<string, any>>(
      "eidolon.holon-task-space-coordinator-actors/v1",
      () => new Map<string, any>(),
    )
    const originalCoordinator = originalCoordinatorActors.get(providerCoordinatorKey)
    expect(originalCoordinator).toBeTruthy()
    const deploymentBeforeRecovery = await new FileHolonDeploymentRuntimeStore({
      supportRoot: providerEffectRoot,
    }).load(providerEffectDeploymentId!)
    expect(deploymentBeforeRecovery.coordinators).toHaveLength(1)
    const providerEffectOwner = new FileTaskSpaceOwner({ root: path.join(providerEffectRoot, "task-spaces") })
    const providerEffectClaim = (await providerEffectOwner.readSnapshot("review-task-space"))
      ?.tasks.find(({ taskId }) => taskId === "review-requirements")?.activeClaim
    expect(providerEffectClaim).toBeTruthy()
    const snapshotDriver = createAiAgentOrchestratorDriver({
      fibers: Object.values(runtime.vm.actors).map((currentActor: any) => ({
        fiberId: `${currentActor.key}:${currentActor.id}`,
        vm: runtime.vm,
        actor: currentActor,
        messages: currentActor.messages,
        basePriority: 1,
      })),
      runStep: async () => ({ kind: "yield" as const }),
      options: { agingStep: 0, defaultSuspendPolicy: "continue_others" },
    })
    expect((await saveAiAgentRuntimeSnapshot({
      sessionDir: path.join(parent, "runtime-session"),
      sessionId: "holon-recovery-runtime-session",
      vm: runtime.vm,
      driver: snapshotDriver,
    })).status).toBe("saved")
    expect(["applied", "already_upgraded"]).toContain((await applyFileStoreAiRuntimeSessionUpgrade({
      sessionDir: path.join(parent, "runtime-session"),
    })).status)
    const recoveredRuntimeOwner = await recoverAiAgentRuntime({
      sessionDir: path.join(parent, "runtime-session"),
      sessionId: "holon-recovery-runtime-session",
      llmClient: runtime.actor.llmClient,
      actorCallbacks: runtime.actor.callbacks,
      registries: runtime.vm.registries,
      callbacks: runtime.vm.callbacks,
      effects: runtime.vm.effects,
      outerCtx: runtime.vm.outerCtx,
      mcpManager: runtime.vm.mcpManager,
    })
    expect(recoveredRuntimeOwner).not.toBeNull()
    expect(recoveredRuntimeOwner!.vm).not.toBe(runtime.vm)
    const recoveredRuntime = {
      vm: recoveredRuntimeOwner!.vm,
      actor: recoveredRuntimeOwner!.controlActor,
    } as any
    bindWorkflowComponentToRuntime(recoveredRuntime, component)
    const providerEffectRecovered = await new WorkflowRuntimeService(recoveredRuntime).continueHolonRun(
      "holon-provider-effect-recovery-run",
      new Date(Date.parse(providerEffectClaim!.expiresAt) + 1).toISOString(),
    )
    expect(providerEffectRecovered).toMatchObject({ status: "Completed", terminal: true })
    expect(providerCalls).toBe(3)
    const recoveredCoordinatorActors = recoveredRuntime.vm.actorRuntime.ensureFacet<Map<string, any>>(
      "eidolon.holon-task-space-coordinator-actors/v1",
      () => new Map<string, any>(),
    )
    const recoveredCoordinator = recoveredCoordinatorActors.get(providerCoordinatorKey)
    expect(recoveredCoordinator).toBeTruthy()
    expect(recoveredCoordinator).not.toBe(originalCoordinator)
    expect(recoveredCoordinator.actorId).toBe(originalCoordinator.actorId)
    const deploymentAfterRecovery = await new FileHolonDeploymentRuntimeStore({
      supportRoot: providerEffectRoot,
    }).load(providerEffectDeploymentId!)
    expect(deploymentAfterRecovery.coordinators).toEqual(deploymentBeforeRecovery.coordinators)
  }, 60_000)

  it("runs a frozen Ctrl Holon task through settlement then consumes it in a fresh Flow checkpoint", async () => {
    const liveRoot = await writeHolonPackage({ principalKind: "ai", withWorkflow: true })
    await expectIndependentProductIssuer(liveRoot)
    const initialIssuerEvidence = issuerEvidenceByPackageRoot.get(liveRoot)!
    const parent = await mkdtemp(path.join(os.tmpdir(), "eidolon-holon-ctrl-product-"))
    temporaryRoots.push(parent)
    const component = createWorkflowComponent({
      workspaceRoot: path.join(parent, "workflows"),
      resourceLayers: [{ id: "workspace", rootDir: liveRoot }],
    })
    let providerCalls = 0
    const actor = createActor({
      key: "main",
      id: "holon-ctrl-runtime",
      llmClient: {
        type: "openai",
        async createStream() {
          async function* stream() {}
          return { stream: stream() }
        },
      },
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async (vm, child) => {
          providerCalls += 1
          const message = {
            role: "assistant" as const,
            content: JSON.stringify({ summary: "organization-approved" }),
          }
          appendLiveHistoryMessageToConversationDomainRuntime({
            vm,
            actorKey: child.key,
            actorId: child.id,
            message,
          })
          return message
        },
      },
    })
    const runtime = {
      vm: createVM({
        controlActorKey: actor.key,
        actors: { [actor.key]: actor },
        registries: { toolRegistry: composeToolRegistry(), agentRegistry: new AgentRegistry({}) },
        outerCtx: {
          workDir: parent,
          metadata: {
            sessionDir: path.join(parent, "runtime-session"),
            aiWorkflow: {
              roots: { workspaceRoot: path.join(parent, "workflows") },
              holonAutomaticPump: false,
            },
            resourcePackages: { layers: [{ id: "workspace", rootDir: liveRoot }] },
          },
        },
      }),
      actor,
    } as any
    bindWorkflowComponentToRuntime(runtime, component)
    const authoring = new WorkflowRuntimeService(runtime)
    const instance = await authoring.createInstance({
      workflowRef: "resource://eidolon.fixture.workflow.coordination",
      instanceId: "holon-ctrl-instance",
      initialInput: { requirements: ["R1"] },
    })
    await rm(liveRoot, { recursive: true, force: true })

    const started = await authoring.start({
      instanceId: instance.instanceId,
      runId: "holon-ctrl-run",
      confirmed: true,
    })
    expect(started).toMatchObject({ status: "Waiting" })
    expect(providerCalls).toBe(0)
    const activeContext = (authoring as any).holonContexts.get("holon-ctrl-run")
    const initialDeployment = [...activeContext.deployments.values()][0] as any
    expect(initialDeployment.definition.bindingProjection.receipt).toMatchObject(
      issuerReceiptProvenance(initialIssuerEvidence),
    )
    expect(initialIssuerEvidence.provenance).toMatchObject({
      issuerPackage: "holarchy-file-xnl-capsule",
      issuerPackageVersion: "0.2.0",
    })
    expect(initialDeployment.definition.bindingProjection.snapshot.treeDigest)
      .toBe(initialIssuerEvidence.digests.snapshotTree)
    expect(initialDeployment.definition.bindingFreezeReceipt.snapshotReceiptDigest)
      .toBe(initialIssuerEvidence.digests.issuanceReceiptBytes)

    const taskInput = {
      runId: "holon-ctrl-run",
      nodeId: "open-task",
      taskSpaceId: "review-task-space",
      taskId: "review-requirements",
      assignmentCommandId: "assign-review-requirements",
      startCommandId: "start-review-requirements",
      settlementCommandId: "settle-review-requirements",
      invocationRef: "invoke-review-requirements",
      claimedAt: "2026-01-01T00:00:03.000Z",
      startedAt: "2026-01-01T00:00:04.000Z",
      settledAt: "2026-01-01T00:00:05.000Z",
      leaseDurationMs: 30_000,
      input: { requirements: ["R1"] },
    } as const
    const settled = await authoring.processHolonTask(taskInput)
    expect(settled.settlementReceipt.status).toBe("Succeeded")
    expect(settled.outputArtifacts[0]?.name).toBe("resource://eidolon.fixture.port.review-result")
    expect(providerCalls).toBe(1)

    const instanceRoot = path.join(
      parent,
      "runtime-session",
      "workflow-runtime",
      "instances",
      instance.instanceId,
    )
    const taskOwner = new FileTaskSpaceOwner({ root: path.join(instanceRoot, "task-spaces") })
    const snapshotAfterFirstTask = (await taskOwner.readSnapshot("review-task-space"))!
    const firstTaskDefinition = snapshotAfterFirstTask.definition.tasks.find(
      ({ taskId }) => taskId === taskInput.taskId,
    )!
    const sameMemberTaskId = "review-requirements-followup"
    await replanTask({ owner: taskOwner }, {
      kind: "task.replan",
      commandId: "add-review-requirements-followup",
      taskSpaceId: "review-task-space",
      expectedRevision: snapshotAfterFirstTask.revision,
      plan: {
        kind: "task-plan",
        planId: "same-member-review-plan",
        reason: "Exercise a second durable claim attempt against the same frozen MemberRuntime.",
        tasks: [
          ...snapshotAfterFirstTask.definition.tasks,
          { ...firstTaskDefinition, taskId: sameMemberTaskId, name: "Review follow-up requirements", order: 1 },
        ],
        relations: [
          ...snapshotAfterFirstTask.definition.relations,
          {
            kind: "parent-child",
            relationId: `root:${sameMemberTaskId}`,
            parentTaskId: null,
            childTaskId: sameMemberTaskId,
            order: 1,
          },
        ],
      },
      replannedAt: "2026-01-02T00:00:00.000Z",
    }, {})
    const sameMemberInput = {
      ...taskInput,
      taskId: sameMemberTaskId,
      assignmentCommandId: "assign-review-requirements-followup",
      startCommandId: "start-review-requirements-followup",
      settlementCommandId: "settle-review-requirements-followup",
      invocationRef: "invoke-review-requirements-followup",
      claimedAt: "2026-01-02T00:00:01.000Z",
      startedAt: "2026-01-02T00:00:02.000Z",
      settledAt: "2026-01-02T00:00:03.000Z",
      input: { requirements: ["R1-followup"] },
    } as const
    const faultedTaskOwner = activeContext.taskManager.owner as FileTaskSpaceOwner
    const compareAndSwap = faultedTaskOwner.compareAndSwap.bind(faultedTaskOwner)
    let injectedPostAgentCrash = false
    ;(faultedTaskOwner as any).compareAndSwap = async (commit: any) => {
      if (!injectedPostAgentCrash
        && commit.commandId === sameMemberInput.settlementCommandId) {
        injectedPostAgentCrash = true
        throw new Error("INJECTED_POST_AGENT_PRE_SETTLEMENT_CRASH")
      }
      return compareAndSwap(commit)
    }
    await expect(authoring.processHolonTask(sameMemberInput))
      .rejects.toThrow(/INJECTED_POST_AGENT_PRE_SETTLEMENT_CRASH/)
    expect(providerCalls).toBe(2)
    ;(faultedTaskOwner as any).compareAndSwap = compareAndSwap

    const sameMemberSettled = await new WorkflowRuntimeService(runtime).processHolonTask(sameMemberInput)
    expect(sameMemberSettled.settlementReceipt.status).toBe("Succeeded")
    expect(sameMemberSettled.memberRuntimeRef).toBe(settled.memberRuntimeRef)
    expect(providerCalls).toBe(2)
    expect((await taskOwner.readHistory("review-task-space")).filter((event) => (
      event.kind === "task.settled" && event.taskId === sameMemberInput.taskId
    ))).toHaveLength(1)

    const checkpointAfterSameMemberTasks = await new WorkflowRuntimeService(runtime).depa.checkpointStore.load({
      instanceId: instance.instanceId,
      runId: "holon-ctrl-run",
    }) as any
    const sameMemberInvocations = Object.values(checkpointAfterSameMemberTasks.profile.ai.invocationsByKey) as any[]
    expect(sameMemberInvocations).toHaveLength(2)
    expect(sameMemberInvocations.map(({ mode }) => mode)).toEqual(["new", "new"])
    expect(new Set(sameMemberInvocations.map(({ invocationKey }) => invocationKey)).size).toBe(2)
    expect(new Set(sameMemberInvocations.map(({ metadata }) => metadata.memberRuntimeRef)).size).toBe(1)
    const sameMemberInstances = Object.values(checkpointAfterSameMemberTasks.profile.ai.instancesById) as any[]
    expect(sameMemberInstances).toHaveLength(2)
    expect(new Set(sameMemberInstances.map(({ instanceId }) => instanceId)).size).toBe(2)
    expect(new Set(sameMemberInstances.map(({ sessionId }) => sessionId)).size).toBe(2)
    expect(new Set(sameMemberInstances.map(({ metadata }) => metadata.actorKey)).size).toBe(2)
    const sameMemberHistories = sameMemberInstances.map(({ metadata }) => (
      materializeConversationHistoryMessagesFromVm({ vm: runtime.vm, actorKey: metadata.actorKey })
        .map((message) => String(message.content))
        .join("\n")
    ))
    expect(sameMemberHistories.some((history) => (
      history.includes('"R1"') && !history.includes('"R1-followup"')
    ))).toBe(true)
    expect(sameMemberHistories.some((history) => (
      history.includes('"R1-followup"') && !history.includes('"R1"')
    ))).toBe(true)

    const oldSnapshotReceipt = (await taskOwner.readSnapshot("review-task-space"))
      ?.tasks[0]?.profile.facts.snapshotReceipt
    expect(oldSnapshotReceipt).toBeDefined()
    expect(oldSnapshotReceipt).toMatchObject({
      holonSnapshotRef: initialIssuerEvidence.provenance.snapshotRef,
      holonSnapshotDigest: initialIssuerEvidence.digests.snapshotTree,
      snapshotArtifactDigest: initialIssuerEvidence.digests.snapshotBytes,
      issuerReceiptId: initialIssuerEvidence.digests.issuanceReceiptBytes,
      issuerReceiptArtifactDigest: initialIssuerEvidence.digests.issuanceReceiptBytes,
    })
    const instanceBeforeReplan = await new WorkflowRuntimeService(runtime).getInstance(instance.instanceId)
    await writeHolonPackage({
      principalKind: "ai",
      withWorkflow: true,
      rootDir: liveRoot,
      effectiveAt: "2026-02-01T00:00:00.000Z",
    })
    const replannedIssuerEvidence = issuerEvidenceByPackageRoot.get(liveRoot)!
    const replanned = await new WorkflowRuntimeService(runtime).replanHolonTask({
      runId: "holon-ctrl-run",
      nodeId: "open-task",
      taskSpaceId: "review-task-space",
      previousTaskId: sameMemberTaskId,
      successorTaskId: "review-requirements-v2",
      successorTaskName: "Review requirements with organization revision 2",
      successorEffectiveAt: "2026-02-01T00:00:00.000Z",
      cancelCommandId: "cancel-review-requirements-for-replan",
      replanCommandId: "replan-review-requirements-v2",
      planId: "review-plan-v2",
      replannedAt: "2026-02-01T00:00:01.000Z",
    })
    expect(replanned).toMatchObject({ replayed: false })
    expect(replanned.adoptionReceipt).toMatchObject({
      previousTaskId: sameMemberTaskId,
      successorTaskId: "review-requirements-v2",
      previousIssuerReceiptId: oldSnapshotReceipt!.issuerReceiptId,
    })
    expect(replanned.successorSnapshotReceipt).toMatchObject({
      effectiveAt: "2026-02-01T00:00:00.000Z",
      executionBindingRef: "resource://eidolon.fixture.binding.ai",
      holonSnapshotRef: replannedIssuerEvidence.provenance.snapshotRef,
      holonSnapshotDigest: replannedIssuerEvidence.digests.snapshotTree,
      snapshotArtifactDigest: replannedIssuerEvidence.digests.snapshotBytes,
      issuerReceiptId: replannedIssuerEvidence.digests.issuanceReceiptBytes,
      issuerReceiptArtifactDigest: replannedIssuerEvidence.digests.issuanceReceiptBytes,
    })
    expect(replannedIssuerEvidence.provenance).toMatchObject({
      sourceAuthorityId: initialIssuerEvidence.provenance.sourceAuthorityId,
      sourceRevision: String(initialIssuerEvidence.commitReceipt.revision + 1),
    })
    expect(replanned.successorSnapshotReceipt.issuerReceiptId)
      .not.toBe(oldSnapshotReceipt!.issuerReceiptId)
    expect((await new WorkflowRuntimeService(runtime).getInstance(instance.instanceId))?.definitionRevision)
      .toBe(instanceBeforeReplan?.definitionRevision)
    await rm(liveRoot, { recursive: true, force: true })

    const successorInput = {
      ...taskInput,
      taskId: "review-requirements-v2",
      assignmentCommandId: "assign-review-requirements-v2",
      startCommandId: "start-review-requirements-v2",
      settlementCommandId: "settle-review-requirements-v2",
      invocationRef: "invoke-review-requirements-v2",
      claimedAt: "2026-02-01T00:00:02.000Z",
      startedAt: "2026-02-01T00:00:03.000Z",
      settledAt: "2026-02-01T00:00:04.000Z",
      input: { requirements: ["R2"] },
    } as const
    const successorService = new WorkflowRuntimeService(runtime)
    const successorSettled = await successorService.processHolonTask(successorInput)
    expect(successorSettled.settlementReceipt.status).toBe("Succeeded")
    expect(providerCalls).toBe(3)
    const successorDeployment = await loadHolonDeploymentDefinition({ supportRoot: instanceRoot }, {
      deploymentId: successorSettled.deploymentId,
    }, {})
    expect(successorDeployment.bindingProjection.receipt).toMatchObject(
      issuerReceiptProvenance(replannedIssuerEvidence),
    )
    expect(successorDeployment.bindingProjection.snapshot).toEqual(replannedIssuerEvidence.snapshot)
    expect((await taskOwner.readHistory("review-task-space")).filter((event) => (
      event.kind === "task.settled" && event.taskId === successorInput.taskId
    ))).toHaveLength(1)
    expect(JSON.stringify({ replanned, successorSettled }))
      .not.toMatch(new RegExp(`${parent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|prompt|reasoning|conversation|actorHistory|mailbox`, "i"))

    await writeHolonPackage({
      principalKind: "ai",
      withWorkflow: true,
      rootDir: liveRoot,
      effectiveAt: "2026-03-01T00:00:00.000Z",
      workflowEffectiveAt: "2026-03-01T00:00:00.000Z",
    })
    const liveAgentPath = path.join(liveRoot, "Agents", "Reviewer.xnl")
    await writeFile(
      liveAgentPath,
      (await readFile(liveAgentPath, "utf8")).replace('version="1.0.0"', 'version="1.0.1"'),
      "utf8",
    )
    const beforeIncompatible = await taskOwner.readSnapshot("review-task-space")
    await expect(new WorkflowRuntimeService(runtime).replanHolonTask({
      runId: "holon-ctrl-run",
      nodeId: "open-task",
      taskSpaceId: "review-task-space",
      previousTaskId: "review-requirements-v2",
      successorTaskId: "review-requirements-v3",
      successorTaskName: "Review requirements with incompatible executable revision",
      successorEffectiveAt: "2026-03-01T00:00:00.000Z",
      cancelCommandId: "cancel-review-requirements-v3",
      replanCommandId: "replan-review-requirements-v3",
      planId: "review-plan-v3",
      replannedAt: "2026-03-01T00:00:01.000Z",
    })).rejects.toThrow(/SUCCESSOR_INSTANCE_REQUIRED/)
    expect((await taskOwner.readSnapshot("review-task-space"))?.revision).toBe(beforeIncompatible?.revision)

    const successorInstance = await new WorkflowRuntimeService(runtime).createInstance({
      workflowRef: "resource://eidolon.fixture.workflow.coordination",
      instanceId: "holon-ctrl-instance-v3",
      initialInput: { requirements: ["R1"] },
    })
    expect(successorInstance.definitionRevision).not.toBe(instance.definitionRevision)
    const linkedRun = await new WorkflowRuntimeService(runtime).start({
      instanceId: successorInstance.instanceId,
      runId: "holon-ctrl-run-v3",
      replayOf: "holon-ctrl-run",
      confirmed: true,
    })
    expect(linkedRun).toMatchObject({ status: "Waiting" })
    expect((await new WorkflowRuntimeService(runtime).facts.loadDescriptor("holon-ctrl-run-v3"))?.replayOf)
      .toBe("holon-ctrl-run")
    await rm(liveRoot, { recursive: true, force: true })

    const handle = started.open_wait_handles[0]
    const resumed = await new WorkflowRuntimeService(runtime).resume("holon-ctrl-run", {
      signalKind: handle.signalKind,
      signalKey: handle.signalKey,
      resumeToken: handle.resumeToken,
      payload: { settlementReceiptId: settled.settlementReceipt.receiptId },
    })
    expect(resumed).toMatchObject({ status: "Completed" })
    const replayed = await new WorkflowRuntimeService(runtime).processHolonTask(taskInput)
    expect(replayed.settlementReceipt).toEqual(settled.settlementReceipt)
    expect(replayed.replayed).toBe(true)
    expect(providerCalls).toBe(3)

    const taskSnapshot = await taskOwner.readSnapshot("review-task-space")
    expect(taskSnapshot?.tasks.every(({ status }) => status === "Succeeded")).toBe(true)
    expect(taskSnapshot?.tasks.find(({ taskId }) => taskId === taskInput.taskId)
      ?.profile.facts.snapshotReceipt.issuerReceiptId)
      .toBe(oldSnapshotReceipt!.issuerReceiptId)
    expect(taskSnapshot?.tasks.find(({ taskId }) => taskId === sameMemberTaskId)
      ?.profile.facts.snapshotReceipt.issuerReceiptId)
      .toBe(oldSnapshotReceipt!.issuerReceiptId)
    expect(taskSnapshot?.tasks.find(({ taskId }) => taskId === successorInput.taskId)
      ?.profile.facts.snapshotReceipt.issuerReceiptId)
      .toBe(replanned.successorSnapshotReceipt.issuerReceiptId)
    expect(await readdir(path.join(instanceRoot, "holon-deployments"))).toHaveLength(2)
    expect(JSON.stringify(await new WorkflowRuntimeService(runtime).flowSummary("holon-ctrl-run")))
      .not.toContain(parent)
  }, 120_000)

  it("automatically recovers a replanned Data Holon successor and consumes its exact MaterialPort", async () => {
    const liveRoot = await writeHolonPackage({ principalKind: "ai", withWorkflow: true })
    await expectIndependentProductIssuer(liveRoot)
    const issuerEvidence = issuerEvidenceByPackageRoot.get(liveRoot)!
    const parent = await mkdtemp(path.join(os.tmpdir(), "eidolon-holon-data-product-"))
    temporaryRoots.push(parent)
    const component = createWorkflowComponent({
      workspaceRoot: path.join(parent, "workflows"),
      resourceLayers: [{ id: "workspace", rootDir: liveRoot }],
    })
    let providerCalls = 0
    const actor = createActor({
      key: "main",
      id: "holon-data-runtime",
      llmClient: {
        type: "openai",
        async createStream() {
          async function* stream() {}
          return { stream: stream() }
        },
      },
      modelConfig: { model: "mock" },
      callbacks: {
        buildToolset: () => [],
        processStream: async (vm, child) => {
          providerCalls += 1
          const message = {
            role: "assistant" as const,
            content: JSON.stringify({ summary: "data-organization-approved" }),
          }
          appendLiveHistoryMessageToConversationDomainRuntime({
            vm,
            actorKey: child.key,
            actorId: child.id,
            message,
          })
          return message
        },
      },
    })
    const aiWorkflowMetadata = {
      roots: { workspaceRoot: path.join(parent, "workflows") },
      holonAutomaticPump: false,
    }
    const runtime = {
      vm: createVM({
        controlActorKey: actor.key,
        actors: { [actor.key]: actor },
        registries: { toolRegistry: composeToolRegistry(), agentRegistry: new AgentRegistry({}) },
        outerCtx: {
          workDir: parent,
          metadata: {
            sessionDir: path.join(parent, "runtime-session"),
            aiWorkflow: aiWorkflowMetadata,
            resourcePackages: { layers: [{ id: "workspace", rootDir: liveRoot }] },
          },
        },
      }),
      actor,
    } as any
    bindWorkflowComponentToRuntime(runtime, component)
    const instance = await new WorkflowRuntimeService(runtime).createInstance({
      workflowRef: "resource://eidolon.fixture.workflow.data-coordination",
      instanceId: "holon-data-instance",
      initialInput: { requirements: ["D1"] },
    })
    await rm(liveRoot, { recursive: true, force: true })

    const started = await new WorkflowRuntimeService(runtime).start({
      instanceId: instance.instanceId,
      runId: "holon-data-run",
      confirmed: true,
    })
    expect(started).toMatchObject({ status: "Waiting" })
    expect(providerCalls).toBe(0)

    await writeHolonPackage({
      principalKind: "ai",
      withWorkflow: true,
      rootDir: liveRoot,
      effectiveAt: "2026-02-01T00:00:00.000Z",
    })
    const replannedIssuerEvidence = issuerEvidenceByPackageRoot.get(liveRoot)!
    const replanned = await new WorkflowRuntimeService(runtime).replanHolonTask({
      runId: "holon-data-run",
      nodeId: "delegate-task",
      taskSpaceId: "data-review-task-space",
      previousTaskId: "data-review-requirements",
      successorTaskId: "data-review-requirements-v2",
      successorTaskName: "Review Data requirements with organization revision 2",
      successorEffectiveAt: "2026-02-01T00:00:00.000Z",
      cancelCommandId: "cancel-data-review-requirements-for-replan",
      replanCommandId: "replan-data-review-requirements-v2",
      planId: "data-review-plan-v2",
      replannedAt: "2026-02-01T00:00:01.000Z",
    })
    expect(replanned).toMatchObject({
      replayed: false,
      adoptionReceipt: {
        previousTaskId: "data-review-requirements",
        successorTaskId: "data-review-requirements-v2",
      },
      successorSnapshotReceipt: {
        effectiveAt: "2026-02-01T00:00:00.000Z",
        issuerReceiptId: replannedIssuerEvidence.digests.issuanceReceiptBytes,
      },
    })
    await rm(liveRoot, { recursive: true, force: true })

    aiWorkflowMetadata.holonAutomaticPump = true
    const faultedDataService = new WorkflowRuntimeService(runtime, {
      holonEffectFaults: {
        afterResourceAgentResultPersistence: () => {
          throw new Error("INJECTED_DATA_PROVIDER_RESULT_EVIDENCE_CRASH")
        },
      },
    })
    await expect(faultedDataService.continueHolonRun("holon-data-run"))
      .rejects.toThrow(/INJECTED_DATA_PROVIDER_RESULT_EVIDENCE_CRASH/)
    expect(providerCalls).toBe(1)
    const instanceRoot = path.join(
      parent,
      "runtime-session",
      "workflow-runtime",
      "instances",
      instance.instanceId,
    )
    const dataOwner = new FileTaskSpaceOwner({ root: path.join(instanceRoot, "task-spaces") })
    const activeClaim = (await dataOwner.readSnapshot("data-review-task-space"))
      ?.tasks.find(({ taskId }) => taskId === "data-review-requirements-v2")?.activeClaim
    expect(activeClaim).toBeTruthy()
    const dataService = new WorkflowRuntimeService(runtime)
    const completed = await dataService.continueHolonRun(
      "holon-data-run",
      new Date(Date.parse(activeClaim!.expiresAt) + 1).toISOString(),
    )
    expect(completed).toMatchObject({
      status: "Succeeded",
      terminal: true,
      output: { summary: "data-organization-approved" },
    })
    const dataHistory = await dataOwner.readHistory("data-review-task-space")
    const settledEvent = dataHistory.find((event) => (
      event.kind === "task.settled" && event.taskId === "data-review-requirements-v2"
    ))
    expect(settledEvent?.kind).toBe("task.settled")
    if (!settledEvent || settledEvent.kind !== "task.settled") throw new Error("missing successor settlement event")
    expect(settledEvent.outputArtifacts).toHaveLength(1)
    expect(settledEvent.outputArtifacts[0]).toMatchObject({
      name: "resource://eidolon.fixture.port.review-result",
      mediaType: "application/json",
    })
    expect(providerCalls).toBe(1)
    const dataContext = (dataService as any).holonContexts.get("holon-data-run")
    const successorSubscription = (await dataContext.journal.listSubscriptions("holon-data-run"))
      .find(({ taskId }: any) => taskId === "data-review-requirements-v2")
    expect(successorSubscription).toBeTruthy()
    const dataDeployment = await loadHolonDeploymentDefinition({ supportRoot: instanceRoot }, {
      deploymentId: successorSubscription.deploymentId,
    }, {})
    expect(dataDeployment.bindingProjection.receipt).toMatchObject(
      issuerReceiptProvenance(replannedIssuerEvidence),
    )
    expect(issuerEvidence.provenance).toMatchObject({
      issuerPackage: "holarchy-file-xnl-capsule",
      issuerPackageVersion: "0.2.0",
    })
    expect(dataDeployment.bindingProjection.snapshot).toEqual(replannedIssuerEvidence.snapshot)
    expect(dataDeployment.bindingFreezeReceipt.snapshotReceiptDigest)
      .toBe(replannedIssuerEvidence.digests.issuanceReceiptBytes)
    const dataTaskSnapshot = await dataOwner.readSnapshot("data-review-task-space")
    expect(dataTaskSnapshot.tasks.map(({ status }) => status)).toEqual(["Cancelled", "Succeeded"])
    expect(dataTaskSnapshot.tasks[1].profile.facts.snapshotReceipt).toMatchObject({
      holonSnapshotRef: replannedIssuerEvidence.provenance.snapshotRef,
      holonSnapshotDigest: replannedIssuerEvidence.digests.snapshotTree,
      snapshotArtifactDigest: replannedIssuerEvidence.digests.snapshotBytes,
      issuerReceiptId: replannedIssuerEvidence.digests.issuanceReceiptBytes,
      issuerReceiptArtifactDigest: replannedIssuerEvidence.digests.issuanceReceiptBytes,
    })

    const replayed = await new WorkflowRuntimeService(runtime).continueHolonRun("holon-data-run")
    expect(replayed).toMatchObject({
      status: "Succeeded",
      terminal: true,
      output: { summary: "data-organization-approved" },
    })
    expect(providerCalls).toBe(1)

    const checkpoint = await new WorkflowRuntimeService(runtime).depa.checkpointStore.load({
      instanceId: instance.instanceId,
      runId: "holon-data-run",
    })
    expect(checkpoint).toMatchObject({
      profile: { kind: "AIDataWorkflow" },
      output: { summary: "data-organization-approved" },
    })
    expect(JSON.stringify(await new WorkflowRuntimeService(runtime).flowSummary("holon-data-run")))
      .not.toContain(parent)
  })
})

async function directoryTree(root: string): Promise<unknown> {
  const entries = await readdir(root, { withFileTypes: true })
  return Promise.all(entries
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    .map(async (entry) => entry.isDirectory()
      ? { name: entry.name, children: await directoryTree(path.join(root, entry.name)) }
      : { name: entry.name }))
}
