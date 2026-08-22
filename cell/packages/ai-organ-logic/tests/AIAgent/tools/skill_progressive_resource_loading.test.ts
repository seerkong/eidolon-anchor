import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  appendLiveHistoryMessageToConversationDomainRuntime,
  createConversationDomainRuntime,
  createToolCallDomainRuntime,
} from "@cell/ai-organ-logic";
import { SkillRegistry } from "@cell/ai-core-logic/runtime/SkillRegistry";
import { installBundledSystemSkills } from "@cell/ai-support/system-skill/SystemSkillInstaller";
import { assembleAiKernelRuntimeProfile } from "../../../../mod-profiles/src/index";
import { skillCoreLogic } from "../../../src/composer/AIAgent/tools/Skill/Logic";
import { buildSkillToolDef } from "../../../src/composer/AIAgent/tools/Skill";

function makeHarness() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-progressive-skill-"));
  const globalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-progressive-global-"));
  const skillDir = path.join(workDir, ".eidolon", "skills", "demo");
  fs.mkdirSync(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, "SKILL.md");
  const writeSkill = (body: string) => fs.writeFileSync(skillPath, [
    "---",
    "name: demo",
    "description: Demo skill",
    "---",
    body,
  ].join("\n"));
  writeSkill("First instructions");

  const conversationDomainRuntime = createConversationDomainRuntime();
  const toolCallDomain = createToolCallDomainRuntime();
  const actor = { key: "main", id: "actor-main" };
  const registries = assembleAiKernelRuntimeProfile({
    workDir,
    skillsDescription: "",
    loadedAgents: {},
    delegateAgentDescriptions: "",
  }).createRegistries();
  const vm = {
    actors: { main: actor },
    registries,
    runtimeContext: { conversationDomainRuntime, toolCallDomain },
    outerCtx: {
      workDir,
      metadata: {
        sessionId: "session-progressive-skill",
        exec_protocol: { mode: "default" },
        local_permissions: { authority_root: globalRoot },
      },
    },
  } as any;

  async function skill(
    toolCallId: string,
    input: { skill: string; resource?: string; offset?: number; limit?: number } = { skill: "demo" },
  ): Promise<string> {
    toolCallDomain.planTool({
      toolCallId,
      actorKey: actor.key,
      turnId: 1,
      funcName: "Skill",
      args: input,
      at: Date.now(),
    });
    toolCallDomain.recordGateDecision({ toolCallId, gateOutcome: "allow", at: Date.now() });
    toolCallDomain.markExecuting({ toolCallId, at: Date.now() });
    const output = await skillCoreLogic({ vm, actor, toolCallId } as any, input, {});
    toolCallDomain.recordResult({ toolCallId, outputText: output, at: Date.now() });
    appendLiveHistoryMessageToConversationDomainRuntime({
      vm,
      actorKey: actor.key,
      actorId: actor.id,
      message: { role: "tool", toolCallId, tool_call_id: toolCallId, content: output },
    });
    return output;
  }

  return { conversationDomainRuntime, globalRoot, registries, skill, skillDir, skillPath, vm, writeSkill };
}

describe("Skill progressive local text resource loading", () => {
  it("uses the generic resource envelope and reuses the same visible revision", async () => {
    const harness = makeHarness();

    const first = await harness.skill("skill-1");
    expect(first).toContain('<context-resource status="loaded"');
    expect(first).toContain('total-lines="3"');
    expect(first).toContain("# Skill: demo");
    expect(first).toContain("First instructions");
    expect(first).not.toContain("description: Demo skill");
    expect(first).not.toContain("<skill-loaded");

    const repeats = [];
    for (let index = 2; index <= 5; index += 1) {
      repeats.push(await harness.skill(`skill-${index}`));
    }
    for (const visible of repeats) {
      expect(visible).toContain('<context-resource status="already-visible"');
      expect(visible).toContain('total-lines="3"');
      expect(visible).not.toContain("First instructions");
    }
    expect([first, ...repeats].join("\n").match(/First instructions/g)).toHaveLength(1);

    const asset = harness.conversationDomainRuntime.sessionStateSignal
      .get()["session-progressive-skill"]?.contextAssets?.[0];
    expect(asset?.resourceFact?.canonicalResourceId).toBe(
      `${pathToFileURL(fs.realpathSync(harness.skillPath)).href}#instruction-document`,
    );
    expect(asset?.resourceFact?.deliveries.map((delivery) => delivery.toolCallId)).toEqual(["skill-1"]);
  });

  it("preserves unknown-skill output and reloads the live catalog after document changes", async () => {
    const harness = makeHarness();

    expect(await harness.skill("skill-missing", { skill: "missing" })).toBe("Error: Unknown skill 'missing'. Available: demo");

    await harness.skill("skill-1");
    harness.writeSkill("Updated instructions");
    const changed = await harness.skill("skill-2");
    expect(changed).toContain('<context-resource status="loaded"');
    expect(changed).toContain("Updated instructions");
    expect(SkillRegistry.get(harness.registries.skillRegistry, "demo")?.documentPath).toBe(harness.skillPath);
  });

  it("exposes an exact closed input schema with shared fragment defaults", () => {
    expect(buildSkillToolDef().schema.function.parameters).toEqual({
      type: "object",
      properties: {
        skill: { type: "string", description: "Exact name of the skill to load" },
        resource: { type: "string", description: "Exact declared relative resource; defaults to SKILL.md" },
        offset: { type: "integer", minimum: 1, default: 1 },
        limit: { type: "integer", minimum: 1, default: 2000 },
      },
      required: ["skill"],
      additionalProperties: false,
    });
  });

  it("loads exact ordinary resources and reuses visible fragments from one revision", async () => {
    const harness = makeHarness();
    const resourcePath = path.join(harness.skillDir, "operations", "inspect.md");
    fs.mkdirSync(path.dirname(resourcePath), { recursive: true });
    fs.writeFileSync(resourcePath, "heading\nline two\nline three\nline four\n");

    const first = await harness.skill("resource-1", {
      skill: "demo",
      resource: "operations/inspect.md",
      offset: 2,
      limit: 2,
    });
    expect(first).toContain("2: line two")
    expect(first).toContain("3: line three")
    expect(first).not.toContain("4: line four")
    expect(first).toContain(`${pathToFileURL(fs.realpathSync(resourcePath)).href}`)

    const visible = await harness.skill("resource-2", {
      skill: "demo",
      resource: "operations/inspect.md",
      offset: 2,
      limit: 2,
    });
    expect(visible).toContain('status="already-visible"')
    expect(visible).not.toContain("line two")
  });

  it("fails closed for unknown, undeclared and unsafe ordinary resource paths", async () => {
    const harness = makeHarness();
    const resources = [
      "missing.md",
      "operations",
      "../outside.md",
      path.join(harness.skillDir, "SKILL.md"),
    ]
    for (const [index, resource] of resources.entries()) {
      const output = await harness.skill(`resource-boundary-${index}`, { skill: "demo", resource });
      expect(output).toStartWith("Error:")
      expect(output).not.toContain("First instructions")
    }
  });

  it("requires ordinary resource roots and files to remain physical", async () => {
    const harness = makeHarness();
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-progressive-external-"));
    const externalFile = path.join(externalRoot, "outside.md");
    fs.writeFileSync(externalFile, "outside")
    fs.symlinkSync(externalFile, path.join(harness.skillDir, "escape.md"))

    const output = await harness.skill("resource-symlink", { skill: "demo", resource: "escape.md" });
    expect(output).toContain("Error:")
    expect(output).toContain("physical file")
    expect(output).not.toContain("outside")

    const externalSkill = path.join(externalRoot, "linked-skill")
    fs.mkdirSync(externalSkill)
    fs.writeFileSync(path.join(externalSkill, "SKILL.md"), [
      "---",
      "name: linked",
      "description: Linked skill",
      "---",
      "linked outside",
    ].join("\n"))
    fs.symlinkSync(externalSkill, path.join(harness.vm.outerCtx.workDir, ".eidolon", "skills", "linked"))
    expect(await harness.skill("resource-linked-root", { skill: "linked" })).toBe(
      "Error: Unknown skill 'linked'. Available: demo",
    )
  });

  it("applies shared offset and limit validation", async () => {
    const harness = makeHarness();
    expect(await harness.skill("resource-offset", { skill: "demo", offset: 0 })).toContain(
      "offset and limit must be positive finite numbers",
    );
    expect(await harness.skill("resource-limit", { skill: "demo", limit: 0 })).toContain(
      "offset and limit must be positive finite numbers",
    );
  });

  it("reads managed resources only after generated-set admission and manifest digest validation", async () => {
    const harness = makeHarness();
    await installBundledSystemSkills({ globalRoot: harness.globalRoot });

    const loaded = await harness.skill("managed-1", {
      skill: "sys-eidolon-anchor-authoring",
      resource: "operations/index.md",
      offset: 1,
      limit: 20,
    });
    expect(loaded).toContain("open-resource-package.md")
    expect(loaded).toContain("WorkflowPreparePublication")

    const manifestPath = path.join(harness.globalRoot, "skills", ".system-skills.xnl");
    const manifest = fs.readFileSync(manifestPath, "utf8");
    fs.writeFileSync(
      manifestPath,
      manifest.replace('name = "sys-eidolon-anchor-run"', 'name = "sys-ai-workflow"'),
    );
    await expect(harness.skill("managed-2", {
      skill: "sys-eidolon-anchor-authoring",
      resource: "operations/index.md",
    })).rejects.toThrow("SYSTEM_SKILL_BUILD_MISMATCH")
  });
});
