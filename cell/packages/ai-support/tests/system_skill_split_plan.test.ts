import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

import { loadAIWorkflowFlowDslReferenceModule } from "ai-workflow-flow-dsl-reference"

import {
  EXPECTED_EIDOLON_SYSTEM_SKILL_SET,
  loadEidolonSystemSkillDistributionPlan,
} from "../src/system-skill/GeneratedEidolonSystemSkillPlan"

const supportRoot = path.resolve(import.meta.dir, "..")
const sourceRoot = path.join(supportRoot, "src", "system-skill")

describe("Eidolon Anchor system Skill split plan", () => {
  test("pins the two published authoring modules exactly", async () => {
    const manifest = JSON.parse(await readFile(path.join(supportRoot, "package.json"), "utf8"))
    expect(manifest.dependencies["halfcode-compiler.xnl"]).toBe("0.2.3")
    expect(manifest.dependencies["ai-workflow-flow-dsl-reference"]).toBe("0.1.6")
  })

  test("uses a generated complete plan instead of a builtin-plus-plan merge", async () => {
    const installer = await readFile(path.join(sourceRoot, "SystemSkillInstaller.ts"), "utf8")
    expect(await Bun.file(path.join(sourceRoot, "GeneratedEidolonSystemSkillPlan.ts")).exists()).toBe(true)
    expect(installer).toContain("loadEidolonSystemSkillDistributionPlan")
    expect(installer).not.toContain("BUNDLED_SYSTEM_SKILLS")
    expect(installer).not.toContain("loadHalfcodeResourceDslSystemSkillPlan")
  })

  test("retires the monolith and manually copied Flow DSL source", async () => {
    expect(await Bun.file(path.join(sourceRoot, "BundledSystemSkillCatalog.ts")).exists()).toBe(false)
    expect(await Bun.file(path.join(sourceRoot, "assets", "sys-ai-workflow")).exists()).toBe(false)
    expect(await Bun.file(path.join(sourceRoot, "resource-package", "manifest.xnl")).exists()).toBe(true)
  })

  test("does not retain another system Skill identity descriptor", async () => {
    const packageRoot = path.join(sourceRoot, "resource-package")
    const sources = await Promise.all([
      "manifest.xnl",
      "SkillCapsules/DevOps/manifest.xnl",
      "SkillCapsules/Authoring/manifest.xnl",
      "SkillCapsules/Run/manifest.xnl",
    ].map((relativePath) => readFile(path.join(packageRoot, relativePath), "utf8")))
    expect(sources.join("\n")).not.toContain("system-skill.xnl")
    expect(sources[1]).toContain("Eidolon.Anchor.Skill.DevOps")
    expect(sources[2]).toContain("Eidolon.Anchor.Skill.Authoring")
    expect(sources[3]).toContain("Eidolon.Anchor.Skill.Run")
  })

  test("projects the exact DevOps-rooted dependency closure", () => {
    const plan = loadEidolonSystemSkillDistributionPlan()
    expect(plan.roots.map((identity) => identity.fqn)).toEqual(["Eidolon.Anchor.Skill.DevOps"])
    expect(plan.topology).toEqual([
      "Eidolon.Anchor.Skill.Run",
      "Halfcode.ResourceDsl.Skill.System",
      "Eidolon.Anchor.Skill.Authoring",
      "Eidolon.Anchor.Skill.DevOps",
    ])
    expect(plan.capsules).toHaveLength(4)
    expect(Object.fromEntries(plan.capsules.map((capsule) => [
      capsule.identity.fqn,
      capsule.dependencies.map((dependency) => `${dependency.fqn}@${dependency.version}`),
    ]))).toEqual({
      "Eidolon.Anchor.Skill.Run": [],
      "Halfcode.ResourceDsl.Skill.System": [],
      "Eidolon.Anchor.Skill.Authoring": ["Halfcode.ResourceDsl.Skill.System@1.0.0"],
      "Eidolon.Anchor.Skill.DevOps": [
        "Eidolon.Anchor.Skill.Authoring@1.0.25",
        "Eidolon.Anchor.Skill.Run@1.0.5",
      ],
    })
    expect(EXPECTED_EIDOLON_SYSTEM_SKILL_SET.map((entry) => entry.capsuleFqn)).toEqual(plan.topology)
  })

  test("copies every published Flow DSL byte and provenance fact into Authoring", async () => {
    const plan = loadEidolonSystemSkillDistributionPlan()
    const module = loadAIWorkflowFlowDslReferenceModule()
    const provenancePath = path.join(module.resourceRootDir, "content", ".depa-flow-dsl-provenance.json")
    const provenanceBytes = new Uint8Array(await readFile(provenancePath))
    const provenance = JSON.parse(new TextDecoder().decode(provenanceBytes)) as {
      packageName: string
      packageVersion: string
      files: readonly { path: string; contentDigest: string }[]
    }
    expect(provenance.packageName).toBe("ai-workflow-flow-dsl-reference")
    expect(provenance.packageVersion).toBe("0.1.6")
    expect(provenance.files).toHaveLength(31)
    expect(provenance.files.map((file) => file.path)).toContain("spec/flow-core/instance-run.md")

    for (const source of [
      { path: ".depa-flow-dsl-provenance.json", bytes: provenanceBytes },
      ...await Promise.all(provenance.files.map(async (file) => ({
        path: file.path,
        bytes: new Uint8Array(await readFile(path.join(module.resourceRootDir, "content", file.path))),
      }))),
    ]) {
      const target = `sys-eidolon-anchor-authoring/references/flow-dsl/${source.path}`
      const planned = plan.files.find((file) => file.targetRelativePath === target)
      expect(planned, target).toBeDefined()
      expect(planned?.content).toEqual(source.bytes)
    }
  })

  test("hydrates immutable standalone plan bytes defensively", () => {
    const plan = loadEidolonSystemSkillDistributionPlan()
    const file = plan.files.find((entry) => entry.targetRelativePath.endsWith("/SKILL.md"))!
    const first = file.content
    const second = file.content
    expect(first).not.toBe(second)
    expect(first).toEqual(second)
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.capsules)).toBe(true)
  })

  test("separates DevOps stages from Authoring and Run operations", async () => {
    const plan = loadEidolonSystemSkillDistributionPlan()
    const filesFor = (fqn: string) => plan.files
      .filter((file) => file.skillFqn === fqn)
      .map((file) => file.capsuleRelativePath)

    const devops = filesFor("Eidolon.Anchor.Skill.DevOps")
    for (const stage of [
      "planning",
      "coding",
      "building",
      "testing",
      "releasing",
      "deploying",
      "operating",
      "monitoring",
      "improving",
    ]) {
      expect(devops).toContain(`${stage}/system.md`)
      expect(devops).toContain(`${stage}/protocol.md`)
    }

    const authoring = filesFor("Eidolon.Anchor.Skill.Authoring")
    expect(authoring).toContain("operations/index.md")
    expect(authoring).toContain("operations/create-open.md")
    expect(authoring).toContain("operations/open-resource-package.md")
    expect(authoring).toContain("operations/create-resource-package.md")
    expect(authoring).toContain("operations/legacy-vfs-workflow.md")
    expect(authoring).toContain("operations/inspect.md")
    expect(authoring).toContain("operations/batch-patch.md")
    expect(authoring).toContain("operations/validate-prepare.md")
    expect(authoring).toContain("operations/publish.md")
    expect(authoring).toContain("operations/step-space.md")
    const module = loadAIWorkflowFlowDslReferenceModule()
    const provenance = JSON.parse(await Bun.file(path.join(
      module.resourceRootDir,
      "content",
      ".depa-flow-dsl-provenance.json",
    )).text()) as { files: readonly unknown[] }
    expect(authoring.filter((file) => file.startsWith("references/flow-dsl/")))
      .toHaveLength(provenance.files.length + 1)

    const run = filesFor("Eidolon.Anchor.Skill.Run")
    expect(run).toContain("operations/index.md")
    expect(run).toContain("operations/resolve-entrypoint.md")
    expect(run).toContain("operations/instance-binding.md")
    expect(run).toContain("operations/start.md")
    expect(run).toContain("operations/resume-waits.md")
    expect(run).toContain("operations/observe.md")
    expect(run).toContain("operations/replay-evidence.md")
    expect(run).toContain("operations/step-extension.md")

    expect(plan.files.some((file) => file.capsuleRelativePath.startsWith("actions/"))).toBe(false)
    expect(plan.files.some((file) => file.capsuleRelativePath === "system-skill.xnl")).toBe(false)
  })

  test("keeps sibling delegation exact and initial coding context progressive", () => {
    const plan = loadEidolonSystemSkillDistributionPlan()
    const read = (targetRelativePath: string) => {
      const file = plan.files.find((candidate) => candidate.targetRelativePath === targetRelativePath)
      expect(file, targetRelativePath).toBeDefined()
      return new TextDecoder().decode(file!.content)
    }

    const coding = [
      read("sys-eidolon-anchor-devops/coding/system.md"),
      read("sys-eidolon-anchor-devops/coding/protocol.md"),
    ].join("\n")
    expect(coding).toContain("already contains the Authoring root")
    expect(coding).toContain("do not load either again")
    expect(coding).toContain("first post-stage provider completion")
    expect(coding).toContain("WorkflowOpenAuthoringSession")
    expect(coding).toContain("WorkflowCreateResourcePackageSession")
    expect(coding).not.toContain("L1 foundation")
    expect(coding).not.toContain("AICtrlWorkflow")
    expect(coding).not.toContain("AIDataWorkflow")

    const devopsRoot = read("sys-eidolon-anchor-devops/SKILL.md")
    expect(devopsRoot).toContain("first execution with no exact instance fact")
    expect(devopsRoot).toContain("select `deploying`")
    expect(devopsRoot).toContain("Select `operating` only when an exact instance or run identity already exists")
    expect(devopsRoot).toContain("Do not load either again")

    for (const stage of ["deploying", "operating", "monitoring"]) {
      const content = [
        read(`sys-eidolon-anchor-devops/${stage}/system.md`),
        read(`sys-eidolon-anchor-devops/${stage}/protocol.md`),
      ].join("\n")
      expect(content).toContain("already contains the Run Skill root and operation index")
    }
    const deploying = read("sys-eidolon-anchor-devops/deploying/protocol.md")
    expect(deploying).toContain("do not return a final response from `deploying`")
    expect(deploying).toContain('WorkflowLoadStageContext({ stage: "operating" })')
    expect(deploying).toContain("exact instance receipt")

    const authoring = read("sys-eidolon-anchor-authoring/operations/index.md")
    expect(authoring).toContain("open-resource-package.md")
    expect(authoring).toContain("create-resource-package.md")
    expect(authoring).toContain("open -> bounded inspect -> batch patch -> validate/prepare")
    expect(authoring).toContain("one generic `Skill` call with `resources:")
    expect(authoring).toContain('"operations/batch-patch.md", "operations/validate-prepare.md", "operations/agent-definition.md"')
    expect(authoring).toContain("WorkflowPreparePublication")
    expect(authoring).toContain("WorkflowPublishAuthoringSession")
    expect(authoring).toContain("publication authorization")
    expect(authoring).not.toContain("implement the parser")
    expect(read("sys-eidolon-anchor-authoring/operations/legacy-vfs-workflow.md"))
      .toContain("WorkflowCreateBundle")

    const openResourcePackage = read("sys-eidolon-anchor-authoring/operations/open-resource-package.md")
    expect(openResourcePackage).toContain("same deterministic receipt")
    expect(openResourcePackage).toContain("effective KindDefinition documents")
    expect(openResourcePackage).toContain("do not call workspace `describe`, `tree`, or `read_selection`")
    expect(openResourcePackage).toContain("do not search or read those KindDefinition paths again")
    expect(openResourcePackage).toContain("Do not call read on /work")

    const createResourcePackage = read("sys-eidolon-anchor-authoring/operations/create-resource-package.md")
    expect(createResourcePackage).toContain("WorkflowCreateResourcePackageSession")
    expect(createResourcePackage).toContain("complete valid ResourcePackage file set")
    expect(createResourcePackage).toContain("does not synthesize KindDefinitions")

    const inspect = read("sys-eidolon-anchor-authoring/operations/inspect.md")
    expect(inspect).toContain("standalone `read_selection` operation is a recovery fallback")
    expect(inspect).toContain("next provider completion")

    const batchPatch = read("sys-eidolon-anchor-authoring/operations/batch-patch.md")
    expect(batchPatch).toContain('"kind": "add|update|delete"')
    expect(batchPatch).not.toContain('"op": "add|update|delete"')

    const agentDefinition = read("sys-eidolon-anchor-authoring/operations/agent-definition.md")
    expect(agentDefinition).toContain("runtime.ai.effects.runAgent(input, config)")
    expect(agentDefinition).toContain("runtime.ai.effects.runTargetedAgent(selector, invocation, config)")
    expect(agentDefinition).toContain("{ byInstanceName: \"requirements-reviewer\" }")
    expect(agentDefinition).toContain("{ byInstanceId: previous.instance.instanceId }")
    expect(agentDefinition).not.toContain('operation: "ai.agent"')
    expect(agentDefinition).not.toContain("runtime.ai.effects.invoke")

    const agentExecution = read("sys-eidolon-anchor-run/operations/agent-execution.md")
    expect(agentExecution).toContain("different invocation keys")
    expect(agentExecution).toContain("same generic runtime-owned actor/session")
    expect(agentExecution).toContain("profile.ai")
    expect(agentExecution).toContain("byInstanceName")
    expect(agentExecution).toContain("byInstanceId")
    expect(agentExecution).toContain("do not depend on child conversation history")
    expect(agentDefinition).toContain("fn(runtime, input, config)")
    expect(agentDefinition).toContain("export async function runAgent")
    expect(agentDefinition).toContain("<Content ?>Return only JSON.</?>")
    expect(agentDefinition).toContain("a `content` property is metadata")
    expect(agentDefinition).toContain("an indirect phrase such as \"matching the output schema\" is insufficient")
    expect(agentDefinition).not.toContain("function invokeAgent(input")
    expect(agentDefinition).toContain("validates the rendered Prompt content")
    expect(agentDefinition).toContain("do not reuse an object-valued Agent input schema")
    expect(agentDefinition).toContain("must explicitly state the exact required fields")
    expect(agentDefinition).toContain("invocation.payload")
    expect(agentDefinition).toContain("this exact object satisfies the Agent `InputSchemaRef`")

    const run = read("sys-eidolon-anchor-run/operations/index.md")
    expect(run).toContain("WorkflowRun")
    expect(run).toContain("WorkflowResume")
    expect(run).toContain("WorkflowResolve")
    expect(run).toContain("WorkflowReject")
    expect(run).toContain("WorkflowResult")
    expect(run).not.toContain("WorkflowCancel")
    expect(run).toContain('resources: ["operations/resolve-entrypoint.md", "operations/instance-binding.md", "operations/start.md", "operations/agent-execution.md"]')
  })
})
