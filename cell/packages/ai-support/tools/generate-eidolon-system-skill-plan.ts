import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import { loadAIWorkflowFlowDslReferenceModule } from "ai-workflow-flow-dsl-reference"
import {
  loadHalfcodeResourceDslSystemSkillModule,
  planSkillCapsuleDistribution,
  resolveApplicationAssembly,
  skillCapsuleDistributionProjection,
} from "halfcode-compiler.xnl"

import { EIDOLON_ANCHOR_SYSTEM_SKILL_MODULE } from "../src/system-skill/EidolonAnchorSystemSkillModule"

const generatedPath = path.resolve(
  import.meta.dir,
  "../src/system-skill/GeneratedEidolonSystemSkillPlan.ts",
)

const expectedTopology = [
  "Eidolon.Anchor.Skill.Run",
  "Halfcode.ResourceDsl.Skill.System",
  "Eidolon.Anchor.Skill.Authoring",
  "Eidolon.Anchor.Skill.DevOps",
] as const

const expectedDevOpsStages = [
  "planning",
  "coding",
  "building",
  "testing",
  "releasing",
  "deploying",
  "operating",
  "monitoring",
  "improving",
] as const

const expectedAuthoringOperations = [
  "operations/index.md",
  "operations/create-open.md",
  "operations/open-resource-package.md",
  "operations/create-resource-package.md",
  "operations/legacy-vfs-workflow.md",
  "operations/inspect.md",
  "operations/batch-patch.md",
  "operations/validate-prepare.md",
  "operations/publish.md",
  "operations/agent-definition.md",
] as const

const expectedRunOperations = [
  "operations/index.md",
  "operations/resolve-entrypoint.md",
  "operations/instance-binding.md",
  "operations/start.md",
  "operations/resume-waits.md",
  "operations/observe.md",
  "operations/replay-evidence.md",
  "operations/agent-execution.md",
] as const

const flowDslReferenceModule = loadAIWorkflowFlowDslReferenceModule()
const flowDslProvenance = JSON.parse(await readFile(
  path.join(flowDslReferenceModule.resourceRootDir, "content", ".depa-flow-dsl-provenance.json"),
  "utf8",
)) as {
  readonly packageName: string
  readonly packageVersion: string
  readonly files: readonly { readonly path: string; readonly contentDigest: string }[]
}

const modules = [
  loadHalfcodeResourceDslSystemSkillModule(),
  flowDslReferenceModule,
  EIDOLON_ANCHOR_SYSTEM_SKILL_MODULE,
] as const

const assembly = await resolveApplicationAssembly({ modules, portBindings: [] })
const plan = await planSkillCapsuleDistribution({
  assembly,
  rootSkillFqns: ["Eidolon.Anchor.Skill.DevOps"],
})

assertCanonicalPlan()

const projection = skillCapsuleDistributionProjection(plan)
const generatedSource = renderGeneratedModule(projection)

if (Bun.argv.includes("--check")) {
  let current = ""
  try {
    current = await readFile(generatedPath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  if (current !== generatedSource) {
    throw new Error("EIDOLON_SYSTEM_SKILL_PLAN_STALE: run `bun run generate:system-skills`")
  }
} else {
  await writeFile(generatedPath, generatedSource, "utf8")
}

console.log(JSON.stringify({
  generatedPath,
  roots: plan.roots.map((identity) => identity.fqn),
  topology: plan.topology,
  files: plan.files.length,
  closureDigest: plan.closureDigest,
}))

function assertCanonicalPlan(): void {
  if (plan.roots.length !== 1 || plan.roots[0]?.fqn !== "Eidolon.Anchor.Skill.DevOps") {
    throw new Error("EIDOLON_SYSTEM_SKILL_PLAN_INVALID: DevOps must be the only plan root")
  }
  if (JSON.stringify(plan.topology) !== JSON.stringify(expectedTopology)) {
    throw new Error(`EIDOLON_SYSTEM_SKILL_PLAN_INVALID: unexpected topology ${JSON.stringify(plan.topology)}`)
  }
  const expectedVersions: Readonly<Record<string, string>> = {
    "Halfcode.ResourceDsl.Skill.System": "1.0.0",
    "Eidolon.Anchor.Skill.Run": "1.0.5",
    "Eidolon.Anchor.Skill.Authoring": "1.0.25",
    "Eidolon.Anchor.Skill.DevOps": "1.0.29",
  }
  for (const capsule of plan.capsules) {
    if (capsule.identity.version !== expectedVersions[capsule.identity.fqn]) {
      throw new Error(`EIDOLON_SYSTEM_SKILL_PLAN_INVALID: unexpected version for ${capsule.identity.fqn}`)
    }
  }
  const dependencyProjection = new Map(plan.capsules.map((capsule) => [
    capsule.identity.fqn,
    capsule.dependencies.map((dependency) => `${dependency.fqn}@${dependency.version}`),
  ]))
  const expectedDependencies: Readonly<Record<string, readonly string[]>> = {
    "Halfcode.ResourceDsl.Skill.System": [],
    "Eidolon.Anchor.Skill.Authoring": ["Halfcode.ResourceDsl.Skill.System@1.0.0"],
    "Eidolon.Anchor.Skill.Run": [],
    "Eidolon.Anchor.Skill.DevOps": [
      "Eidolon.Anchor.Skill.Authoring@1.0.25",
      "Eidolon.Anchor.Skill.Run@1.0.5",
    ],
  }
  for (const [fqn, dependencies] of Object.entries(expectedDependencies)) {
    if (JSON.stringify(dependencyProjection.get(fqn)) !== JSON.stringify(dependencies)) {
      throw new Error(`EIDOLON_SYSTEM_SKILL_PLAN_INVALID: unexpected dependencies for ${fqn}: ${JSON.stringify(dependencyProjection.get(fqn))}`)
    }
  }
  const authoringTargets = plan.files
    .filter((file) => file.skillFqn === "Eidolon.Anchor.Skill.Authoring")
    .map((file) => file.capsuleRelativePath)
  const flowTargets = authoringTargets.filter((target) => target.startsWith("references/flow-dsl/"))
  const expectedFlowTargets = [
    "references/flow-dsl/.depa-flow-dsl-provenance.json",
    ...flowDslProvenance.files.map((file) => `references/flow-dsl/${file.path}`),
  ].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  const actualFlowTargets = [...flowTargets].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  if (flowDslProvenance.packageName !== "ai-workflow-flow-dsl-reference"
    || flowDslProvenance.packageVersion !== "0.1.6"
    || JSON.stringify(actualFlowTargets) !== JSON.stringify(expectedFlowTargets)) {
    throw new Error("EIDOLON_SYSTEM_SKILL_PLAN_INVALID: Flow DSL targets differ from the published module provenance")
  }
  for (const operation of expectedAuthoringOperations) {
    if (!authoringTargets.includes(operation)) {
      throw new Error(`EIDOLON_SYSTEM_SKILL_PLAN_INVALID: Authoring ${operation} is missing`)
    }
  }
  const runTargets = plan.files
    .filter((file) => file.skillFqn === "Eidolon.Anchor.Skill.Run")
    .map((file) => file.capsuleRelativePath)
  for (const operation of expectedRunOperations) {
    if (!runTargets.includes(operation)) {
      throw new Error(`EIDOLON_SYSTEM_SKILL_PLAN_INVALID: Run ${operation} is missing`)
    }
  }
  const devOpsTargets = plan.files
    .filter((file) => file.skillFqn === "Eidolon.Anchor.Skill.DevOps")
    .map((file) => file.capsuleRelativePath)
  for (const stage of expectedDevOpsStages) {
    for (const file of ["system.md", "protocol.md"]) {
      if (!devOpsTargets.includes(`${stage}/${file}`)) {
        throw new Error(`EIDOLON_SYSTEM_SKILL_PLAN_INVALID: DevOps ${stage}/${file} is missing`)
      }
    }
  }
  if (plan.files.some((file) => file.capsuleRelativePath === "system-skill.xnl")) {
    throw new Error("EIDOLON_SYSTEM_SKILL_PLAN_INVALID: system-skill.xnl is not a canonical payload")
  }
  if (plan.files.some((file) => file.capsuleRelativePath.startsWith("actions/"))) {
    throw new Error("EIDOLON_SYSTEM_SKILL_PLAN_INVALID: actions is not a canonical operation directory")
  }
}

function renderGeneratedModule(projection: ReturnType<typeof skillCapsuleDistributionProjection>): string {
  return [
    "// Generated by tools/generate-eidolon-system-skill-plan.ts. Do not edit.",
    'import type { SkillCapsuleDistributionPlan } from "halfcode-compiler.xnl"',
    "",
    `const projection = ${JSON.stringify(projection, null, 2)} as const`,
    "",
    "function hydrateFile(file: (typeof projection.capsules)[number][\"files\"][number]) {",
    "  const contentBase64 = file.contentBase64",
    "  return {",
    "    ...file,",
    "    get content(): Uint8Array { return new Uint8Array(Buffer.from(contentBase64, \"base64\")) },",
    "  }",
    "}",
    "",
    "const capsules = projection.capsules.map((capsule) => ({",
    "  ...capsule,",
    "  files: capsule.files.map(hydrateFile),",
    "}))",
    "const plan = {",
    "  ...projection,",
    "  capsules,",
    "  files: capsules.flatMap((capsule) => capsule.files)",
    "    .sort((left, right) => left.targetRelativePath < right.targetRelativePath ? -1 : left.targetRelativePath > right.targetRelativePath ? 1 : 0),",
    "} as unknown as SkillCapsuleDistributionPlan",
    "",
    "deepFreeze(plan)",
    "",
    "export type ExpectedManagedSystemSkill = {",
    "  readonly name: string",
    "  readonly version: string",
    "  readonly capsuleFqn: string",
    "  readonly apiVersion: string",
    "  readonly closureDigest: string",
    "  readonly files: readonly { readonly path: string; readonly digest: string }[]",
    "}",
    "",
    "export const EXPECTED_EIDOLON_SYSTEM_SKILL_SET: readonly ExpectedManagedSystemSkill[] = Object.freeze(",
    "  plan.capsules.map((capsule) => Object.freeze({",
    "    name: capsule.identity.name,",
    "    version: capsule.identity.version,",
    "    capsuleFqn: capsule.identity.fqn,",
    "    apiVersion: capsule.identity.apiVersion,",
    "    closureDigest: plan.closureDigest,",
    "    files: Object.freeze(capsule.files.map((file) => Object.freeze({",
    "      path: file.capsuleRelativePath,",
    "      digest: file.contentDigest,",
    "    }))),",
    "  })),",
    ")",
    "",
    "export function loadEidolonSystemSkillDistributionPlan(): SkillCapsuleDistributionPlan {",
    "  return plan",
    "}",
    "",
    "function deepFreeze(value: unknown): unknown {",
    "  if (!value || typeof value !== \"object\" || Object.isFrozen(value)) return value",
    "  if (ArrayBuffer.isView(value)) return value",
    "  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {",
    "    if (Object.prototype.hasOwnProperty.call(descriptor, \"value\")) deepFreeze(descriptor.value)",
    "  }",
    "  return Object.freeze(value)",
    "}",
    "",
  ].join("\n")
}
