import type {
  AcceptedProviderToolSchemaProjection,
  ProviderSchemaFact,
  ProviderToolSchemaCoverageReceipt,
  ProviderToolSchemaProjectionResult,
  ProviderToolSchemaProjector,
} from "@cell/ai-organ-contract/llm/ProviderToolSchemaProjection";
import {
  cloneJsonAuthority,
  codeUnitCompare,
  collectSchemaFacts,
  factSetDigest,
  ProviderSchemaValueError,
} from "./CanonicalSchemaFacts";
import { internalChatToolProjection } from "./ChatToolSchemaProjectors";

const UNSUPPORTED_COMPOSITION_KEYS = new Set(["allOf", "anyOf", "not", "oneOf"]);

function stripResponsesComposition(value: any): any {
  if (Array.isArray(value)) return value.map(stripResponsesComposition);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value).sort(codeUnitCompare)) {
    if (UNSUPPORTED_COMPOSITION_KEYS.has(key)) continue;
    output[key] = stripResponsesComposition(value[key]);
  }
  return output;
}

export const openAIResponsesToolSchemaProjector: ProviderToolSchemaProjector = Object.freeze({
  protocol: "openai-responses",
  ruleSetId: "openai-responses.tool-schema/v1",
  project(rawTools): ProviderToolSchemaProjectionResult {
    const source = internalChatToolProjection.readChatTools("openai-responses", rawTools);
    if ("ok" in source) return source;
    try {
      const emittedTools = source.tools.map((tool) => internalChatToolProjection.deepFreeze({
        type: "function",
        name: tool.function.name,
        ...(tool.function.description === undefined
          ? {}
          : { description: tool.function.description }),
        strict: false,
        parameters: stripResponsesComposition(cloneJsonAuthority(tool.function.parameters)),
      }));
      const emittedFacts: ProviderSchemaFact[] = [];
      for (const tool of emittedTools) emittedFacts.push(...collectSchemaFacts(tool.name, tool.parameters));
      emittedFacts.sort((left, right) => codeUnitCompare(left.factId, right.factId));
      const sourceIds = new Set(source.facts.map((fact) => fact.factId));
      const emittedIds = new Set(emittedFacts.map((fact) => fact.factId));
      const consumed = source.facts.filter((fact) => !emittedIds.has(fact.factId)).map((fact) => fact.factId);
      const produced = emittedFacts.filter((fact) => !sourceIds.has(fact.factId)).map((fact) => fact.factId);
      const changed = consumed.length > 0 || produced.length > 0;
      const receipt: ProviderToolSchemaCoverageReceipt = internalChatToolProjection.deepFreeze({
        schemaVersion: "provider.tool-schema-coverage/v1",
        protocol: "openai-responses",
        projectorRuleSetId: "openai-responses.tool-schema/v1",
        status: changed ? "compatible" : "exact",
        sourceToolIds: source.ids,
        emittedToolIds: source.ids,
        sourceFactSetDigest: factSetDigest(source.facts),
        emittedFactSetDigest: factSetDigest(emittedFacts),
        sourceFactCount: source.facts.length,
        emittedFactCount: emittedFacts.length,
        transformations: changed ? [Object.freeze({
          ruleId: "openai-responses.unsupported-composition-omission",
          ruleVersion: "1",
          consumedFactIds: Object.freeze(consumed.sort(codeUnitCompare)),
          producedFactIds: Object.freeze(produced.sort(codeUnitCompare)),
        })] : [],
      });
      const projection: AcceptedProviderToolSchemaProjection = internalChatToolProjection.deepFreeze({
        protocol: "openai-responses",
        projectorRuleSetId: "openai-responses.tool-schema/v1",
        tools: Object.freeze(emittedTools),
        receipt,
      });
      return { ok: true, projection };
    } catch (error) {
      if (error instanceof ProviderSchemaValueError) {
        return internalChatToolProjection.reject("openai-responses", "non_json_schema_value", undefined, error.path);
      }
      throw error;
    }
  },
});
