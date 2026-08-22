import { createHash } from "node:crypto";

import type {
  ProviderSchemaDigest,
  ProviderSchemaFact,
} from "@cell/ai-organ-contract/llm/ProviderToolSchemaProjection";

export class ProviderSchemaValueError extends Error {
  constructor(readonly path: string) {
    super(`non_json_schema_value:${path}`);
    this.name = "ProviderSchemaValueError";
  }
}

export function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function digest(domain: string, value: string): ProviderSchemaDigest {
  return `sha256:${createHash("sha256").update(domain).update("\0").update(value).digest("hex")}`;
}

function pointerSegment(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function cloneJsonAuthority(value: unknown, path = "$"): any {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ProviderSchemaValueError(path);
    return value;
  }
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors).filter((key) => key !== "length");
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
      throw new ProviderSchemaValueError(path);
    }
    return keys.map((key) => {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
        throw new ProviderSchemaValueError(`${path}/${key}`);
      }
      return cloneJsonAuthority(descriptor.value, `${path}/${key}`);
    });
  }
  if (!value || typeof value !== "object" || !isPlainObject(value)) {
    throw new ProviderSchemaValueError(path);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) throw new ProviderSchemaValueError(path);
  const output: Record<string, unknown> = Object.create(null);
  const keys = Object.keys(value).sort(codeUnitCompare);
  if (Object.getOwnPropertyNames(value).length !== keys.length) {
    throw new ProviderSchemaValueError(path);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new ProviderSchemaValueError(`${path}/${pointerSegment(key)}`);
    }
    if (descriptor.value === undefined || typeof descriptor.value === "function" || typeof descriptor.value === "symbol" || typeof descriptor.value === "bigint") {
      throw new ProviderSchemaValueError(`${path}/${pointerSegment(key)}`);
    }
    output[key] = cloneJsonAuthority(descriptor.value, `${path}/${pointerSegment(key)}`);
  }
  return output;
}

function normalizeForDigest(value: any, parentKeyword?: string): any {
  if (Array.isArray(value)) {
    const normalized = value.map((item) => normalizeForDigest(item));
    if (parentKeyword === "required" || parentKeyword === "enum") {
      return normalized.sort((left, right) => codeUnitCompare(stableJson(left), stableJson(right)));
    }
    return normalized;
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value).sort(codeUnitCompare)) {
      output[key] = normalizeForDigest(value[key], key);
    }
    return output;
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(normalizeForDigest(cloneJsonAuthority(value)));
}

export function stableDigest(domain: string, value: unknown): ProviderSchemaDigest {
  return digest(domain, stableJson(value));
}

function factKind(value: any, parentKeyword?: string): string {
  if (Array.isArray(value)) return parentKeyword === "oneOf" ? "authored-branch-list" : "array";
  if (value === null) return "null";
  if (typeof value === "object") return "object";
  return typeof value;
}

export function collectSchemaFacts(toolId: string, schema: unknown): readonly ProviderSchemaFact[] {
  const root = cloneJsonAuthority(schema, `/tools/${pointerSegment(toolId)}/parameters`);
  const facts: ProviderSchemaFact[] = [];
  const visit = (value: any, path: string, parentKeyword?: string, authoredBranchIndex?: number) => {
    const kind = factKind(value, parentKeyword);
    const valueDigest = stableDigest("provider-schema-fact-value/v1", normalizeForDigest(value, parentKeyword));
    const factId = digest("provider-schema-fact-id/v1", JSON.stringify([toolId, kind, path, valueDigest, authoredBranchIndex ?? null]));
    facts.push(Object.freeze({
      factId,
      kind,
      path,
      valueDigest,
      ...(authoredBranchIndex === undefined ? {} : { authoredBranchIndex }),
    }));
    if (Array.isArray(value)) {
      const ordered = parentKeyword === "required" || parentKeyword === "enum"
        ? [...value].sort((left, right) => codeUnitCompare(stableJson(left), stableJson(right)))
        : value;
      ordered.forEach((item, index) => visit(
        item,
        `${path}/${index}`,
        undefined,
        parentKeyword === "oneOf" ? index : undefined,
      ));
      return;
    }
    if (value && typeof value === "object") {
      for (const key of Object.keys(value).sort(codeUnitCompare)) {
        visit(value[key], `${path}/${pointerSegment(key)}`, key);
      }
    }
  };
  visit(root, `/tools/${pointerSegment(toolId)}/parameters`);
  return Object.freeze(facts.sort((left, right) => codeUnitCompare(left.factId, right.factId)));
}

export function factSetDigest(facts: readonly ProviderSchemaFact[]): ProviderSchemaDigest {
  return digest("provider-schema-fact-set/v1", JSON.stringify(facts.map((fact) => fact.factId).sort(codeUnitCompare)));
}
