import type {
  AgentContextFactPresentationRecipe,
  AgentContextFactPresentationRule,
} from "@cell/ai-core-contract/runtime/AgentContextFactPresentation";

function fail(reason: string): never {
  throw new Error(`AGENT_CONTEXT_FACT_PRESENTATION_INVALID: ${reason}`);
}

function ownObject(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain object`);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => typeof key !== "string" || !fields.includes(key))) {
    fail(`${label} must contain exactly ${fields.join(", ")}`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor) || !descriptor.enumerable) fail(`${label} requires enumerable own data`);
  }
  return value as Record<string, unknown>;
}

function ownArray(value: unknown, maximum: number, label: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) {
    fail(`${label} must be an array with at most ${maximum} entries`);
  }
  if (Reflect.ownKeys(value).length !== value.length + 1) fail(`${label} must be a dense plain array`);
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(`${label} requires enumerable own data`);
  }
  return value;
}

/** Closed, deterministic data usable by both the compiler adapter and pure projection. */
export function normalizeAgentContextFactPresentationRecipe(input: unknown): AgentContextFactPresentationRecipe {
  const recipe = ownObject(input, ["schemaVersion", "rules"], "recipe");
  if (recipe.schemaVersion !== "eidolon.context-fact-presentation/v1") fail("unsupported schemaVersion");
  const seenNamespaces = new Set<string>();
  const rules = ownArray(recipe.rules, 2, "rules").map((inputRule): AgentContextFactPresentationRule => {
    const rule = ownObject(inputRule, ["namespace", "payloadKeys", "jsonLayout"], "rule");
    if (rule.namespace !== "task-tree-context" && rule.namespace !== "workflow-stage-context") {
      fail("only task-tree-context and workflow-stage-context support presentation rules");
    }
    if (seenNamespaces.has(rule.namespace)) fail("duplicate namespace");
    seenNamespaces.add(rule.namespace);
    if (rule.jsonLayout !== "canonical" && rule.jsonLayout !== "pretty") fail("unsupported JSON layout");
    let payloadKeys: readonly string[] | null = null;
    if (rule.payloadKeys !== null) {
      const keys = ownArray(rule.payloadKeys, 64, "payloadKeys");
      if (keys.length === 0) fail("payloadKeys must select at least one field");
      const seen = new Set<string>();
      payloadKeys = Object.freeze(keys.map((key) => {
        if (typeof key !== "string" || !key.trim() || key !== key.trim() || key.length > 256) fail("payload key must be an exact non-empty string of at most 256 characters");
        if (seen.has(key)) fail("duplicate payload key");
        seen.add(key);
        return key;
      }).sort());
    }
    return Object.freeze({ namespace: rule.namespace, payloadKeys, jsonLayout: rule.jsonLayout });
  }).sort((left, right) => left.namespace < right.namespace ? -1 : left.namespace > right.namespace ? 1 : 0);
  return Object.freeze({ schemaVersion: "eidolon.context-fact-presentation/v1", rules: Object.freeze(rules) });
}
