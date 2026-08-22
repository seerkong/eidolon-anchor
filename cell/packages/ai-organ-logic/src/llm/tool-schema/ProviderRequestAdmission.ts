import { createHash } from "node:crypto";

import type {
  AcceptedProviderToolSchemaProjection,
  AdmittedProviderRequest,
  AdmittedProviderRequestPreview,
  ProviderSchemaDigest,
  ProviderRequestAdmissionRejectionCode,
  ProviderToolSchemaCoverageObservation,
  ProviderToolSchemaProjectionAuthority,
  ProviderToolSchemaProjector,
} from "@cell/ai-organ-contract/llm/ProviderToolSchemaProjection";
import {
  cloneJsonAuthority,
  codeUnitCompare,
  collectSchemaFacts,
  factSetDigest,
  stableDigest,
} from "./CanonicalSchemaFacts";
import {
  internalChatToolProjection,
  ProviderToolSchemaProjectionError,
} from "./ChatToolSchemaProjectors";

type ProjectionSnapshot = Readonly<{
  projection: AcceptedProviderToolSchemaProjection;
  emittedToolsDigest: ProviderSchemaDigest;
}>;

type AdmittedSnapshot = Readonly<{
  serializedBody: string;
  preview: AdmittedProviderRequestPreview;
  coverageObservation: ProviderToolSchemaCoverageObservation;
}>;

const projectionAuthorities = new WeakMap<object, ProjectionSnapshot>();
const admittedRequests = new WeakMap<object, AdmittedSnapshot>();

export class ProviderRequestAdmissionError extends Error {
  constructor(readonly code: ProviderRequestAdmissionRejectionCode) {
    super(code);
    this.name = "ProviderRequestAdmissionError";
  }
}

export function assertProviderToolSchemaProtocol(
  actual: string,
  expected: string,
): void {
  if (actual !== expected) {
    throw new ProviderRequestAdmissionError("tool_schema_projection_protocol_mismatch");
  }
}

function sha256(value: string): ProviderSchemaDigest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const ALLOWED_TRANSFORMATIONS = new Map([
  [
    "openai-responses:openai-responses.unsupported-composition-omission@1",
    true,
  ],
]);

function sortedUnique(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort(codeUnitCompare));
}

function exactSequence(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateProjectionCoverage(
  projector: ProviderToolSchemaProjector,
  rawTools: readonly unknown[],
  projection: AcceptedProviderToolSchemaProjection,
): void {
  const source = internalChatToolProjection.readChatTools(projector.protocol, rawTools);
  if ("ok" in source) {
    if (source.ok === false) throw new ProviderToolSchemaProjectionError(source.rejection);
    throw new ProviderToolSchemaProjectionError({
      code: "unaccounted_schema_fact",
      protocol: projector.protocol,
    });
  }

  let emittedIds: readonly string[];
  let emittedFacts: readonly ReturnType<typeof collectSchemaFacts>[number][];
  if (projector.protocol === "openai-responses") {
    const ids: string[] = [];
    const facts: ReturnType<typeof collectSchemaFacts>[number][] = [];
    const seen = new Set<string>();
    for (const raw of projection.tools) {
      const tool = cloneJsonAuthority(raw) as Record<string, any>;
      const id = typeof tool.name === "string" ? tool.name : "";
      if (tool.type !== "function" || !id || !("parameters" in tool)) {
        throw new ProviderToolSchemaProjectionError({
          code: "invalid_tool_declaration",
          protocol: projector.protocol,
          ...(id ? { toolId: id } : {}),
        });
      }
      if (seen.has(id)) {
        throw new ProviderToolSchemaProjectionError({
          code: "duplicate_tool_identity",
          protocol: projector.protocol,
          toolId: id,
        });
      }
      seen.add(id);
      ids.push(id);
      facts.push(...collectSchemaFacts(id, tool.parameters));
    }
    emittedIds = sortedUnique(ids);
    emittedFacts = Object.freeze(facts.sort((left, right) => codeUnitCompare(left.factId, right.factId)));
  } else {
    const emitted = internalChatToolProjection.readChatTools(projector.protocol, projection.tools);
    if ("ok" in emitted) {
      if (emitted.ok === false) throw new ProviderToolSchemaProjectionError(emitted.rejection);
      throw new ProviderToolSchemaProjectionError({
        code: "unaccounted_schema_fact",
        protocol: projector.protocol,
      });
    }
    emittedIds = emitted.ids;
    emittedFacts = emitted.facts;
  }

  const receipt = projection.receipt;
  const sourceIds = sortedUnique(source.ids);
  if (
    receipt.protocol !== projector.protocol
    || receipt.projectorRuleSetId !== projector.ruleSetId
    || !exactSequence(sourceIds, receipt.sourceToolIds)
    || !exactSequence(emittedIds, receipt.emittedToolIds)
    || receipt.sourceFactCount !== source.facts.length
    || receipt.emittedFactCount !== emittedFacts.length
    || receipt.sourceFactSetDigest !== factSetDigest(source.facts)
    || receipt.emittedFactSetDigest !== factSetDigest(emittedFacts)
  ) {
    throw new ProviderToolSchemaProjectionError({
      code: "unaccounted_schema_fact",
      protocol: projector.protocol,
    });
  }

  const sourceFactIds = new Set(source.facts.map((fact) => fact.factId));
  const emittedFactIds = new Set(emittedFacts.map((fact) => fact.factId));
  const expectedConsumed = sortedUnique(
    [...sourceFactIds].filter((factId) => !emittedFactIds.has(factId)),
  );
  const expectedProduced = sortedUnique(
    [...emittedFactIds].filter((factId) => !sourceFactIds.has(factId)),
  );
  const consumed: string[] = [];
  const produced: string[] = [];
  const transformationKeys = new Set<string>();
  for (const transformation of receipt.transformations) {
    const key = `${projector.protocol}:${transformation.ruleId}@${transformation.ruleVersion}`;
    if (!ALLOWED_TRANSFORMATIONS.has(key) || transformationKeys.has(key)) {
      throw new ProviderToolSchemaProjectionError({
        code: "unaccounted_schema_fact",
        protocol: projector.protocol,
      });
    }
    transformationKeys.add(key);
    consumed.push(...transformation.consumedFactIds);
    produced.push(...transformation.producedFactIds);
  }
  const actualConsumed = sortedUnique(consumed);
  const actualProduced = sortedUnique(produced);
  const exactCoverage = expectedConsumed.length === 0 && expectedProduced.length === 0;
  if (
    !exactSequence(actualConsumed, expectedConsumed)
    || !exactSequence(actualProduced, expectedProduced)
    || (exactCoverage && (receipt.status !== "exact" || receipt.transformations.length !== 0))
    || (!exactCoverage && (receipt.status !== "compatible" || receipt.transformations.length === 0))
  ) {
    throw new ProviderToolSchemaProjectionError({
      code: "unaccounted_schema_fact",
      protocol: projector.protocol,
    });
  }
}

export function prepareProviderToolSchemaProjection(
  projector: ProviderToolSchemaProjector,
  tools: readonly unknown[],
): ProviderToolSchemaProjectionAuthority {
  const result = projector.project(tools);
  if (!result.ok) throw new ProviderToolSchemaProjectionError(result.rejection);
  validateProjectionCoverage(projector, tools, result.projection);
  const authority = Object.freeze({}) as ProviderToolSchemaProjectionAuthority;
  projectionAuthorities.set(authority, Object.freeze({
    projection: result.projection,
    emittedToolsDigest: stableDigest("provider-emitted-tools/v1", result.projection.tools),
  }));
  return authority;
}

function projectionSnapshot(authority: ProviderToolSchemaProjectionAuthority): ProjectionSnapshot {
  const snapshot = authority && typeof authority === "object" ? projectionAuthorities.get(authority as object) : undefined;
  if (!snapshot) {
    throw new ProviderRequestAdmissionError("invalid_tool_schema_projection_authority");
  }
  return snapshot;
}

export function readProviderToolSchemaProjection(
  authority: ProviderToolSchemaProjectionAuthority,
): AcceptedProviderToolSchemaProjection {
  return projectionSnapshot(authority).projection;
}

export function admitProviderRequest(
  authority: ProviderToolSchemaProjectionAuthority,
  body: unknown,
): AdmittedProviderRequest {
  const projection = projectionSnapshot(authority);
  let parsed: any;
  try {
    parsed = cloneJsonAuthority(body);
  } catch {
    throw new ProviderRequestAdmissionError("invalid_provider_request_body");
  }
  const serializedBody = JSON.stringify(parsed);
  if (typeof serializedBody !== "string") {
    throw new ProviderRequestAdmissionError("invalid_provider_request_body");
  }
  const hasTools = Object.prototype.hasOwnProperty.call(parsed, "tools");
  if (hasTools && !Array.isArray(parsed.tools)) {
    throw new ProviderRequestAdmissionError("serialized_tools_mismatch");
  }
  const observedTools = hasTools ? parsed.tools : [];
  const observedToolsDigest = stableDigest("provider-emitted-tools/v1", observedTools);
  if (observedToolsDigest !== projection.emittedToolsDigest) {
    throw new ProviderRequestAdmissionError("serialized_tools_mismatch");
  }
  const serializedBodyDigest = sha256(serializedBody);
  const preview: AdmittedProviderRequestPreview = Object.freeze({
    protocol: projection.projection.protocol,
    projectorRuleSetId: projection.projection.projectorRuleSetId,
    emittedToolsDigest: projection.emittedToolsDigest,
    serializedBodyDigest,
    coverage: projection.projection.receipt,
  });
  const transformationRuleIds = Object.freeze(
    projection.projection.receipt.transformations.map((fact) => `${fact.ruleId}@${fact.ruleVersion}`),
  );
  const coverageObservation: ProviderToolSchemaCoverageObservation = Object.freeze({
    schemaVersion: "provider.tool-schema-coverage-observation/v1",
    protocol: preview.protocol,
    projectorRuleSetId: preview.projectorRuleSetId,
    status: preview.coverage.status,
    sourceToolCount: preview.coverage.sourceToolIds.length,
    emittedToolCount: preview.coverage.emittedToolIds.length,
    sourceFactCount: preview.coverage.sourceFactCount,
    emittedFactCount: preview.coverage.emittedFactCount,
    sourceFactSetDigest: preview.coverage.sourceFactSetDigest,
    emittedFactSetDigest: preview.coverage.emittedFactSetDigest,
    emittedToolsDigest: preview.emittedToolsDigest,
    serializedBodyDigest,
    transformationRuleIds,
  });
  const admitted = Object.freeze({}) as AdmittedProviderRequest;
  admittedRequests.set(admitted, Object.freeze({ serializedBody, preview, coverageObservation }));
  return admitted;
}

export function readAdmittedProviderRequest(admitted: AdmittedProviderRequest): AdmittedSnapshot {
  const snapshot = admitted && typeof admitted === "object" ? admittedRequests.get(admitted as object) : undefined;
  if (!snapshot) throw new ProviderRequestAdmissionError("invalid_admitted_request");
  if (sha256(snapshot.serializedBody) !== snapshot.preview.serializedBodyDigest) {
    throw new ProviderRequestAdmissionError("serialized_body_digest_mismatch");
  }
  return snapshot;
}
