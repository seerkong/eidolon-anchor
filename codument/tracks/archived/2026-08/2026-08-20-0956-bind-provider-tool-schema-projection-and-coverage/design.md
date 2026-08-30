# Design: provider-bound tool-schema projection and coverage

## 1. Authority boundary

The canonical `ToolDef` is the only semantic source for tool name, description, parameters, alternatives, required fields, and additional-property policy. Provider projections are derived request artifacts, never a second tool registry.

The configured provider driver selects an explicit protocol capsule. That capsule owns pure message and tool projection processors plus the request effect adapter:

```text
Canonical conversation + canonical ToolDefs
  -> ProviderDriverRegistry configured selection
  -> provider protocol capsule
       -> message projection processor
       -> tool-schema projection processor
       -> compatibility and coverage gate
       -> serialized provider request
  -> fetch / timeout / abort / stream effect
```

The generic fetch layer receives an already projected and gated body. It has no provider-name, model-name, URL, tool-name, or schema-keyword routing policy.

## 2. Incident path and canonical correction

The failing path is `ProviderRuntimeLlmAdapter -> ProviderDriverRegistry -> DeepSeekDriver -> deepSeekOfficialChatEffectBundle -> OpenAICompletionsNodejsFetchLlmAdapter`. It does not use the OpenAI Responses adapter.

`WorkflowOpenAuthoringSession` has two object alternatives. Its truthful canonical envelope is therefore an object with the existing `oneOf` alternatives. The canonical fix adds root `type: "object"` and preserves both branches byte-for-meaning: their required fields, enums, properties, and additional-property constraints remain intact.

This correction is provider-neutral. It is not evidence that DeepSeek rejects `oneOf`, and the DeepSeek projector must initially preserve `oneOf`. Any later DeepSeek-specific compatibility rewrite requires a reproducible provider contract and a new explicit coverage rule.

## 3. Projection contracts

Introduce a canonical schema-fact normalizer and a typed pure projection result equivalent to:

```ts
type CanonicalSchemaFact = {
  factId: string;
  kind: string;
  path: string;
  valueDigest: `sha256:${string}`;
  authoredBranchIndex?: number;
};

type ProviderToolSchemaProjectionResult =
  | { ok: true; projection: AcceptedProviderToolSchemaProjection }
  | { ok: false; rejection: ProviderToolSchemaProjectionRejection };

type AcceptedProviderToolSchemaProjection = {
  status: "exact" | "compatible";
  providerProtocol: "openai-chat" | "deepseek-chat" | "openai-responses";
  projectorRuleSetId: string;
  tools: readonly ProviderToolDeclaration[];
  coverage: ProviderToolSchemaCoverageReceipt;
};

type ProviderToolSchemaCoverageReceipt = {
  schemaVersion: "provider.tool-schema-coverage/v1";
  sourceToolIds: readonly string[];
  emittedToolIds: readonly string[];
  sourceFactSetDigest: `sha256:${string}`;
  emittedFactSetDigest: `sha256:${string}`;
  sourceFactCount: number;
  emittedFactCount: number;
  transformations: readonly ProviderSchemaTransformationFact[];
};

type ProviderSchemaTransformationFact = {
  ruleId: string;
  ruleVersion: string;
  consumedFactIds: readonly string[];
  producedFactIds: readonly string[];
};

declare const admittedProviderRequestBrand: unique symbol;

type AdmittedProviderRequest = {
  readonly [admittedProviderRequestBrand]: true;
  // Opaque outside the gate/transport module. Public readers receive only a
  // bounded immutable preview; transport reads gate-owned fixed bytes.
};

type AdmittedProviderRequestPreview = {
  providerProtocol: AcceptedProviderToolSchemaProjection["providerProtocol"];
  projectorRuleSetId: string;
  emittedToolsDigest: `sha256:${string}`;
  serializedBodyDigest: `sha256:${string}`;
  coverage: ProviderToolSchemaCoverageReceipt;
};
```

Production names may follow repository conventions, but the invariants are fixed:

- the result is a plain immutable data projection;
- every schema keyword, scalar, object-member set, required member, enum member, additional-property policy, and branch is normalized as a `kind/path/valueDigest` fact; branch facts preserve authored index/identity;
- identities, fact IDs, and normalized paths use deterministic UTF-16 code-unit ordering where they are sets;
- authored branch order is preserved where order is semantic;
- exact projection proves a source/emitted fact double-entry mapping with equal value digests;
- every compatible transformation is typed, versioned, evidence-owned, and bound to exact consumed and produced fact IDs/digests;
- the receipt contains no prompt, reasoning, credential, raw configuration, or tool-result body;
- an unsupported or unaccounted transformation returns the rejection branch and no provider request body;
- `compatible` is a successful state only when all changed facts are consumed and produced by versioned rules; `rejected` is never a success status.
- the admitted-request constructor is private to the coverage gate and records runtime authenticity; structural lookalikes are rejected;
- exact serialized bytes are copied into gate-owned immutable storage and bound by `serializedBodyDigest`; callers never receive a mutable authority view.

## 4. Provider ownership

### OpenAI Chat

The OpenAI Chat effect bundle owns an explicit OpenAI Chat projector. Its initial behavior preserves currently accepted schemas. It cannot import DeepSeek policy.

### DeepSeek Chat

The DeepSeek driver continues to select `deepSeekOfficialChatEffectBundle`. That bundle owns a DeepSeek tool-schema projector. The projector validates an object-root function parameters schema and preserves the canonical alternatives and constraints unless an evidenced DeepSeek compatibility rule says otherwise.

### OpenAI Responses

Responses retains an independent projector owner. Existing Responses compatibility behavior must be expressed behind that owner rather than reused as a generic Chat schema sanitizer. Responses code must not be placed on the DeepSeek or ordinary Chat path.

The selected driver prepares exactly one opaque `ToolSchemaProjectionAuthority` for a provider call. Request preview and every retry/transport attempt reuse that same authority, so tools are never projected again or by another dialect owner. Each concrete HTTP/WebSocket body is then admitted separately because Responses continuation and fallback can legitimately materialize different bodies. The coverage gate alone creates an opaque `AdmittedProviderRequest` for that attempt, privately binding provider protocol, projector rule-set identity, emitted-tools digest, coverage receipt, exact serialized bytes, and serialized-body digest. Immediately before the existing request observation and I/O, transport verifies capability authenticity and byte digest, then sends those exact bytes. A structural lookalike or post-admission mutation cannot cross the effect boundary.

## 5. Coverage and send-before gate

Coverage is distinct from conversation function-call/output coverage. The gate proves declaration projection before the provider request effect:

1. Every canonical tool identity appears exactly once in the source fact set.
2. Every emitted tool identity maps to exactly one canonical identity; no canonical identity silently disappears.
3. Every canonical schema fact has an equal emitted fact, or is consumed by one versioned compatibility rule whose produced facts are all accounted for.
4. The serialized body tools digest equals the emitted declarations, and the exact serialized bytes equal the serialized-body digest privately bound into the admitted capability.
5. Duplicate identities, missing branches, extra emitted tools, unknown transformations, or body/receipt mismatch reject before request observation and network send.

The coverage gate is a pure processor plus a private capability factory. Fetch, timeout, abort, and stream parsing remain effects. This Track adds bounded coverage metadata to the established final-wire request observation; it does not remove or redact the existing observation's requestBody/messages/tools facts. Coverage metadata itself contains only identities, counts, digests, status, and versioned transformation facts.

## 6. Execution phases

### P1 — Canonical contract and boundary baseline

Characterize the exact failing request path, add the truthful canonical object root, and establish boundary tests that preserve both authoring-session alternatives. Record the current missing projection/coverage seam as the initial failing baseline.

### P2 — Provider-specific projection compilers

Add canonical schema-fact normalization, the closed result contract, one prepared tool-projection authority per provider call, per-transport-attempt admitted-request artifacts, and explicit projectors for OpenAI Chat, DeepSeek Chat, and Responses. Bind them through configured driver/effect-bundle selection. Remove any need for generic fetch-time schema policy without changing unrelated request behavior.

### P3 — Coverage gate and request admission

Generate the bounded coverage receipt from the complete internal fact relation, compare emitted-tools digest to each concrete serialized body's tools, and reject incomplete or unsupported projection before provider observation or I/O. Ensure preview and real attempts reuse the same prepared tool-projection authority; each distinct transport body receives its own admitted-request capability.

### P4 — Cross-provider verification

Verify the real workflow tool schema on the DeepSeek request body, ordinary OpenAI compatibility, Responses isolation, deterministic receipts, and static authority boundaries. Reproduce the original session shape without exposing provider secrets. Run the terminal coding AttractorCheck after all implementation gates.

## 7. Failure model

Projection failures are stable domain diagnostics carrying provider protocol, canonical tool identity, exact schema path, and reason code. They do not contain raw schema values, prompts, reasoning, credentials, or provider configuration. On rejection, provider request observation and network invocation counts remain zero.

## 8. Compatibility and migration

This is an additive contract at the provider capsule boundary. Existing canonical tool definitions remain valid. The authoring tool receives a truthful root type without branch loss. No runtime selection fallback is introduced. Existing OpenAI Chat and Responses fixtures must remain green, with new tests proving their tool-schema policy owners are separate from DeepSeek.
