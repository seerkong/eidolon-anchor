import { describe, expect, it } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

import { composeToolRegistry } from "@cell/ai-organ-logic/composer/AIAgent/ToolFuncComposer";
import { createActor, createVM } from "@cell/ai-core-logic";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const joinTokens = (...parts: string[]) => parts.join("");

describe("tool_registry_builtin_behavior", () => {
  it("keeps builtin tool behavior and supports dynamic MCP ToolDef", async () => {
    const workdir = makeTempDir("tool-registry-");
    const skillsDir = path.join(workdir, ".eidolon", "skills");
    fs.mkdirSync(skillsDir, { recursive: true });

    const registry = composeToolRegistry();
    expect(registry.get("ActorStatus")).toBeTruthy();
    expect(registry.get("ActorWatch")).toBeTruthy();
    expect(registry.get("ActorUnwatch")).toBeTruthy();
    expect(registry.get("ActorAssign")).toBeTruthy();
    expect(registry.get("MemberCreate")).toBeTruthy();
    expect(registry.get("MemberList")).toBeTruthy();
    expect(registry.get("MemberStatus")).toBeTruthy();
    expect(registry.get("MemberAssign")).toBeTruthy();
    expect(registry.get("HolonCreate")).toBeTruthy();
    expect(registry.get("HolonAdd")).toBeTruthy();
    expect(registry.get("HolonAppoint")).toBeTruthy();
    expect(registry.get("HolonStatus")).toBeTruthy();
    expect(registry.get("HolonAssign")).toBeTruthy();
    expect(registry.get("CollectiveCreate")).toBeFalsy();
    expect(registry.get("CollectiveAdd")).toBeFalsy();
    expect(registry.get("CollectiveStatus")).toBeFalsy();
    expect(registry.get("CollectiveAssign")).toBeFalsy();
    expect(registry.get("FormationCreate")).toBeFalsy();
    expect(registry.get("FormationAdd")).toBeFalsy();
    expect(registry.get("FormationAppoint")).toBeFalsy();
    expect(registry.get("FormationStatus")).toBeFalsy();
    expect(registry.get("FormationAssign")).toBeFalsy();
    expect(registry.get("DetachedActorList")).toBeFalsy();
    expect(registry.get("DetachedActorStatus")).toBeFalsy();
    expect(registry.get("DetachedBash")).toBeFalsy();
    expect(registry.get("DetachedToolCall")).toBeFalsy();
    expect(registry.get("ShutdownRequest")).toBeFalsy();
    expect(registry.get("ShutdownStatus")).toBeFalsy();
    expect(registry.get("CoordinationStatus")).toBeFalsy();
    expect(registry.get(joinTokens("Te", "am", "Spawn"))).toBeFalsy();
    expect(registry.get(joinTokens("Te", "am", "List"))).toBeFalsy();
    expect(registry.get(joinTokens("Te", "am", "Send"))).toBeFalsy();
    expect(registry.get(joinTokens("Te", "am", "Broadcast"))).toBeFalsy();
    expect(registry.get(joinTokens("Auto", "nomy", "Start"))).toBeFalsy();
    expect(registry.get(joinTokens("Auto", "nomy", "Dispatch"))).toBeFalsy();
    expect(registry.get(joinTokens("Auto", "nomy", "Tick"))).toBeFalsy();
    expect(registry.get(joinTokens("Auto", "nomy", "Status"))).toBeFalsy();

    const internalRegistry = composeToolRegistry({ includeInternalOnly: true });
    expect(internalRegistry.get("CollectiveCreate")).toBeFalsy();
    expect(internalRegistry.get("CollectiveAdd")).toBeFalsy();
    expect(internalRegistry.get("CollectiveStatus")).toBeFalsy();
    expect(internalRegistry.get("CollectiveAssign")).toBeFalsy();
    expect(internalRegistry.get("FormationCreate")).toBeFalsy();
    expect(internalRegistry.get("FormationAdd")).toBeFalsy();
    expect(internalRegistry.get("FormationAppoint")).toBeFalsy();
    expect(internalRegistry.get("FormationStatus")).toBeFalsy();
    expect(internalRegistry.get("FormationAssign")).toBeFalsy();
    expect(internalRegistry.get("DetachedActorList")).toBeTruthy();
    expect(internalRegistry.get("DetachedActorStatus")).toBeTruthy();

    const actor = createActor({ key: "test" });
    const vm = createVM({
      controlActorKey: actor.key,
      actors: { [actor.key]: actor },
      registries: { toolRegistry: registry },
      outerCtx: {
        workDir: workdir,
      },
    });

    const bashOut = await registry.call("bash", vm, actor, { command: "echo hello" });
    expect(String(bashOut)).toContain("hello");

    const writeOut = await registry.call("write", vm, actor, {
      filePath: "a.txt",
      content: "line1\nline2",
    });
    expect(String(writeOut)).toContain("Wrote");

    const readOut = await registry.call("read", vm, actor, { filePath: "a.txt", limit: 1 });
    expect(readOut).toBe("1: line1");

    const editOut = await registry.call("edit", vm, actor, {
      filePath: "a.txt",
      oldString: "line2",
      newString: "line2-edited",
    });
    expect(JSON.parse(String(editOut))).toMatchObject({
      message: "Edited a.txt",
      diff: expect.stringContaining("+line2-edited"),
    });

    const todoOut = await registry.call("TaskTreeWrite", vm, actor, {
      op: "replace_root",
      tasks: [
        { content: "first", status: "in_progress", activeForm: "main" },
        { content: "second", status: "pending", activeForm: "main" },
      ],
    });
    expect(String(todoOut)).toContain("[>] first");

    const todoExpandOut = await registry.call("TaskTreeWrite", vm, actor, {
      op: "expand",
      parent_id: "task-1",
      tasks: [
        { content: "first-child", status: "pending", activeForm: "main" },
      ],
    });
    expect(String(todoExpandOut)).toContain("first-child");

    const treeOut = await registry.call("TaskTreeRead", vm, actor, {});
    expect(String(treeOut)).toContain("first-child");
    expect(String(treeOut)).toContain("\"nextId\"");

    const weatherOut = await registry.call("get_weather", vm, actor, { location: "Tokyo" });
    expect(String(weatherOut)).toContain("Weather in Tokyo");

    const watchOut = await registry.call("ActorWatch", vm, actor, { target: "test" });
    expect(String(watchOut)).toContain('"watch_state":"watched"');

    const statusOut = await registry.call("ActorStatus", vm, actor, { target: "test" });
    expect(String(statusOut)).toContain('"actor_type":"primary"');

    const unwatchOut = await registry.call("ActorUnwatch", vm, actor, { target: "test" });
    expect(String(unwatchOut)).toContain('"watch_state":"unwatched"');

    const attractionsOut = await registry.call("list_city_major_atractions", vm, actor, { city: "Beijing" });
    expect(String(attractionsOut)).toContain("Attractions in Beijing");

    const skillOut = await registry.call("Skill", vm, actor, { skill: "unknown" });
    expect(String(skillOut)).toContain("Error: Unknown skill");

    const subTaskOut = await registry.call("RunDelegateActor", vm, actor, {
      description: "test",
      prompt: "do work",
      agent_type: "code",
    });
    expect(String(subTaskOut)).toContain("Error: Unknown agent type");

    const unknownOut = await registry.call("not_exists", vm, actor, {});
    expect(unknownOut).toBe("Unknown tool: not_exists");

    const mcpSchema = {
      type: "function" as const,
      function: {
        name: "mcp__demo__ping",
        description: "Ping tool",
        parameters: { type: "object", properties: { x: { type: "number" } } },
      },
    };
    const mcpManager = {
      getOpenaiTools: () => [mcpSchema],
      callTool: async (name: string, args: any) => `mcp:${name}:${String(args?.x ?? "")}`,
    };

    vm.mcpManager = mcpManager as any;

    const mcpOut = await registry.call("mcp__demo__ping", vm, actor, { x: 7 });
    expect(mcpOut).toBe("mcp:mcp__demo__ping:7");
  });
});
