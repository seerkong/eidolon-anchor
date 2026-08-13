import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  installBundledSystemSkills,
  loadAiWorkflowStageContext,
  loadSkillEntriesWithSystemAuthority,
  resolveEidolonGlobalRootFromOuterContext,
} from "../src/system-skill/SystemSkillInstaller"
import { BUNDLED_SYSTEM_SKILLS } from "../src/system-skill/BundledSystemSkillCatalog"

describe("bundled system skills", () => {
  test("keeps sys-ai-workflow on the 1.0 patch-version line", () => {
    const skill = BUNDLED_SYSTEM_SKILLS.find((entry) => entry.name === "sys-ai-workflow")
    expect(skill?.version).toMatch(/^1\.0\.\d+$/)
    expect(skill?.files["SKILL.md"]).toContain(`version: ${skill?.version}`)
    expect(skill?.files["system-skill.xnl"]).toContain(`version="${skill?.version}"`)
  })

  test("resolves system skills from the Eidolon authority root, not the global workflow resource root", () => {
    expect(resolveEidolonGlobalRootFromOuterContext({
      metadata: {
        local_permissions: { authority_root: "/authority/.eidolon" },
        aiWorkflow: { roots: { globalRoot: "/authority/.eidolon/workflows" } },
      },
    })).toBe("/authority/.eidolon")
  })

  test("atomically replaces managed system skills and preserves user skills", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-global-"))
    const userSkill = path.join(globalRoot, "skills", "my-skill")
    const staleSystemSkill = path.join(globalRoot, "skills", "sys-ai-workflow")
    await mkdir(userSkill, { recursive: true })
    await mkdir(staleSystemSkill, { recursive: true })
    await writeFile(path.join(userSkill, "SKILL.md"), "user-owned")
    await writeFile(path.join(staleSystemSkill, "stale.txt"), "stale")

    const first = await installBundledSystemSkills({ globalRoot })
    const second = await installBundledSystemSkills({ globalRoot })

    expect(first.installed).toEqual(["sys-ai-workflow"])
    expect(second.installed).toEqual(["sys-ai-workflow"])
    expect(await readFile(path.join(userSkill, "SKILL.md"), "utf8")).toBe("user-owned")
    expect(await Bun.file(path.join(staleSystemSkill, "stale.txt")).exists()).toBe(false)
    expect(await Bun.file(path.join(globalRoot, "skills", ".system-skills.xnl")).exists()).toBe(true)
  })

  test("installs the DevOps lifecycle and visible coding flow-dsl skeleton", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-global-"))
    await installBundledSystemSkills({ globalRoot })
    const root = path.join(globalRoot, "skills", "sys-ai-workflow")

    for (const stage of [
      "planning", "coding", "building", "testing",
      "releasing", "deploying", "operating", "monitoring",
    ]) {
      expect(await Bun.file(path.join(root, stage, "system.md")).exists()).toBe(true)
      expect(await Bun.file(path.join(root, stage, "protocol.md")).exists()).toBe(true)
    }
    for (const relative of [
      "coding/flow-dsl/foundation/depa-axioms.md",
      "coding/flow-dsl/std/eager-data-flow/axioms.md",
      "coding/flow-dsl/std/work-ctrl-flow/axioms.md",
      "coding/flow-dsl/spec/flow-core/nodes.md",
      "coding/flow-dsl/spec/ai-workflow/resources.md",
      "coding/flow-dsl/spec/ai-workflow/data-workflow.md",
      "coding/flow-dsl/spec/ai-workflow/ctrl-workflow.md",
    ]) {
      expect(await Bun.file(path.join(root, relative)).exists()).toBe(true)
    }
  })

  test("resolves global sys identities without allowing workspace shadowing", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-global-"))
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-workspace-"))
    await installBundledSystemSkills({ globalRoot })
    const shadow = path.join(workspaceRoot, ".eidolon", "skills", "sys-ai-workflow")
    await mkdir(shadow, { recursive: true })
    await writeFile(path.join(shadow, "SKILL.md"), [
      "---", "name: sys-ai-workflow", "description: shadow", "---", "shadow body",
    ].join("\n"))

    const entries = loadSkillEntriesWithSystemAuthority({ globalRoot, workspaceRoot })
    expect(entries["sys-ai-workflow"]?.body).not.toContain("shadow body")
    expect(entries["sys-ai-workflow"]?.dir).toBe(path.join(globalRoot, "skills", "sys-ai-workflow"))
  })

  test("reports a canonical version conflict instead of using an incompatible system skill", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-global-"))
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-workspace-"))
    await installBundledSystemSkills({ globalRoot })
    await writeFile(
      path.join(globalRoot, "skills", "sys-ai-workflow", "system-skill.xnl"),
      '<SystemSkill><Identity name="sys-ai-workflow" version="0.0.0"/></SystemSkill>',
    )

    expect(() => loadSkillEntriesWithSystemAuthority({
      globalRoot,
      workspaceRoot,
      requireSystemSkills: true,
    })).toThrow("version conflicts")
  })

  test("progressively discloses the generation kernel only for coding", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-global-"))
    await installBundledSystemSkills({ globalRoot })

    const planning = await loadAiWorkflowStageContext({ globalRoot, stage: "planning" })
    const coding = await loadAiWorkflowStageContext({ globalRoot, stage: "coding" })
    const deploying = await loadAiWorkflowStageContext({ globalRoot, stage: "deploying" })

    expect(planning).toContain("Planning system context")
    expect(planning).not.toContain("Canonical AI Workflow generation kernel")
    expect(deploying).not.toContain("Canonical AI Workflow generation kernel")
    expect(coding).toContain("Canonical AI Workflow generation kernel")
    expect(coding).toContain("L1 foundation")
    expect(coding).toContain("AICtrlWorkflow")
    expect(coding).toContain("AIDataWorkflow")
    expect(coding).toContain("expected_revision")
    expect(coding).toContain("一次 structured `WorkflowWorkspace(operation=patch)`")
    expect(coding).toContain("fresh create")
    expect(coding).toContain("不得再次加载同一 coding stage")
    expect(coding).toContain("flow_code_content")
    expect(coding).toContain("`WorkflowCreateBundle` 双文件投影")
    expect(coding).toContain("必须直接以所选 profile 根元素")
    expect(coding).toContain("outputs=[\"hn\"]")
    expect(coding).toContain("禁止逗号")
    expect(coding).toContain("8,000 字符")
    expect(coding).toContain("直接 transition 到 testing")
    expect(coding).toContain("provider effect 失败就是当前动作失败的唯一事实")
    expect(coding).toContain("Runtime effect capability contract")
    expect(coding).toContain("runtime.ai.metadata.run")
    expect(coding).toContain("禁止生成 runtime probe")
    expect(coding).toContain("operation: \"tool.call\"")
    expect(coding).toContain('toolName: "webfetch"')
    expect(coding).toContain("所有必需源均失败时必须抛出错误")

    const operating = await loadAiWorkflowStageContext({ globalRoot, stage: "operating" })
    expect(deploying).toContain("WorkflowCreateInstance")
    expect(deploying).toContain("WorkflowRun(confirmed=true)")
    expect(deploying).toContain("publicationReceipt.workflowRef")
    expect(deploying).toContain("publicationReceipt.contract.inputPorts")
    expect(deploying).toContain("不得再调用 `WorkflowListTypes`")
    expect(deploying).toContain("`{workflow_ref, input:{}}`")
    expect(deploying).toContain("不得调用 `WorkflowListInstances`")
    expect(deploying).toContain("不输出解释性过渡")
    expect(operating).toContain("没有 instance identity 时切回 deploying")
  })

  test("routes a concrete fresh create directly to coding without planning discovery", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-global-"))
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-workspace-"))
    await installBundledSystemSkills({ globalRoot })
    const root = loadSkillEntriesWithSystemAuthority({ globalRoot, workspaceRoot })["sys-ai-workflow"]?.body ?? ""
    const planning = await loadAiWorkflowStageContext({ globalRoot, stage: "planning" })

    expect(root).toContain("直接选择 `coding`")
    expect(root).toContain("不得先进入 planning")
    expect(planning).toContain("不得调用 catalog/list/summary")
  })

  test("teaches exact entry envelopes and honest external-effect acceptance", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-global-"))
    await installBundledSystemSkills({ globalRoot })

    const testing = await loadAiWorkflowStageContext({ globalRoot, stage: "testing" })
    expect(testing).toContain('{ "input": { ...业务输入... } }')
    expect(testing).toContain("static dry-run 只证明 definition/binding")
    expect(testing).toContain("所有必需源失败时 workflow 进入 `Failed`")
    expect(testing).toContain("真实运行验收移交 deploying/operating 阶段执行")
    expect(testing).toContain("WorkflowPreparePublication")
    expect(testing).toContain("WorkflowPreparePublication({session_id})")
    expect(testing).toContain("acceptance disposition 由 component 从 canonical profile/manifest 派生")
    expect(testing).toContain("不得由模型提交 acceptance policy")
    expect(testing).toContain("WorkflowCompleteAuthoring(outcome=ready)")
  })
})
