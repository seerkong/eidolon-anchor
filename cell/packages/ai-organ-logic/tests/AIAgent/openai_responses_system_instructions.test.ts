import { afterEach, describe, expect, it } from "bun:test";

import {
  assembleOpenAIResponsesInstructions,
  buildOpenAIResponsesInstructionPlan,
  OpenAIResponsesNodejsFetchLlmAdapter,
} from "@cell/ai-organ-logic/llm";

function sse(events: readonly unknown[]): Response {
  return new Response(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
    {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    },
  );
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // Request observation is emitted immediately before the real fetch.
  }
}

const originalSandboxPermissions = (globalThis as any).__sandbox_permissions;

afterEach(() => {
  (globalThis as any).__sandbox_permissions = originalSandboxPermissions;
});

describe("OpenAI Responses materialized system instructions", () => {
  it("assembles fixed sections before materialized systems and removes exact duplicates", () => {
    expect(assembleOpenAIResponsesInstructions({
      transportInstructions: "transport instructions",
      sandboxInstructions: "sandbox instructions",
      configuredInstructions: "transport instructions",
      materializedMessages: [
        { role: "system", content: "sandbox instructions" },
        { role: "system", content: "first materialized system" },
        {
          role: "system",
          content: [{ type: "text", text: "second materialized system" }],
        },
        { role: "system", content: "first materialized system" },
        { role: "user", content: "not instructions" },
      ],
    })).toBe([
      "transport instructions",
      "sandbox instructions",
      "first materialized system",
      "second materialized system",
    ].join("\n\n"));
  });

  it("keeps stable instructions as an exact prefix of dynamic wire instructions", () => {
    const plan = buildOpenAIResponsesInstructionPlan({
      configuredInstructions: "provider configured instructions",
      stableSystemPrompts: ["stable actor system prompt"],
      messages: [
        { role: "system", content: "stable actor system prompt" },
        { role: "system", content: "runtime work context revision 2" },
        { role: "system", content: "mutable provider projection" },
        { role: "user", content: "continue" },
      ],
    });

    expect(plan.instructions.startsWith(plan.stableInstructions)).toBe(true);
    expect(plan.stableInstructions).toContain("stable actor system prompt");
    expect(plan.stableInstructions).not.toContain("runtime work context revision 2");
    expect(plan.stableInstructions).not.toContain("mutable provider projection");
  });

  it("sends configured and every materialized system-role text in materialization order", async () => {
    (globalThis as any).__sandbox_permissions = {
      sandbox_mode: "read-only",
      network_access: "disabled",
      approval_policy: "never",
    };
    let fetchedBody = "";
    let observedBody: unknown;
    const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      requestObserver: (observation) => {
        observedBody = observation.requestBody;
      },
      providerOptions: {
        fetch: async (_url: unknown, init: any) => {
          fetchedBody = String(init.body);
          return sse([
            {
              type: "response.completed",
              response: { id: "resp_system", output: [] },
            },
          ]);
        },
      },
    });

    const result = await adapter.createStream({
      model: "gpt-5.5",
      messages: [
        { role: "system", content: "kernel system prompt" },
        { role: "system", content: "runtime work context" },
        { role: "system", content: "dynamic context overlay" },
        { role: "system", content: "actor system prompt" },
        { role: "user", content: "continue" },
      ],
      tools: [],
      extraBody: { instructions: "provider configured instructions" },
    });
    await drain(result.stream);

    expect(observedBody).toBe(fetchedBody);
    const body = JSON.parse(fetchedBody);
    const instructions = String(body.instructions);
    const orderedSections = [
      "provider configured instructions",
      "kernel system prompt",
      "runtime work context",
      "dynamic context overlay",
      "actor system prompt",
    ];
    let previousIndex = -1;
    for (const section of orderedSections) {
      const index = instructions.indexOf(section);
      expect(index).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
    expect(body.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "continue" }],
      },
    ]);
  });
});
