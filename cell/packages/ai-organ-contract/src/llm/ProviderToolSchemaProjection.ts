export type ProviderToolSchemaProtocol =
  | "openai-chat"
  | "deepseek-chat"
  | "openai-responses";

export type ProviderSchemaDigest = `sha256:${string}`;

export type ProviderSchemaFact = Readonly<{
  factId: ProviderSchemaDigest;
  kind: string;
  path: string;
  valueDigest: ProviderSchemaDigest;
  authoredBranchIndex?: number;
}>;

export type ProviderSchemaTransformationFact = Readonly<{
  ruleId: string;
  ruleVersion: string;
  consumedFactIds: readonly ProviderSchemaDigest[];
  producedFactIds: readonly ProviderSchemaDigest[];
}>;

export type ProviderToolSchemaCoverageReceipt = Readonly<{
  schemaVersion: "provider.tool-schema-coverage/v1";
  protocol: ProviderToolSchemaProtocol;
  projectorRuleSetId: string;
  status: "exact" | "compatible";
  sourceToolIds: readonly string[];
  emittedToolIds: readonly string[];
  sourceFactSetDigest: ProviderSchemaDigest;
  emittedFactSetDigest: ProviderSchemaDigest;
  sourceFactCount: number;
  emittedFactCount: number;
  transformations: readonly ProviderSchemaTransformationFact[];
}>;

export type AcceptedProviderToolSchemaProjection = Readonly<{
  protocol: ProviderToolSchemaProtocol;
  projectorRuleSetId: string;
  tools: readonly any[];
  receipt: ProviderToolSchemaCoverageReceipt;
}>;

export type ProviderToolSchemaProjectionRejection = Readonly<{
  code:
    | "duplicate_tool_identity"
    | "invalid_tool_declaration"
    | "non_json_schema_value"
    | "non_object_parameters_root"
    | "unaccounted_schema_fact";
  protocol: ProviderToolSchemaProtocol;
  toolId?: string;
  path?: string;
}>;

export type ProviderToolSchemaProjectionResult =
  | Readonly<{ ok: true; projection: AcceptedProviderToolSchemaProjection }>
  | Readonly<{ ok: false; rejection: ProviderToolSchemaProjectionRejection }>;

export type ProviderRequestAdmissionRejectionCode =
  | "invalid_provider_request_body"
  | "invalid_tool_schema_projection_authority"
  | "serialized_tools_mismatch"
  | "invalid_admitted_request"
  | "serialized_body_digest_mismatch"
  | "tool_schema_projection_protocol_mismatch";

export type ProviderToolSchemaProjector = Readonly<{
  protocol: ProviderToolSchemaProtocol;
  ruleSetId: string;
  project: (tools: readonly unknown[]) => ProviderToolSchemaProjectionResult;
}>;

/** Opaque runtime authority. Only ai-organ-logic can create authentic values. */
export declare const providerToolSchemaProjectionAuthorityBrand: unique symbol;
export type ProviderToolSchemaProjectionAuthority = Readonly<{
  readonly [providerToolSchemaProjectionAuthorityBrand]: true;
}>;

/** Opaque transport-attempt capability. Only the coverage gate can create it. */
export declare const admittedProviderRequestBrand: unique symbol;
export type AdmittedProviderRequest = Readonly<{
  readonly [admittedProviderRequestBrand]: true;
}>;

export type AdmittedProviderRequestPreview = Readonly<{
  protocol: ProviderToolSchemaProtocol;
  projectorRuleSetId: string;
  emittedToolsDigest: ProviderSchemaDigest;
  serializedBodyDigest: ProviderSchemaDigest;
  coverage: ProviderToolSchemaCoverageReceipt;
}>;

export type ProviderToolSchemaCoverageObservation = Readonly<{
  schemaVersion: "provider.tool-schema-coverage-observation/v1";
  protocol: ProviderToolSchemaProtocol;
  projectorRuleSetId: string;
  status: "exact" | "compatible";
  sourceToolCount: number;
  emittedToolCount: number;
  sourceFactCount: number;
  emittedFactCount: number;
  sourceFactSetDigest: ProviderSchemaDigest;
  emittedFactSetDigest: ProviderSchemaDigest;
  emittedToolsDigest: ProviderSchemaDigest;
  serializedBodyDigest: ProviderSchemaDigest;
  transformationRuleIds: readonly string[];
}>;
