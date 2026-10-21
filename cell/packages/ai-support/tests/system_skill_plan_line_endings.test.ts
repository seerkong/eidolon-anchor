import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { loadAIWorkflowFlowDslReferenceModule } from "ai-workflow-flow-dsl-reference"
import { loadHalfcodeResourceDslSystemSkillModule, skillCapsuleDistributionProjection } from "halfcode-compiler.xnl"
import { EIDOLON_ANCHOR_SYSTEM_SKILL_MODULE } from "../src/system-skill/EidolonAnchorSystemSkillModule"
import { normalizeSkillSourceBytes, planLfSystemSkillDistribution } from "../tools/lf-system-skill-plan"

test("normalizes LF, CRLF and CR text without changing binary assets or UTF-8 BOMs", () => {
  const canonical = Buffer.from("\ufefffirst\n第二行\n")
  for (const ending of ["\n", "\r\n", "\r"]) {
    const input = Buffer.from(canonical.toString().replace(/\n/g, ending))
    const actual = Buffer.from(normalizeSkillSourceBytes("SKILL.md", input))
    expect(actual).toEqual(canonical)
    expect(createHash("sha256").update(actual).digest("hex"))
      .toBe(createHash("sha256").update(canonical).digest("hex"))
    expect(actual.toString("base64")).toBe(canonical.toString("base64"))
  }
  for (const [name, bytes] of [
    ["asset.bin", Buffer.from([65, 13, 10, 66, 13])],
    ["invalid.md", Buffer.from([255, 13, 10])],
    ["binary.txt", Buffer.from([0, 13, 10])],
  ] as const) expect(normalizeSkillSourceBytes(name, bytes)).toEqual(bytes)
})

test("the real planner produces identical file, provenance and closure digests for every line ending", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "eidolon-skill-endings-test-"))
  try {
    const resourceRootDir = path.join(root, "resources")
    await cp(EIDOLON_ANCHOR_SYSTEM_SKILL_MODULE.resourceRootDir, resourceRootDir, { recursive: true })
    const operation = path.join(resourceRootDir, "content", "run", "operations", "index.md")
    const canonical = (await readFile(operation, "utf8")).replace(/\r\n?/g, "\n")
    const binary = Buffer.from([0, 255, 13, 10, 13, 65])
    await writeFile(path.join(path.dirname(operation), "asset.bin"), binary)
    let expected: ReturnType<typeof skillCapsuleDistributionProjection> | undefined
    for (const ending of ["\n", "\r\n", "\r"]) {
      const source = canonical.replace(/\n/g, ending)
      await writeFile(operation, source)
      const plan = await planLfSystemSkillDistribution({
        modules: [loadHalfcodeResourceDslSystemSkillModule(), loadAIWorkflowFlowDslReferenceModule(),
          { ...EIDOLON_ANCHOR_SYSTEM_SKILL_MODULE, resourceRootDir }],
        rootSkillFqns: ["Eidolon.Anchor.Skill.DevOps"],
      })
      const file = plan.files.find(file => file.targetRelativePath === "sys-eidolon-anchor-run/operations/index.md")!
      expect(file.contentBase64).toBe(Buffer.from(canonical).toString("base64"))
      expect(file.contentDigest).toBe(`sha256:${createHash("sha256").update(canonical).digest("hex")}`)
      expect(plan.files.find(file => file.capsuleRelativePath === "operations/asset.bin")!.content).toEqual(new Uint8Array(binary))
      const projection = skillCapsuleDistributionProjection(plan)
      if (expected === undefined) expected = projection
      else expect(projection).toEqual(expected)
      expect(await readFile(operation, "utf8")).toBe(source)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
