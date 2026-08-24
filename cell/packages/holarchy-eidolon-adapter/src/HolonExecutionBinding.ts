export const HOLON_EXECUTION_BINDING_KIND = "HolonExecutionBinding" as const
export const HOLON_EXECUTION_BINDING_KIND_DEFINITION_FQN =
  "Eidolon.AI.KindDefinition.HolonExecutionBinding" as const
export const HOLON_EXECUTION_BINDING_API_VERSION = "eidolon.ai/v1" as const
export const HOLON_EXECUTION_BINDING_KIND_DEFINITION_VERSION = "1.0.0" as const

export const HOLON_EXECUTION_BINDING_KIND_DEFINITION_SOURCE =
  `<KindDefinition #Eidolon.AI.KindDefinition.HolonExecutionBinding apiVersion="halfcode.resources/v1" version="1.0.0" {
  lifecycle = "Stable"
  resourceKind = "HolonExecutionBinding"
  sourceShapes = ["single-file"]
  currentApiVersion = "eidolon.ai/v1"
  supportedApiVersions = ["eidolon.ai/v1"]
  description = "Maps one frozen Holon Member or Role identity to an exact Eidolon execution adapter closure."
}>
` as const

export const HOLON_EXECUTION_BINDING_KIND_DEFINITION_BYTES: Readonly<Uint8Array> =
  new TextEncoder().encode(HOLON_EXECUTION_BINDING_KIND_DEFINITION_SOURCE)

export const HOLON_MEMBER_EXECUTION_ADAPTER_KINDS = Object.freeze([
  "ai-agent",
  "human-endpoint",
  "service",
  "hybrid",
] as const)

export type HolonExecutionResourceRef = `resource://${string}`

export type HolonExecutionTarget =
  | Readonly<{ readonly kind: "member"; readonly memberRef: string }>
  | Readonly<{ readonly kind: "role"; readonly roleRef: string }>

export type HolonMemberExecutionAdapter =
  | Readonly<{
      readonly kind: "ai-agent"
      readonly agentDefinitionRef: HolonExecutionResourceRef
      readonly runtimeProfileRef: HolonExecutionResourceRef
    }>
  | Readonly<{
      readonly kind: "human-endpoint"
      readonly humanEndpointRef: HolonExecutionResourceRef
      readonly inboxProfileRef: HolonExecutionResourceRef
    }>
  | Readonly<{
      readonly kind: "service"
      readonly serviceAdapterRef: HolonExecutionResourceRef
      readonly runtimeProfileRef: HolonExecutionResourceRef
    }>
  | Readonly<{
      readonly kind: "hybrid"
      readonly policyRef: HolonExecutionResourceRef
      readonly candidateBindingRefs: readonly [HolonExecutionResourceRef, ...HolonExecutionResourceRef[]]
    }>

export type HolonExecutionRuntimeIntent =
  | Readonly<{ readonly mode: "shared-member-runtime" }>
  | Readonly<{ readonly mode: "isolated-task-runtime" }>

export interface HolonExecutionPolicyV1 {
  readonly version: "1"
  readonly runtime: HolonExecutionRuntimeIntent
  readonly taskProfileRef: HolonExecutionResourceRef
  readonly capabilityRefs: readonly HolonExecutionResourceRef[]
  readonly toolRefs: readonly HolonExecutionResourceRef[]
  readonly materialRefs: readonly HolonExecutionResourceRef[]
}

export interface HolonExecutionBinding {
  readonly apiVersion: typeof HOLON_EXECUTION_BINDING_API_VERSION
  readonly kind: typeof HOLON_EXECUTION_BINDING_KIND
  readonly bindingRef: HolonExecutionResourceRef
  readonly snapshotRef: HolonExecutionResourceRef
  readonly target: HolonExecutionTarget
  readonly adapter: HolonMemberExecutionAdapter
  readonly policy: HolonExecutionPolicyV1
}

export interface HolonExecutionInvocation {
  readonly apiVersion: typeof HOLON_EXECUTION_BINDING_API_VERSION
  readonly kind: "HolonExecutionInvocation"
  readonly taskSpaceRef: string
  readonly taskRef: string
  readonly claimRef: string
  readonly invocationRef: string
  readonly targetBindingRef: HolonExecutionResourceRef
  readonly input: ClosedValue
  readonly materialRefs: readonly HolonExecutionResourceRef[]
  readonly resultContractRef: HolonExecutionResourceRef
}

interface ClosedArray extends ReadonlyArray<ClosedValue> {}
interface ClosedRecord { readonly [key: string]: ClosedValue }
export type ClosedValue = null | string | number | boolean | ClosedArray | ClosedRecord

export class HolonExecutionBindingContractError extends Error {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = "HolonExecutionBindingContractError"
  }
}

const invalid = (path: string, message: string): never => {
  throw new HolonExecutionBindingContractError(path, message)
}

const compareUtf16CodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

function closedObject(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(path, "Expected a plain object")
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(path, "Expected a plain object")
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  if (keys.some((key) => typeof key !== "string")) {
    return invalid(path, "Symbol properties are not allowed")
  }
  const result: Record<string, unknown> = Object.create(null)
  for (const key of (keys as string[]).sort(compareUtf16CodeUnits)) {
    const descriptor = descriptors[key]
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      return invalid(`${path}.${key}`, "Expected one enumerable own-data property")
    }
    result[key] = descriptor.value
  }
  return result
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  path: string,
): void {
  const expectedSet = new Set(expected)
  const extra = Object.keys(value).find((key) => !expectedSet.has(key))
  if (extra !== undefined) invalid(`${path}.${extra}`, "Unsupported field")
  const missing = expected.find((key) => !Object.prototype.hasOwnProperty.call(value, key))
  if (missing !== undefined) invalid(`${path}.${missing}`, "Required field is missing")
}

function exactString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    return invalid(path, "Expected an exact non-empty string")
  }
  return value
}

function exactLiteral<T extends string>(value: unknown, expected: T, path: string): T {
  if (value !== expected) invalid(path, `Expected '${expected}'`)
  return expected
}

function resourceRef(value: unknown, path: string): HolonExecutionResourceRef {
  const exact = exactString(value, path)
  const prefix = "resource://"
  if (!exact.startsWith(prefix)) invalid(path, "Expected an exact resource:// reference")
  const identity = exact.slice(prefix.length)
  if (!identity || identity.includes("://")) invalid(path, "Expected one exact Resource identity")
  return exact as HolonExecutionResourceRef
}

function denseArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return invalid(path, "Expected a plain dense array")
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      return invalid(`${path}[${index}]`, "Expected a dense enumerable own-data entry")
    }
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
      return invalid(path, "Symbol and extra array properties are not allowed")
    }
  }
  return value
}

function resourceRefs(
  value: unknown,
  path: string,
  options: { readonly nonEmpty?: boolean; readonly sort?: boolean } = {},
): readonly HolonExecutionResourceRef[] {
  const refs = denseArray(value, path).map((entry, index) => resourceRef(entry, `${path}[${index}]`))
  if (options.nonEmpty && refs.length === 0) invalid(path, "Expected at least one Resource reference")
  if (new Set(refs).size !== refs.length) invalid(path, "Resource reference list contains a duplicate")
  if (options.sort) refs.sort(compareUtf16CodeUnits)
  return Object.freeze(refs)
}

function target(value: unknown): HolonExecutionTarget {
  const record = closedObject(value, "$.target")
  const kind = exactString(record.kind, "$.target.kind")
  if (kind === "member") {
    exactKeys(record, ["kind", "memberRef"], "$.target")
    return Object.freeze({ kind, memberRef: exactString(record.memberRef, "$.target.memberRef") })
  }
  if (kind === "role") {
    exactKeys(record, ["kind", "roleRef"], "$.target")
    return Object.freeze({ kind, roleRef: exactString(record.roleRef, "$.target.roleRef") })
  }
  return invalid("$.target.kind", "Expected 'member' or 'role'")
}

function adapter(value: unknown): HolonMemberExecutionAdapter {
  const record = closedObject(value, "$.adapter")
  const kind = exactString(record.kind, "$.adapter.kind")
  if (kind === "ai-agent") {
    exactKeys(record, ["kind", "agentDefinitionRef", "runtimeProfileRef"], "$.adapter")
    return Object.freeze({
      kind,
      agentDefinitionRef: resourceRef(record.agentDefinitionRef, "$.adapter.agentDefinitionRef"),
      runtimeProfileRef: resourceRef(record.runtimeProfileRef, "$.adapter.runtimeProfileRef"),
    })
  }
  if (kind === "human-endpoint") {
    exactKeys(record, ["kind", "humanEndpointRef", "inboxProfileRef"], "$.adapter")
    return Object.freeze({
      kind,
      humanEndpointRef: resourceRef(record.humanEndpointRef, "$.adapter.humanEndpointRef"),
      inboxProfileRef: resourceRef(record.inboxProfileRef, "$.adapter.inboxProfileRef"),
    })
  }
  if (kind === "service") {
    exactKeys(record, ["kind", "serviceAdapterRef", "runtimeProfileRef"], "$.adapter")
    return Object.freeze({
      kind,
      serviceAdapterRef: resourceRef(record.serviceAdapterRef, "$.adapter.serviceAdapterRef"),
      runtimeProfileRef: resourceRef(record.runtimeProfileRef, "$.adapter.runtimeProfileRef"),
    })
  }
  if (kind === "hybrid") {
    exactKeys(record, ["kind", "policyRef", "candidateBindingRefs"], "$.adapter")
    const refs = resourceRefs(record.candidateBindingRefs, "$.adapter.candidateBindingRefs", { nonEmpty: true })
    return Object.freeze({
      kind,
      policyRef: resourceRef(record.policyRef, "$.adapter.policyRef"),
      candidateBindingRefs: refs as readonly [HolonExecutionResourceRef, ...HolonExecutionResourceRef[]],
    })
  }
  return invalid("$.adapter.kind", "Expected one closed execution adapter kind")
}

function policy(value: unknown): HolonExecutionPolicyV1 {
  const record = closedObject(value, "$.policy")
  exactKeys(record, [
    "version",
    "runtime",
    "taskProfileRef",
    "capabilityRefs",
    "toolRefs",
    "materialRefs",
  ], "$.policy")
  exactLiteral(record.version, "1", "$.policy.version")
  const runtime = closedObject(record.runtime, "$.policy.runtime")
  exactKeys(runtime, ["mode"], "$.policy.runtime")
  const mode = exactString(runtime.mode, "$.policy.runtime.mode")
  if (mode !== "shared-member-runtime" && mode !== "isolated-task-runtime") {
    invalid("$.policy.runtime.mode", "Expected one closed runtime intent")
  }
  const normalizedMode = mode as HolonExecutionRuntimeIntent["mode"]
  return Object.freeze({
    version: "1",
    runtime: Object.freeze({ mode: normalizedMode }),
    taskProfileRef: resourceRef(record.taskProfileRef, "$.policy.taskProfileRef"),
    capabilityRefs: resourceRefs(record.capabilityRefs, "$.policy.capabilityRefs", { sort: true }),
    toolRefs: resourceRefs(record.toolRefs, "$.policy.toolRefs", { sort: true }),
    materialRefs: resourceRefs(record.materialRefs, "$.policy.materialRefs", { sort: true }),
  })
}

export function normalizeHolonExecutionBinding(value: unknown): HolonExecutionBinding {
  const record = closedObject(value, "$")
  exactKeys(record, [
    "apiVersion",
    "kind",
    "bindingRef",
    "snapshotRef",
    "target",
    "adapter",
    "policy",
  ], "$")
  return Object.freeze({
    apiVersion: exactLiteral(record.apiVersion, HOLON_EXECUTION_BINDING_API_VERSION, "$.apiVersion"),
    kind: exactLiteral(record.kind, HOLON_EXECUTION_BINDING_KIND, "$.kind"),
    bindingRef: resourceRef(record.bindingRef, "$.bindingRef"),
    snapshotRef: resourceRef(record.snapshotRef, "$.snapshotRef"),
    target: target(record.target),
    adapter: adapter(record.adapter),
    policy: policy(record.policy),
  })
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

export function canonicalHolonExecutionBindingBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(normalizeHolonExecutionBinding(value)))
}

export function parseHolonExecutionBindingBytes(bytes: Uint8Array): HolonExecutionBinding {
  let decoded: string
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return invalid("$bytes", "Binding bytes are not valid UTF-8")
  }
  let value: unknown
  try {
    value = JSON.parse(decoded)
  } catch {
    return invalid("$bytes", "Binding bytes are not valid JSON")
  }
  const binding = normalizeHolonExecutionBinding(value)
  if (!sameBytes(bytes, canonicalHolonExecutionBindingBytes(binding))) {
    return invalid("$bytes", "Binding bytes are not canonical")
  }
  return binding
}

export function validateHolonExecutionBindingGraph(
  values: readonly HolonExecutionBinding[],
): readonly HolonExecutionBinding[] {
  const bindings = values.map(normalizeHolonExecutionBinding)
  const byRef = new Map<HolonExecutionResourceRef, HolonExecutionBinding>()
  for (const binding of bindings) {
    if (byRef.has(binding.bindingRef)) {
      invalid("$.bindings", `Duplicate binding identity '${binding.bindingRef}'`)
    }
    byRef.set(binding.bindingRef, binding)
  }
  const visiting = new Set<HolonExecutionResourceRef>()
  const visited = new Set<HolonExecutionResourceRef>()
  const visit = (bindingRef: HolonExecutionResourceRef): void => {
    if (visited.has(bindingRef)) return
    if (visiting.has(bindingRef)) invalid("$.bindings", `Hybrid binding cycle includes '${bindingRef}'`)
    const binding = byRef.get(bindingRef)
      ?? invalid("$.bindings", `Hybrid candidate '${bindingRef}' is unresolved`)
    visiting.add(bindingRef)
    if (binding.adapter.kind === "hybrid") {
      for (const candidateRef of binding.adapter.candidateBindingRefs) visit(candidateRef)
    }
    visiting.delete(bindingRef)
    visited.add(bindingRef)
  }
  for (const binding of bindings) visit(binding.bindingRef)
  return Object.freeze(bindings)
}

function cloneClosedValue(value: unknown, path: string, active = new Set<object>()): ClosedValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(path, "Expected a finite number")
    return value
  }
  if (typeof value !== "object") return invalid(path, "Expected JSON-compatible plain data")
  if (active.has(value)) return invalid(path, "Cycles are not allowed")
  active.add(value)
  try {
    if (Array.isArray(value)) {
      return Object.freeze(denseArray(value, path).map((entry, index) =>
        cloneClosedValue(entry, `${path}[${index}]`, active)))
    }
    const record = closedObject(value, path)
    const output: Record<string, ClosedValue> = Object.create(null)
    for (const key of Object.keys(record).sort(compareUtf16CodeUnits)) {
      output[key] = cloneClosedValue(record[key], `${path}.${key}`, active)
    }
    return Object.freeze(output)
  } finally {
    active.delete(value)
  }
}

export function normalizeHolonExecutionInvocation(value: unknown): HolonExecutionInvocation {
  const record = closedObject(value, "$")
  exactKeys(record, [
    "apiVersion",
    "kind",
    "taskSpaceRef",
    "taskRef",
    "claimRef",
    "invocationRef",
    "targetBindingRef",
    "input",
    "materialRefs",
    "resultContractRef",
  ], "$")
  return Object.freeze({
    apiVersion: exactLiteral(record.apiVersion, HOLON_EXECUTION_BINDING_API_VERSION, "$.apiVersion"),
    kind: exactLiteral(record.kind, "HolonExecutionInvocation", "$.kind"),
    taskSpaceRef: exactString(record.taskSpaceRef, "$.taskSpaceRef"),
    taskRef: exactString(record.taskRef, "$.taskRef"),
    claimRef: exactString(record.claimRef, "$.claimRef"),
    invocationRef: exactString(record.invocationRef, "$.invocationRef"),
    targetBindingRef: resourceRef(record.targetBindingRef, "$.targetBindingRef"),
    input: cloneClosedValue(record.input, "$.input"),
    materialRefs: resourceRefs(record.materialRefs, "$.materialRefs", { sort: true }),
    resultContractRef: resourceRef(record.resultContractRef, "$.resultContractRef"),
  })
}
