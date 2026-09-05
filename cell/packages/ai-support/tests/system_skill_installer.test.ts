import { describe, expect, test } from "bun:test"
import { cp, lstat, mkdtemp, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  installBundledSystemSkills,
  loadAiWorkflowStageContext,
  loadSystemSkillContext,
  loadSkillEntriesWithSystemAuthority,
  readInstalledSystemSkillManifest,
  readInstalledSystemSkillResource,
  resolveEidolonGlobalRootFromOuterContext,
} from "../src/system-skill/SystemSkillInstaller"
import {
  EXPECTED_EIDOLON_SYSTEM_SKILL_SET,
  loadEidolonSystemSkillDistributionPlan,
} from "../src/system-skill/GeneratedEidolonSystemSkillPlan"

async function snapshotTree(root: string, current = root): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {}
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name)
    const relative = path.relative(root, absolute).split(path.sep).join("/")
    if (entry.isDirectory()) {
      snapshot[`${relative}/`] = "directory"
      Object.assign(snapshot, await snapshotTree(root, absolute))
    } else if (entry.isSymbolicLink()) {
      snapshot[relative] = `symlink:${await readlink(absolute)}`
    } else {
      snapshot[relative] = `file:${Buffer.from(await readFile(absolute)).toString("base64")}`
    }
  }
  return Object.fromEntries(Object.entries(snapshot).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
}

describe("bundled system skills", () => {
  test("keeps the generated Halfcode distribution and the whole-root transaction as separate authorities", async () => {
    const source = await readFile(
      path.join(import.meta.dir, "../src/system-skill/SystemSkillInstaller.ts"),
      "utf8",
    )
    expect(source).toContain("loadEidolonSystemSkillDistributionPlan")
    expect(source).toContain("applySkillCapsuleDistributionPlan")
    expect(source).toContain("replaceSkillsRoot")
    expect(source).not.toContain("planSkillCapsuleDistribution")
    expect(source).not.toContain("replaceDirectoryAtomically")
    expect(source).not.toContain("BUNDLED_SYSTEM_SKILLS")
    expect(source).not.toContain("loadHalfcodeResourceDslSystemSkillPlan")
  })

  test("derives the exact four patch-versioned identities without a payload identity descriptor", () => {
    expect(EXPECTED_EIDOLON_SYSTEM_SKILL_SET.map(({ name, version }) => ({ name, version }))).toEqual([
      { name: "sys-eidolon-anchor-run", version: "1.0.5" },
      { name: "sys-halfcode-resource-dsl", version: "1.0.0" },
      { name: "sys-eidolon-anchor-authoring", version: "1.0.25" },
      { name: "sys-eidolon-anchor-devops", version: "1.0.29" },
    ])
    expect(EXPECTED_EIDOLON_SYSTEM_SKILL_SET.flatMap((skill) => skill.files.map((file) => file.path)))
      .not.toContain("system-skill.xnl")
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
    const firstTree = await snapshotTree(path.join(globalRoot, "skills"))
    const second = await installBundledSystemSkills({ globalRoot })

    expect(first.installed).toEqual(EXPECTED_EIDOLON_SYSTEM_SKILL_SET.map((entry) => entry.name))
    expect(second.installed).toEqual(EXPECTED_EIDOLON_SYSTEM_SKILL_SET.map((entry) => entry.name))
    expect(first.managed.map(({ name, version, source }) => ({ name, version, source }))).toEqual(
      EXPECTED_EIDOLON_SYSTEM_SKILL_SET.map(({ name, version }) => ({
        name,
        version,
        source: "halfcode-distribution",
      })),
    )
    expect(second.managed).toEqual(first.managed)
    expect(await snapshotTree(path.join(globalRoot, "skills"))).toEqual(firstTree)
    expect(await readFile(path.join(userSkill, "SKILL.md"), "utf8")).toBe("user-owned")
    expect(await Bun.file(path.join(staleSystemSkill, "stale.txt")).exists()).toBe(false)
    expect(await Bun.file(path.join(globalRoot, "skills", ".system-skills.xnl")).exists()).toBe(true)
  })

  test("preserves ordinary symbolic links without following their targets", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-global-"))
    const externalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-external-skill-"))
    await writeFile(path.join(externalRoot, "SKILL.md"), "external user content")
    await mkdir(path.join(globalRoot, "skills"), { recursive: true })
    await symlink(externalRoot, path.join(globalRoot, "skills", "linked-user-skill"))

    await installBundledSystemSkills({ globalRoot })

    const linkPath = path.join(globalRoot, "skills", "linked-user-skill")
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true)
    expect(await readlink(linkPath)).toBe(externalRoot)
    expect(await readFile(path.join(externalRoot, "SKILL.md"), "utf8")).toBe("external user content")
  })

  test("installs the canonical Halfcode Resource DSL Skill and records exact file evidence", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-global-"))
    const result = await installBundledSystemSkills({ globalRoot })
    const generated = result.managed.find((entry) => entry.name === "sys-halfcode-resource-dsl")
    const plan = loadEidolonSystemSkillDistributionPlan()
    const planned = plan.capsules.find((entry) => entry.identity.name === "sys-halfcode-resource-dsl")
    expect(generated).toMatchObject({
      version: "1.0.0",
      source: "halfcode-distribution",
      capsuleFqn: "Halfcode.ResourceDsl.Skill.System",
      closureDigest: plan.closureDigest,
      fileCount: planned?.files.length,
    })
    expect(await readFile(
      path.join(globalRoot, "skills", "sys-halfcode-resource-dsl", "SKILL.md"),
      "utf8",
    )).toContain("# Halfcode Resource DSL")

    const manifest = await readInstalledSystemSkillManifest({ globalRoot })
    expect(manifest.managed).toEqual(result.managed)
    expect(manifest.skills.find((entry) => entry.name === "sys-halfcode-resource-dsl")?.files).toHaveLength(23)
  })

  test("keeps the previous complete Skill tree when candidate reconciliation is interrupted", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-global-"))
    const oldSkill = path.join(globalRoot, "skills", "existing-user-skill")
    await mkdir(oldSkill, { recursive: true })
    await writeFile(path.join(oldSkill, "SKILL.md"), "previous-user-content")
    await writeFile(path.join(globalRoot, "skills", ".system-skills.xnl"), "previous-manifest")

    await expect(installBundledSystemSkills({
      globalRoot,
      onStep: (step) => {
        if (step === "after-candidate-readback") throw new Error("controlled candidate interruption")
      },
    })).rejects.toThrow("controlled candidate interruption")

    expect(await readFile(path.join(oldSkill, "SKILL.md"), "utf8")).toBe("previous-user-content")
    expect(await readFile(path.join(globalRoot, "skills", ".system-skills.xnl"), "utf8")).toBe("previous-manifest")
    expect(await Bun.file(path.join(globalRoot, "skills", "sys-halfcode-resource-dsl", "SKILL.md")).exists()).toBe(false)
  })

  test("restores the previous tree at every controlled installer transition", async () => {
    for (const interruptedStep of [
      "after-halfcode-apply",
      "after-candidate-readback",
      "after-backup",
      "after-live-rename",
      "after-live-readback",
    ] as const) {
      const globalRoot = await mkdtemp(path.join(os.tmpdir(), `eidolon-global-${interruptedStep}-`))
      const skillsRoot = path.join(globalRoot, "skills")
      await mkdir(path.join(skillsRoot, "existing-user-skill"), { recursive: true })
      await writeFile(path.join(skillsRoot, "existing-user-skill", "SKILL.md"), `previous-${interruptedStep}`)
      await writeFile(path.join(skillsRoot, ".system-skills.xnl"), `manifest-${interruptedStep}`)
      const before = await snapshotTree(skillsRoot)

      await expect(installBundledSystemSkills({
        globalRoot,
        onStep: (step) => {
          if (step === interruptedStep) throw new Error(`controlled interruption at ${step}`)
        },
      })).rejects.toThrow(`controlled interruption at ${interruptedStep}`)

      expect(await snapshotTree(skillsRoot)).toEqual(before)
      expect((await readdir(globalRoot)).filter((name) =>
        name.startsWith(".skills.candidate-")
        || name.startsWith(".skills.backup-")
        || name.startsWith(".skills.rejected-")
        || name.startsWith(".system-skills.work-")
      )).toEqual([])
    }
  })

  test("keeps the verified live tree after the transaction commit point when backup cleanup fails", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-global-"))
    await installBundledSystemSkills({ globalRoot })
    const ordinarySkill = path.join(globalRoot, "skills", "ordinary-skill")
    await mkdir(ordinarySkill, { recursive: true })
    await writeFile(path.join(ordinarySkill, "SKILL.md"), "ordinary content")

    await expect(installBundledSystemSkills({
      globalRoot,
      onStep: (step) => {
        if (step === "before-backup-cleanup") throw new Error("controlled backup cleanup failure")
      },
    })).rejects.toThrow("SYSTEM_SKILL_BACKUP_CLEANUP_FAILED")

    expect(await readFile(path.join(globalRoot, "skills", "ordinary-skill", "SKILL.md"), "utf8")).toBe("ordinary content")
    expect(await readInstalledSystemSkillManifest({ globalRoot })).toBeDefined()
    const rootEntries = await readdir(globalRoot)
    expect(rootEntries.filter((name) => name.startsWith(".skills.rejected-"))).toEqual([])
    expect(rootEntries.filter((name) => name.startsWith(".skills.backup-"))).toHaveLength(1)
  })

  test("reads ordered system Skill context through exact manifest-bound file evidence", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-global-"))
    await installBundledSystemSkills({ globalRoot })

    const context = await loadSystemSkillContext({
      globalRoot,
      skillName: "sys-halfcode-resource-dsl",
      relativePaths: [
        "references/resource-dsl/index.md",
        "references/resource-dsl/language.md",
      ],
    })
    expect(context.indexOf("references/resource-dsl/index.md")).toBeLessThan(
      context.indexOf("references/resource-dsl/language.md"),
    )

    const skillPath = path.join(globalRoot, "skills", "sys-halfcode-resource-dsl", "SKILL.md")
    await writeFile(skillPath, "changed after installation")
    await expect(readInstalledSystemSkillResource({
      globalRoot,
      skillName: "sys-halfcode-resource-dsl",
      relativePath: "SKILL.md",
    })).rejects.toThrow("digest")
  })

  test("rejects a managed file replaced by a symbolic link", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-global-"))
    const externalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-external-managed-"))
    await installBundledSystemSkills({ globalRoot })
    const skillPath = path.join(globalRoot, "skills", "sys-halfcode-resource-dsl", "SKILL.md")
    const externalPath = path.join(externalRoot, "SKILL.md")
    await writeFile(externalPath, await readFile(skillPath))
    await rm(skillPath)
    await symlink(externalPath, skillPath)

    await expect(readInstalledSystemSkillResource({
      globalRoot,
      skillName: "sys-halfcode-resource-dsl",
      relativePath: "SKILL.md",
    })).rejects.toThrow("must be a physical file")
  })

  test("rejects a managed Skill root replaced by a symbolic link", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-global-"))
    const externalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-external-managed-root-"))
    await installBundledSystemSkills({ globalRoot })
    const skillRoot = path.join(globalRoot, "skills", "sys-halfcode-resource-dsl")
    const externalSkillRoot = path.join(externalRoot, "sys-halfcode-resource-dsl")
    await cp(skillRoot, externalSkillRoot, { recursive: true })
    await rm(skillRoot, { recursive: true })
    await symlink(externalSkillRoot, skillRoot)
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-workspace-"))

    await expect(readInstalledSystemSkillResource({
      globalRoot,
      skillName: "sys-halfcode-resource-dsl",
      relativePath: "SKILL.md",
    })).rejects.toThrow("must be a physical directory")
    expect(() => loadSkillEntriesWithSystemAuthority({
      globalRoot,
      workspaceRoot,
    })).toThrow("must be a physical directory")
  })

  test("rejects a global skills root replaced by a symbolic link before runtime directory scanning", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-global-"))
    const externalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-external-skills-root-"))
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-workspace-"))
    await installBundledSystemSkills({ globalRoot })
    const skillsRoot = path.join(globalRoot, "skills")
    const externalSkillsRoot = path.join(externalRoot, "skills")
    await cp(skillsRoot, externalSkillsRoot, { recursive: true })
    await rm(skillsRoot, { recursive: true })
    await symlink(externalSkillsRoot, skillsRoot)

    await expect(readInstalledSystemSkillManifest({ globalRoot })).rejects.toThrow("must be a physical directory")
    expect(() => loadSkillEntriesWithSystemAuthority({ globalRoot, workspaceRoot })).toThrow(
      "must be a physical directory",
    )
  })

  test("rejects a system Skill manifest replaced by a symbolic link", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-global-"))
    const externalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-external-manifest-"))
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-workspace-"))
    await installBundledSystemSkills({ globalRoot })
    const manifestPath = path.join(globalRoot, "skills", ".system-skills.xnl")
    const externalManifestPath = path.join(externalRoot, ".system-skills.xnl")
    await writeFile(externalManifestPath, await readFile(manifestPath))
    await rm(manifestPath)
    await symlink(externalManifestPath, manifestPath)

    await expect(readInstalledSystemSkillManifest({ globalRoot })).rejects.toThrow("must be a physical file")
    expect(() => loadSkillEntriesWithSystemAuthority({ globalRoot, workspaceRoot })).toThrow(
      "must be a physical file",
    )
  })

  test("rejects unusual manifest paths, duplicate file facts, and unknown managed identities", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-global-"))
    await installBundledSystemSkills({ globalRoot })
    const manifestPath = path.join(globalRoot, "skills", ".system-skills.xnl")
    const canonical = await readFile(manifestPath, "utf8")

    await writeFile(manifestPath, canonical.replace('path = "SKILL.md"', 'path = "../SKILL.md"'))
    await expect(readInstalledSystemSkillManifest({ globalRoot })).rejects.toThrow("SYSTEM_SKILL_PATH_INVALID")

    const fileLine = canonical.split("\n").find((line) => line.includes('<File { path = "SKILL.md"'))
    expect(fileLine).toBeDefined()
    await writeFile(manifestPath, canonical.replace(fileLine!, `${fileLine}\n${fileLine}`))
    await expect(readInstalledSystemSkillManifest({ globalRoot })).rejects.toThrow("duplicate path SKILL.md")

    await writeFile(manifestPath, canonical)
    await expect(readInstalledSystemSkillResource({
      globalRoot,
      skillName: "sys-not-installed",
      relativePath: "SKILL.md",
    })).rejects.toThrow("SYSTEM_SKILL_NOT_MANAGED")
  })

  test("installs separated operation roots and generated Flow DSL references", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-global-"))
    await installBundledSystemSkills({ globalRoot })
    const skillsRoot = path.join(globalRoot, "skills")
    expect(await Bun.file(path.join(skillsRoot, "sys-eidolon-anchor-authoring", "operations", "index.md")).exists()).toBe(true)
    expect(await Bun.file(path.join(skillsRoot, "sys-eidolon-anchor-run", "operations", "index.md")).exists()).toBe(true)
    for (const relative of [
      "references/flow-dsl/foundation/depa-axioms.md",
      "references/flow-dsl/std/eager-data-flow/axioms.md",
      "references/flow-dsl/std/work-ctrl-flow/axioms.md",
      "references/flow-dsl/spec/flow-core/nodes.md",
      "references/flow-dsl/spec/ai-workflow/resources.md",
      "references/flow-dsl/spec/ai-workflow/data-workflow.md",
      "references/flow-dsl/spec/ai-workflow/ctrl-workflow.md",
      "references/flow-dsl/.depa-flow-dsl-provenance.json",
    ]) {
      expect(await Bun.file(path.join(skillsRoot, "sys-eidolon-anchor-authoring", relative)).exists()).toBe(true)
    }
    expect(await Bun.file(path.join(skillsRoot, "sys-ai-workflow")).exists()).toBe(false)
  })

  test("resolves global sys identities without allowing workspace shadowing", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-global-"))
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-workspace-"))
    await installBundledSystemSkills({ globalRoot })
    const shadow = path.join(workspaceRoot, ".eidolon", "skills", "sys-eidolon-anchor-devops")
    await mkdir(shadow, { recursive: true })
    await writeFile(path.join(shadow, "SKILL.md"), [
      "---", "name: sys-eidolon-anchor-devops", "description: shadow", "---", "shadow body",
    ].join("\n"))

    const entries = loadSkillEntriesWithSystemAuthority({ globalRoot, workspaceRoot })
    expect(entries["sys-eidolon-anchor-devops"]?.body).not.toContain("shadow body")
    expect(entries["sys-eidolon-anchor-devops"]?.dir).toBe(path.join(globalRoot, "skills", "sys-eidolon-anchor-devops"))
  })

  test("skips reserved workspace system paths before directory inspection", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-global-"))
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-workspace-"))
    await installBundledSystemSkills({ globalRoot })
    const workspaceSkills = path.join(workspaceRoot, ".eidolon", "skills")
    await mkdir(path.join(workspaceSkills, "ordinary-workspace-skill"), { recursive: true })
    await writeFile(path.join(workspaceSkills, "ordinary-workspace-skill", "SKILL.md"), [
      "---", "name: ordinary-workspace-skill", "description: ordinary", "---", "ordinary workspace body",
    ].join("\n"))
    await symlink(
      path.join(workspaceRoot, "missing-system-target"),
      path.join(workspaceSkills, "sys-eidolon-anchor-devops"),
    )

    const entries = loadSkillEntriesWithSystemAuthority({ globalRoot, workspaceRoot })
    expect(entries["sys-eidolon-anchor-devops"]?.dir).toBe(path.join(globalRoot, "skills", "sys-eidolon-anchor-devops"))
    expect(entries["ordinary-workspace-skill"]?.body).toContain("ordinary workspace body")
  })

  test("exposes only manifest-managed global sys identities and removes stale sys directories on init", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-global-"))
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-workspace-"))
    await installBundledSystemSkills({ globalRoot })
    const staleSystemSkill = path.join(globalRoot, "skills", "sys-unlisted")
    await mkdir(staleSystemSkill, { recursive: true })
    await writeFile(path.join(staleSystemSkill, "SKILL.md"), [
      "---", "name: sys-unlisted", "description: unlisted", "---", "unlisted body",
    ].join("\n"))

    const entries = loadSkillEntriesWithSystemAuthority({ globalRoot, workspaceRoot })
    expect(Object.keys(entries).filter((name) => name.startsWith("sys-"))).toEqual(
      EXPECTED_EIDOLON_SYSTEM_SKILL_SET.map((entry) => entry.name),
    )
    expect(entries["sys-unlisted"]).toBeUndefined()

    await installBundledSystemSkills({ globalRoot })
    expect(await Bun.file(staleSystemSkill).exists()).toBe(false)
  })

  test("loads each managed identity only from its manifest-named canonical directory", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-global-"))
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-workspace-"))
    await installBundledSystemSkills({ globalRoot })
    const ordinaryCollision = path.join(globalRoot, "skills", "zzz-ordinary-collision")
    await mkdir(ordinaryCollision, { recursive: true })
    await writeFile(path.join(ordinaryCollision, "SKILL.md"), [
      "---", "name: sys-eidolon-anchor-devops", "description: ordinary collision", "---", "ordinary collision body",
    ].join("\n"))

    const entries = loadSkillEntriesWithSystemAuthority({ globalRoot, workspaceRoot, requireSystemSkills: true })
    expect(entries["sys-eidolon-anchor-devops"]?.dir).toBe(path.join(globalRoot, "skills", "sys-eidolon-anchor-devops"))
    expect(entries["sys-eidolon-anchor-devops"]?.body).not.toContain("ordinary collision body")

    await installBundledSystemSkills({ globalRoot })
    expect(await Bun.file(path.join(ordinaryCollision, "SKILL.md")).exists()).toBe(true)
    const repeatedEntries = loadSkillEntriesWithSystemAuthority({ globalRoot, workspaceRoot })
    expect(repeatedEntries["sys-eidolon-anchor-devops"]?.dir).toBe(path.join(globalRoot, "skills", "sys-eidolon-anchor-devops"))
  })

  test("derives managed runtime resources from the manifest and rejects undeclared files", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-global-"))
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-workspace-"))
    await installBundledSystemSkills({ globalRoot })
    const entries = loadSkillEntriesWithSystemAuthority({ globalRoot, workspaceRoot })
    const manifest = await readInstalledSystemSkillManifest({ globalRoot })
    const managed = manifest.skills.find((skill) => skill.name === "sys-eidolon-anchor-devops")!
    expect(entries["sys-eidolon-anchor-devops"]?.resources).toEqual(
      managed.files.map((file) => file.path).filter((filePath) => filePath !== "SKILL.md"),
    )

    await writeFile(path.join(globalRoot, "skills", "sys-eidolon-anchor-devops", "unlisted.md"), "unlisted")
    expect(() => loadSkillEntriesWithSystemAuthority({ globalRoot, workspaceRoot })).toThrow(
      "contains undeclared or missing files",
    )
  })

  test("rejects an old manifest before exposing any managed system Skill", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-global-"))
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-workspace-"))
    await installBundledSystemSkills({ globalRoot })
    const ordinaryPath = path.join(globalRoot, "skills", "ordinary-skill", "SKILL.md")
    await mkdir(path.dirname(ordinaryPath), { recursive: true })
    await writeFile(ordinaryPath, "ordinary content")
    const manifestPath = path.join(globalRoot, "skills", ".system-skills.xnl")
    const current = await readFile(manifestPath, "utf8")
    await writeFile(manifestPath, current.replace('name = "sys-eidolon-anchor-run"', 'name = "sys-ai-workflow"'))

    expect(() => loadSkillEntriesWithSystemAuthority({
      globalRoot,
      workspaceRoot,
      requireSystemSkills: true,
    })).toThrow("SYSTEM_SKILL_BUILD_MISMATCH")
    await expect(readInstalledSystemSkillResource({
      globalRoot,
      skillName: "sys-eidolon-anchor-devops",
      relativePath: "SKILL.md",
    })).rejects.toThrow("SYSTEM_SKILL_BUILD_MISMATCH")
    expect(await readFile(ordinaryPath, "utf8")).toBe("ordinary content")
  })

  test("rejects identity metadata and closure drift against the generated projection", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-global-"))
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-workspace-"))
    await installBundledSystemSkills({ globalRoot })
    const manifestPath = path.join(globalRoot, "skills", ".system-skills.xnl")
    const current = await readFile(manifestPath, "utf8")
    for (const changed of [
      current.replace('version = "1.0.0"', 'version = "1.0.1"'),
      current.replace('capsuleFqn = "Eidolon.Anchor.Skill.Run"', 'capsuleFqn = "Eidolon.Anchor.Skill.LegacyRun"'),
      current.replace(/closureDigest = "sha256:[a-f0-9]{64}"/, `closureDigest = "sha256:${"0".repeat(64)}"`),
    ]) {
      await writeFile(manifestPath, changed)
      expect(() => loadSkillEntriesWithSystemAuthority({
        globalRoot,
        workspaceRoot,
        requireSystemSkills: true,
      })).toThrow("SYSTEM_SKILL_BUILD_MISMATCH")
    }
  })

  test("loads the exact DevOps stage and coding Authoring entry resources", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-global-"))
    await installBundledSystemSkills({ globalRoot })

    const planning = await loadAiWorkflowStageContext({ globalRoot, stage: "planning" })
    const coding = await loadAiWorkflowStageContext({ globalRoot, stage: "coding" })
    const deploying = await loadAiWorkflowStageContext({ globalRoot, stage: "deploying" })
    const operating = await loadAiWorkflowStageContext({ globalRoot, stage: "operating" })
    const improving = await loadAiWorkflowStageContext({ globalRoot, stage: "improving" })

    expect(planning).toContain("Planning system context")
    expect(coding).toContain("already includes the Authoring root")
    expect(coding).toContain("do not load either again")
    expect(deploying).toContain("sys-eidolon-anchor-run")
    expect(operating).toContain("# Run operations")
    expect(operating).toContain("operations/resolve-entrypoint.md")
    expect(improving).toContain("Improving system context")
    expect(coding).not.toContain("L1 foundation")
    expect(coding).not.toContain("AICtrlWorkflow")
    expect(coding).not.toContain("AIDataWorkflow")
    expect(coding.match(/<!-- sys-eidolon-anchor-devops\/coding\//g)).toHaveLength(2)
    expect(coding.match(/<!-- sys-eidolon-anchor-authoring\//g)).toHaveLength(2)
    expect(deploying.match(/<!-- sys-eidolon-anchor-devops\/deploying\//g)).toHaveLength(2)
    expect(deploying.match(/<!-- sys-eidolon-anchor-run\//g)).toHaveLength(2)
    expect(operating.match(/<!-- sys-eidolon-anchor-run\//g)).toHaveLength(2)
  })

  test("keeps fresh-create routing in DevOps and detailed edits in Authoring operations", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-global-"))
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-workspace-"))
    await installBundledSystemSkills({ globalRoot })
    const root = loadSkillEntriesWithSystemAuthority({ globalRoot, workspaceRoot })["sys-eidolon-anchor-devops"]?.body ?? ""
    const planning = await loadAiWorkflowStageContext({ globalRoot, stage: "planning" })
    const createOpen = await readInstalledSystemSkillResource({
      globalRoot,
      skillName: "sys-eidolon-anchor-authoring",
      relativePath: "operations/create-open.md",
    })
    const patch = await readInstalledSystemSkillResource({
      globalRoot,
      skillName: "sys-eidolon-anchor-authoring",
      relativePath: "operations/batch-patch.md",
    })
    const openPackage = await readInstalledSystemSkillResource({
      globalRoot,
      skillName: "sys-eidolon-anchor-authoring",
      relativePath: "operations/open-resource-package.md",
    })
    const createPackage = await readInstalledSystemSkillResource({
      globalRoot,
      skillName: "sys-eidolon-anchor-authoring",
      relativePath: "operations/create-resource-package.md",
    })
    const inspect = await readInstalledSystemSkillResource({
      globalRoot,
      skillName: "sys-eidolon-anchor-authoring",
      relativePath: "operations/inspect.md",
    })

    expect(root).toContain("confirmed fresh create")
    expect(root).toContain("coding")
    expect(planning).toContain("catalog/list/summary")
    expect(createOpen).toContain("WorkflowCreateBundle")
    expect(createOpen).toContain("WorkflowOpenAuthoringSession")
    expect(patch).toContain("expected_revision")
    expect(patch).toContain("WorkflowWorkspace")
    expect(patch).toContain("one coherent batch")
    expect(patch).toContain('"kind": "add|update|delete"')
    expect(openPackage).toContain("same deterministic receipt")
    expect(openPackage).toContain("effective KindDefinition documents")
    expect(openPackage).toContain("do not call workspace `describe`, `tree`, or `read_selection`")
    expect(openPackage).toContain("do not search or read those KindDefinition paths again")
    expect(openPackage).toContain("Do not call read on /work")
    expect(createPackage).toContain("WorkflowCreateResourcePackageSession")
    expect(createPackage).toContain("does not synthesize KindDefinitions")
    expect(inspect).toContain("standalone `read_selection` operation is a recovery fallback")
    expect(inspect).toContain("next provider completion")
  })

  test("keeps publication and runtime authorization in separate exact operation resources", async () => {
    const globalRoot = await mkdtemp(path.join(os.tmpdir(), "eidolon-global-"))
    await installBundledSystemSkills({ globalRoot })

    const testing = await loadAiWorkflowStageContext({ globalRoot, stage: "testing" })
    expect(testing).toContain("WorkflowPreparePublication")
    expect(testing).toContain("publication authorization")
    expect(testing).not.toContain("WorkflowRun")

    const publication = await readInstalledSystemSkillResource({
      globalRoot,
      skillName: "sys-eidolon-anchor-authoring",
      relativePath: "operations/publish.md",
    })
    expect(publication).toContain("WorkflowPublishAuthoringSession")
    expect(publication).toContain("confirmed: true")
    expect(publication).toContain("does not authorize execution")

    const run = await readInstalledSystemSkillResource({
      globalRoot,
      skillName: "sys-eidolon-anchor-run",
      relativePath: "operations/index.md",
    })
    expect(run).toContain("WorkflowRun")
    expect(run).toContain("WorkflowResume")
    expect(run).toContain("WorkflowResolve")
    expect(run).toContain("WorkflowReject")
    expect(run).not.toContain("WorkflowCancel")
  })
})
