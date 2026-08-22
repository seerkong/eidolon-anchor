import type {
  AcceptedProviderToolSchemaProjection,
  ProviderSchemaFact,
  ProviderToolSchemaCoverageReceipt,
  ProviderToolSchemaProjectionRejection,
  ProviderToolSchemaProjectionResult,
  ProviderToolSchemaProjector,
  ProviderToolSchemaProtocol,
} from "@cell/ai-organ-contract/llm/ProviderToolSchemaProjection";
import {
  cloneJsonAuthority,
  codeUnitCompare,
  collectSchemaFacts,
  factSetDigest,
  ProviderSchemaValueError,
} from "./CanonicalSchemaFacts";

type ChatTool = {
  type: "function";
  function: { name: string; description?: string; parameters: unknown };
};

export class ProviderToolSchemaProjectionError extends Error {
  constructor(readonly rejection: ProviderToolSchemaProjectionRejection) {
    super(`${rejection.code}${rejection.toolId ? `:${rejection.toolId}` : ""}${rejection.path ? `:${rejection.path}` : ""}`);
    this.name = "ProviderToolSchemaProjectionError";
  }
}

function reject(
  protocol: ProviderToolSchemaProtocol,
  code: ProviderToolSchemaProjectionRejection["code"],
  toolId?: string,
  path?: string,
): ProviderToolSchemaProjectionResult {
  return { ok: false, rejection: Object.freeze({ code, protocol, ...(toolId ? { toolId } : {}), ...(path ? { path } : {}) }) };
}

function readChatTools(
  protocol: ProviderToolSchemaProtocol,
  tools: readonly unknown[],
): { tools: readonly ChatTool[]; ids: readonly string[]; facts: readonly ProviderSchemaFact[] } | ProviderToolSchemaProjectionResult {
  const output: ChatTool[] = [];
  const ids: string[] = [];
  const facts: ProviderSchemaFact[] = [];
  const seen = new Set<string>();
  try {
    for (const raw of tools) {
      const candidate = cloneJsonAuthority(raw) as any;
      const id = typeof candidate?.function?.name === "string" ? candidate.function.name : "";
      if (candidate?.type !== "function" || !id || !("parameters" in candidate.function)) {
        return reject(protocol, "invalid_tool_declaration", id || undefined);
      }
      if (seen.has(id)) return reject(protocol, "duplicate_tool_identity", id);
      seen.add(id);
      ids.push(id);
      output.push(candidate as ChatTool);
      facts.push(...collectSchemaFacts(id, candidate.function.parameters));
    }
  } catch (error) {
    if (error instanceof ProviderSchemaValueError) return reject(protocol, "non_json_schema_value", undefined, error.path);
    throw error;
  }
  return {
    tools: Object.freeze(output.map((tool) => deepFreeze(tool))),
    ids: Object.freeze(ids.sort(codeUnitCompare)),
    facts: Object.freeze(facts.sort((left, right) => codeUnitCompare(left.factId, right.factId))),
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function exactProjector(
  protocol: "openai-chat" | "deepseek-chat",
  ruleSetId: string,
  requireObjectRoot: boolean,
): ProviderToolSchemaProjector {
  return Object.freeze({
    protocol,
    ruleSetId,
    project(rawTools): ProviderToolSchemaProjectionResult {
      const source = readChatTools(protocol, rawTools);
      if ("ok" in source) return source;
      if (requireObjectRoot) {
        for (const tool of source.tools) {
          if ((tool.function.parameters as any)?.type !== "object") {
            return reject(protocol, "non_object_parameters_root", tool.function.name, `/tools/${tool.function.name}/parameters`);
          }
        }
      }
      const digest = factSetDigest(source.facts);
      const receipt: ProviderToolSchemaCoverageReceipt = deepFreeze({
        schemaVersion: "provider.tool-schema-coverage/v1",
        protocol,
        projectorRuleSetId: ruleSetId,
        status: "exact",
        sourceToolIds: source.ids,
        emittedToolIds: source.ids,
        sourceFactSetDigest: digest,
        emittedFactSetDigest: digest,
        sourceFactCount: source.facts.length,
        emittedFactCount: source.facts.length,
        transformations: [],
      });
      const projection: AcceptedProviderToolSchemaProjection = deepFreeze({
        protocol,
        projectorRuleSetId: ruleSetId,
        tools: source.tools,
        receipt,
      });
      return { ok: true, projection };
    },
  });
}

export const openAIChatToolSchemaProjector = exactProjector(
  "openai-chat",
  "openai-chat.tool-schema/v1",
  false,
);

export const deepSeekChatToolSchemaProjector = exactProjector(
  "deepseek-chat",
  "deepseek-chat.tool-schema/v1",
  true,
);

export const internalChatToolProjection = Object.freeze({
  readChatTools,
  deepFreeze,
  reject,
});
