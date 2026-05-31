import { describe, expect, it } from "bun:test";

import { ToolFuncRegistry, createActor, createVM } from "@cell/ai-core-logic";
import { buildBuiltinToolDefs } from "@cell/ai-organ-logic/composer/AIAgent/ToolFuncBuiltin";
import { aiAgentLoopStreaming } from "@cell/ai-organ-logic/exec/AiAgentExecutor";

function makeMockAdapter() {
  return {
    type: "openai" as const,
    async createStream() {
      async function* stream() {
        yield { ok: true };
      }
      return { stream: stream() };
    },
  };
}

describe("heartbeat built-in tools", () => {
  it("registers create/list/cancel schedule tools", () => {
    const names = buildBuiltinToolDefs({ includeInternalOnly: false }).map((def) => def.schema.function.name);
    expect(names).toContain("create_timeout");
    expect(names).toContain("create_interval");
    expect(names).toContain("list_schedules");
    expect(names).toContain("cancel_schedule");
  });

  it("creates, lists, and cancels heartbeat schedules through ToolFuncRegistry", async () => {
    const registry = new ToolFuncRegistry();
    registry.registerMany(buildBuiltinToolDefs({ includeInternalOnly: false }));
    const actor = createActor({ key: "main", id: "actor-main" });
    const vm = createVM({ controlActorKey: actor.key, actors: { [actor.key]: actor }, registries: { toolRegistry: registry } });

    const created = await registry.call("create_timeout", vm, actor, {
      name: "check-build",
      description: "Check build.log once and report whether the process completed.",
      delay_seconds: 60,
      message: "Check build",
      payload: { logFile: "build.log" },
    }) as any;

    expect(created.status).toBe("created");
    expect(created.kind).toBe("timeout");
    expect(created.schedule_id).toMatch(/^sch_/);
    expect(created.next_fire_at).toBeTruthy();

    const listed = await registry.call("list_schedules", vm, actor, {}) as any;
    expect(listed.schedules).toHaveLength(1);
    expect(listed.schedules[0].schedule_id).toBe(created.schedule_id);
    expect(listed.schedules[0].name).toBe("check-build");

    const cancelled = await registry.call("cancel_schedule", vm, actor, {
      schedule_id: created.schedule_id,
      reason: "done",
    }) as any;
    expect(cancelled.status).toBe("cancelled");

    const afterCancel = await registry.call("list_schedules", vm, actor, {}) as any;
    expect(afterCancel.schedules).toEqual([]);
  });

  it("defensively rejects stale create tool calls when actor policy disables them", async () => {
    const registry = new ToolFuncRegistry();
    const defs = buildBuiltinToolDefs({ includeInternalOnly: false });
    registry.registerMany(defs);
    const createTimeoutDef = defs.find((def) => def.schema.function.name === "create_timeout");
    expect(createTimeoutDef).toBeTruthy();
    const actor = createActor({
      key: "main",
      id: "actor-main",
      llmClient: makeMockAdapter(),
      modelConfig: { model: "mock" },
      ctrlOptions: { exitAfterToolResult: true },
      toolPolicy: { computedDisabledTools: ["create_timeout"] },
      callbacks: {
        buildToolset: () => createTimeoutDef ? [createTimeoutDef.schema] : [],
        processStream: async () => ({
          role: "assistant",
          tool_calls: [
            {
              id: "tc-heartbeat",
              function: {
                name: "create_timeout",
                arguments: JSON.stringify({
                  name: "check-build",
                  description: "Check build.log once and report whether the process completed.",
                  delay_seconds: 60,
                  message: "Check build",
                }),
              },
            },
          ],
        }),
      },
    });
    const vm = createVM({ controlActorKey: actor.key, actors: { [actor.key]: actor }, registries: { toolRegistry: registry } });

    const result = await aiAgentLoopStreaming({ vm, actor, messages: [] });
    const toolMsg = result.messages.find((m: any) => m?.role === "tool" && m?.tool_call_id === "tc-heartbeat");
    expect(String(toolMsg?.content ?? "")).toContain("policy violation");
    expect(await registry.call("list_schedules", vm, actor, {})).toEqual({ schedules: [] });
  });
});
