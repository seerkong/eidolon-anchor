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
import { assembleAiKernelRuntimeProfile } from "../../../../mod-profiles/src/index";
import { skillCoreLogic } from "../../../src/composer/AIAgent/tools/Skill/Logic";

function makeHarness() {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "eidolon-progressive-skill-"));
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
      metadata: { sessionId: "session-progressive-skill", exec_protocol: { mode: "default" } },
    },
  } as any;

  async function skill(toolCallId: string, name = "demo"): Promise<string> {
    toolCallDomain.planTool({
      toolCallId,
      actorKey: actor.key,
      turnId: 1,
      funcName: "Skill",
      args: { skill: name },
      at: Date.now(),
    });
    toolCallDomain.recordGateDecision({ toolCallId, gateOutcome: "allow", at: Date.now() });
    toolCallDomain.markExecuting({ toolCallId, at: Date.now() });
    const output = await skillCoreLogic({ vm, actor, toolCallId } as any, { skill: name }, {});
    toolCallDomain.recordResult({ toolCallId, outputText: output, at: Date.now() });
    appendLiveHistoryMessageToConversationDomainRuntime({
      vm,
      actorKey: actor.key,
      actorId: actor.id,
      message: { role: "tool", toolCallId, tool_call_id: toolCallId, content: output },
    });
    return output;
  }

  return { conversationDomainRuntime, registries, skill, skillPath, writeSkill };
}

describe("Skill progressive local text resource loading", () => {
  it("uses the generic resource envelope and reuses the same visible revision", async () => {
    const harness = makeHarness();

    const first = await harness.skill("skill-1");
    expect(first).toContain('<context-resource status="loaded"');
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
      expect(visible).not.toContain("First instructions");
    }
    expect([first, ...repeats].join("\n").match(/First instructions/g)).toHaveLength(1);

    const asset = harness.conversationDomainRuntime.sessionStateSignal
      .get()["session-progressive-skill"]?.contextAssets?.[0];
    expect(asset?.resourceFact?.canonicalResourceId).toBe(
      `${pathToFileURL(harness.skillPath).href}#instruction-document`,
    );
    expect(asset?.resourceFact?.deliveries.map((delivery) => delivery.toolCallId)).toEqual(["skill-1"]);
  });

  it("preserves unknown-skill output and reloads the live catalog after document changes", async () => {
    const harness = makeHarness();

    expect(await harness.skill("skill-missing", "missing")).toBe("Error: Unknown skill 'missing'. Available: demo");

    await harness.skill("skill-1");
    harness.writeSkill("Updated instructions");
    const changed = await harness.skill("skill-2");
    expect(changed).toContain('<context-resource status="loaded"');
    expect(changed).toContain("Updated instructions");
    expect(SkillRegistry.get(harness.registries.skillRegistry, "demo")?.documentPath).toBe(harness.skillPath);
  });
});
