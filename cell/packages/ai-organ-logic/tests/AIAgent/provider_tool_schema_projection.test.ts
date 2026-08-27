import { describe, expect, it } from "bun:test";

import {
  deepSeekChatToolSchemaProjector,
  openAIChatToolSchemaProjector,
} from "@cell/ai-organ-logic/llm/tool-schema/ChatToolSchemaProjectors";
import { openAIResponsesToolSchemaProjector } from "@cell/ai-organ-logic/llm/tool-schema/OpenAIResponsesToolSchemaProjector";
import {
  admitProviderRequest,
  ProviderRequestAdmissionError,
  prepareProviderToolSchemaProjection,
  readAdmittedProviderRequest,
  readProviderToolSchemaProjection,
} from "@cell/ai-organ-logic/llm/tool-schema/ProviderRequestAdmission";
import { OpenAIResponsesNodejsFetchLlmAdapter } from "@cell/ai-organ-logic/llm/OpenAIResponsesNodejsFetchAdapter";
import { OpenAICompletionsNodejsFetchLlmAdapter } from "@cell/ai-organ-logic/llm/OpenAICompletionsNodejsFetchAdapter";
import { openAIOfficialChatEffectBundle } from "@cell/ai-organ-logic/llm/ChatCompletionsEffectBundles";

function canonicalTool(parameters: unknown = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["resource", "legacy"] },
  },
  required: ["mode"],
  additionalProperties: false,
  oneOf: [
    { type: "object", properties: { mode: { const: "resource" } } },
    { type: "object", properties: { mode: { const: "legacy" } } },
  ],
}) {
  return {
    type: "function",
    function: {
      name: "WorkflowOpenAuthoringSession",
      description: "Open authoring",
      parameters,
    },
  };
}

describe("provider tool-schema projection and admission", () => {
  it("keeps ordinary Chat and DeepSeek projections exact and provider-owned", () => {
    const source = [canonicalTool()];
    const openAI = prepareProviderToolSchemaProjection(openAIChatToolSchemaProjector, source);
    const deepSeek = prepareProviderToolSchemaProjection(deepSeekChatToolSchemaProjector, source);

    const openAIProjection = readProviderToolSchemaProjection(openAI);
    const deepSeekProjection = readProviderToolSchemaProjection(deepSeek);
    expect(openAIProjection.protocol).toBe("openai-chat");
    expect(deepSeekProjection.protocol).toBe("deepseek-chat");
    expect(openAIProjection.receipt.status).toBe("exact");
    expect(deepSeekProjection.receipt.status).toBe("exact");
    expect(deepSeekProjection.tools[0].function.parameters).toEqual(
      source[0].function.parameters,
    );
    expect(deepSeekProjection.receipt.sourceFactSetDigest).toBe(
      deepSeekProjection.receipt.emittedFactSetDigest,
    );
  });

  it("uses UTF-16 code-unit ordering for set identities and preserves authored branch order", () => {
    const names = ["😀", "Ä", "a", "Z"];
    const source = names.map((name, index) => ({
      ...canonicalTool({
        type: "object",
        oneOf: [{ const: `first-${index}` }, { const: `second-${index}` }],
      }),
      function: {
        ...canonicalTool().function,
        name,
        parameters: {
          type: "object",
          oneOf: [{ const: `first-${index}` }, { const: `second-${index}` }],
        },
      },
    }));
    const projection = readProviderToolSchemaProjection(
      prepareProviderToolSchemaProjection(openAIChatToolSchemaProjector, source),
    );

    expect(projection.receipt.sourceToolIds).toEqual(["Z", "a", "Ä", "😀"]);
    expect((projection.tools[0] as any).function.parameters.oneOf).toEqual([
      { const: "first-0" },
      { const: "second-0" },
    ]);
  });

  it("rejects a DeepSeek parameters schema without an object root", () => {
    expect(() => prepareProviderToolSchemaProjection(
      deepSeekChatToolSchemaProjector,
      [canonicalTool({ oneOf: [{ type: "object" }, { type: "object" }] })],
    )).toThrow("non_object_parameters_root");
  });

  it("proves nested values rather than paths alone", () => {
    const source = [canonicalTool()];
    const authority = prepareProviderToolSchemaProjection(openAIChatToolSchemaProjector, source);
    const projection = readProviderToolSchemaProjection(authority);
    const changed = structuredClone(projection.tools) as any[];
    changed[0].function.parameters.additionalProperties = true;

    expect(() => admitProviderRequest(authority, {
      model: "gpt-compatible",
      stream: true,
      tools: changed,
    })).toThrow("serialized_tools_mismatch");
  });

  it("rejects missing branches and extra emitted tools at the body boundary", () => {
    const authority = prepareProviderToolSchemaProjection(openAIChatToolSchemaProjector, [canonicalTool()]);
    const projected = structuredClone(readProviderToolSchemaProjection(authority).tools) as any[];
    projected[0].function.parameters.oneOf.pop();
    expect(() => admitProviderRequest(authority, { tools: projected }))
      .toThrow("serialized_tools_mismatch");

    const extra = structuredClone(readProviderToolSchemaProjection(authority).tools) as any[];
    extra.push({
      type: "function",
      function: {
        name: "UnexpectedTool",
        parameters: { type: "object", additionalProperties: false },
      },
    });
    expect(() => admitProviderRequest(authority, { tools: extra }))
      .toThrow("serialized_tools_mismatch");
  });

  it("rejects a present non-array tools field even when the canonical tool set is empty", () => {
    const authority = prepareProviderToolSchemaProjection(
      openAIChatToolSchemaProjector,
      [],
    );

    expect(() => admitProviderRequest(authority, { tools: "not-an-array" }))
      .toThrow("serialized_tools_mismatch");
  });

  it("keeps Responses compatibility explicit and isolated", () => {
    const authority = prepareProviderToolSchemaProjection(
      openAIResponsesToolSchemaProjector,
      [canonicalTool()],
    );
    const projection = readProviderToolSchemaProjection(authority);

    expect(projection.protocol).toBe("openai-responses");
    expect(projection.receipt.status).toBe("compatible");
    expect(projection.receipt.transformations).toEqual([
      expect.objectContaining({
        ruleId: "openai-responses.unsupported-composition-omission",
        ruleVersion: "1",
      }),
    ]);
    expect((projection.tools[0] as any).parameters).not.toHaveProperty("oneOf");
    expect((projection.tools[0] as any).parameters).toHaveProperty("type", "object");
  });

  it("creates an opaque request capability bound to fixed serialized bytes", () => {
    const source = [canonicalTool()];
    const authority = prepareProviderToolSchemaProjection(deepSeekChatToolSchemaProjector, source);
    const projectedTools = readProviderToolSchemaProjection(authority).tools;
    const body = { model: "deepseek-v4-flash", stream: true, tools: projectedTools };
    const admitted = admitProviderRequest(authority, body);
    body.model = "mutated-after-admission";
    (source[0].function.parameters as any).properties.mode.enum.push("mutated-source");

    const request = readAdmittedProviderRequest(admitted);
    const repeated = readAdmittedProviderRequest(admitProviderRequest(authority, {
      model: "deepseek-v4-flash",
      stream: true,
      tools: projectedTools,
    }));
    expect(JSON.parse(request.serializedBody).model).toBe("deepseek-v4-flash");
    expect(request.preview.serializedBodyDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(repeated.serializedBody).toBe(request.serializedBody);
    expect(repeated.preview).toEqual(request.preview);
    expect(repeated.coverageObservation).toEqual(request.coverageObservation);
    expect(Object.keys(request.coverageObservation).sort()).toEqual([
      "emittedFactCount",
      "emittedFactSetDigest",
      "emittedToolCount",
      "emittedToolsDigest",
      "projectorRuleSetId",
      "protocol",
      "schemaVersion",
      "serializedBodyDigest",
      "sourceFactCount",
      "sourceFactSetDigest",
      "sourceToolCount",
      "status",
      "transformationRuleIds",
    ]);
    expect(JSON.stringify(request.coverageObservation)).not.toContain("mutated-source");
    expect(() => readAdmittedProviderRequest({} as any)).toThrow("invalid_admitted_request");
  });

  it("rejects duplicate tool identities and non-JSON schema values", () => {
    expect(() => prepareProviderToolSchemaProjection(
      openAIChatToolSchemaProjector,
      [canonicalTool(), canonicalTool()],
    )).toThrow("duplicate_tool_identity");
    expect(() => prepareProviderToolSchemaProjection(
      openAIChatToolSchemaProjector,
      [canonicalTool({ type: "object", example: Number.NaN })],
    )).toThrow("non_json_schema_value");
  });

  it("rejects an incomplete or unknown transformation receipt", () => {
    const source = [canonicalTool()];
    const exact = openAIChatToolSchemaProjector.project(source);
    if (!exact.ok) throw new Error(exact.rejection.code);
    const incompleteProjector = {
      protocol: "openai-chat" as const,
      ruleSetId: "openai-chat.tool-schema/v1",
      project: () => ({
        ok: true as const,
        projection: {
          ...exact.projection,
          receipt: {
            ...exact.projection.receipt,
            status: "compatible" as const,
            transformations: [{
              ruleId: "unknown-rule",
              ruleVersion: "1",
              consumedFactIds: [],
              producedFactIds: [],
            }],
          },
        },
      }),
    };

    expect(() => prepareProviderToolSchemaProjection(incompleteProjector, source))
      .toThrow("unaccounted_schema_fact");
  });

  it("does not execute request-body accessors during admission", () => {
    const authority = prepareProviderToolSchemaProjection(openAIChatToolSchemaProjector, [canonicalTool()]);
    let getterCalls = 0;
    const body = Object.defineProperty({
      model: "gpt-compatible",
      tools: readProviderToolSchemaProjection(authority).tools,
    }, "extra", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "not-readable";
      },
    });

    let rejection: unknown;
    try {
      admitProviderRequest(authority, body);
    } catch (error) {
      rejection = error;
    }
    expect(rejection).toBeInstanceOf(ProviderRequestAdmissionError);
    expect(rejection).toMatchObject({
      code: "invalid_provider_request_body",
      diagnostic: {
        code: "invalid_provider_request_body",
        path: "$/extra",
        valueKind: "accessor",
      },
    });
    expect(getterCalls).toBe(0);

    const nonEnumerable = Object.defineProperty({
      model: "gpt-compatible",
      tools: readProviderToolSchemaProjection(authority).tools,
    }, "hidden", { value: true, enumerable: false });
    expect(() => admitProviderRequest(authority, nonEnumerable))
      .toThrow("invalid_provider_request_body");
  });

  it("rejects a Responses body tool override before request observation or fetch", async () => {
    let observations = 0;
    let fetches = 0;
    const adapter = new OpenAIResponsesNodejsFetchLlmAdapter({
      apiKey: "test-key",
      requestObserver: () => {
        observations += 1;
        return undefined;
      },
      providerOptions: {
        fetch: async () => {
          fetches += 1;
          return new Response("data: [DONE]\n\n", { status: 200 });
        },
      },
    });

    await expect(adapter.createStream({
      model: "gpt-5",
      messages: [{ role: "user", content: "hello" }],
      tools: [canonicalTool()] as any,
      extraBody: {
        tools: [{ type: "function", name: "replacement", parameters: { type: "object" } }],
      },
    })).rejects.toThrow("serialized_tools_mismatch");
    expect(observations).toBe(0);
    expect(fetches).toBe(0);
  });

  it("rejects a structural authority lookalike before Chat observation or fetch", async () => {
    let observations = 0;
    let fetches = 0;
    const adapter = new OpenAICompletionsNodejsFetchLlmAdapter({
      apiKey: "test-key",
      effectBundle: openAIOfficialChatEffectBundle,
      requestObserver: () => {
        observations += 1;
        return undefined;
      },
      providerOptions: {
        fetch: async () => {
          fetches += 1;
          return new Response("data: [DONE]\n\n", { status: 200 });
        },
      },
    });

    await expect(adapter.createAdmittedStream({
      model: "gpt-compatible",
      messages: [],
    }, Object.freeze({}) as any)).rejects.toThrow("invalid_tool_schema_projection_authority");
    expect(observations).toBe(0);
    expect(fetches).toBe(0);
  });
});
