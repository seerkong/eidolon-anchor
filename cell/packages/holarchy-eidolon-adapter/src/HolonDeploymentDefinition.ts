import { HolarchyEidolonAdapterError } from "./HolarchyEidolonAdapterError"

export const HOLON_DEPLOYMENT_DEFINITION_SCHEMA_VERSION =
  "eidolon.holon-deployment-definition/v1" as const

export interface HolonDeploymentDefinitionFile {
  readonly path: string
  readonly digest: `sha256:${string}`
  readonly sizeBytes: number
}

export interface HolonDeploymentDefinition {
  readonly schemaVersion: typeof HOLON_DEPLOYMENT_DEFINITION_SCHEMA_VERSION
  readonly deploymentId: string
  readonly rootHolonRef: string
  readonly bindingRef: `resource://${string}`
  readonly snapshotRef: `resource://${string}`
  readonly registryRevision: string
  readonly snapshotTreeDigest: `sha256:${string}`
  readonly snapshotReceiptDigest: `sha256:${string}`
  readonly bindingBytesDigest: `sha256:${string}`
  readonly bindingSemanticFingerprint: `sha256:${string}`
  readonly files: readonly HolonDeploymentDefinitionFile[]
}

const REQUIRED_AUTHORITY_FILES = Object.freeze([
  "authority/execution-binding-freeze-receipt.json",
  "authority/execution-binding.json",
  "authority/organization-snapshot-receipt.json",
  "authority/organization-snapshot.json",
] as const)

const compareUtf16 = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

const invalid = (path: string, message: string): never => {
  throw new HolarchyEidolonAdapterError(
    "EIDOLON_HOLON_DEPLOYMENT_DEFINITION_INVALID",
    `${path}: ${message}`,
  )
}

function closedObject(value: unknown, location: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return invalid(location, "Expected a plain object")
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(location, "Expected a plain object")
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Reflect.ownKeys(descriptors)
  if (keys.some((key) => typeof key !== "string")) {
    return invalid(location, "Symbol properties are not allowed")
  }
  const result: Record<string, unknown> = Object.create(null)
  for (const key of keys as string[]) {
    const descriptor = descriptors[key]
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      return invalid(`${location}.${key}`, "Expected one enumerable own-data property")
    }
    result[key] = descriptor.value
  }
  return result
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  location: string,
): void {
  const expectedSet = new Set(expected)
  const extra = Object.keys(value).find((key) => !expectedSet.has(key))
  if (extra !== undefined) invalid(`${location}.${extra}`, "Unsupported field")
  const missing = expected.find((key) => !Object.prototype.hasOwnProperty.call(value, key))
  if (missing !== undefined) invalid(`${location}.${missing}`, "Required field is missing")
}

function denseArray(value: unknown, location: string): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return invalid(location, "Expected a plain dense array")
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      return invalid(`${location}[${index}]`, "Expected a dense enumerable own-data entry")
    }
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
      return invalid(location, "Symbol and extra array properties are not allowed")
    }
  }
  return value
}

function exactString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    return invalid(location, "Expected an exact non-empty string")
  }
  return value
}

function exactLiteral<T extends string>(value: unknown, expected: T, location: string): T {
  if (value !== expected) invalid(location, `Expected '${expected}'`)
  return expected
}

function exactIdentity(value: unknown, location: string): string {
  const identity = exactString(value, location)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(identity)) {
    return invalid(location, "Expected one portable identity")
  }
  return identity
}

function resourceRef(value: unknown, location: string): `resource://${string}` {
  const ref = exactString(value, location)
  if (!ref.startsWith("resource://") || ref.slice("resource://".length).includes("://")) {
    return invalid(location, "Expected one exact resource:// identity")
  }
  const identity = ref.slice("resource://".length)
  if (!identity) invalid(location, "Expected one exact resource:// identity")
  return ref as `resource://${string}`
}

function sha256(value: unknown, location: string): `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    return invalid(location, "Expected one canonical sha256 digest")
  }
  return value as `sha256:${string}`
}

function relativeFilePath(value: unknown, location: string): string {
  const filePath = exactString(value, location)
  const segments = filePath.split("/")
  if (filePath.startsWith("/") || filePath.includes("\\")
    || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return invalid(location, "Expected one portable containment-safe relative file path")
  }
  return filePath
}

function file(value: unknown, index: number): HolonDeploymentDefinitionFile {
  const location = `$.files[${index}]`
  const record = closedObject(value, location)
  exactKeys(record, ["path", "digest", "sizeBytes"], location)
  if (!Number.isSafeInteger(record.sizeBytes) || (record.sizeBytes as number) < 0) {
    invalid(`${location}.sizeBytes`, "Expected a non-negative safe integer")
  }
  return Object.freeze({
    path: relativeFilePath(record.path, `${location}.path`),
    digest: sha256(record.digest, `${location}.digest`),
    sizeBytes: record.sizeBytes as number,
  })
}

export function normalizeHolonDeploymentDefinition(value: unknown): HolonDeploymentDefinition {
  const record = closedObject(value, "$")
  exactKeys(record, [
    "schemaVersion",
    "deploymentId",
    "rootHolonRef",
    "bindingRef",
    "snapshotRef",
    "registryRevision",
    "snapshotTreeDigest",
    "snapshotReceiptDigest",
    "bindingBytesDigest",
    "bindingSemanticFingerprint",
    "files",
  ], "$")
  const files = denseArray(record.files, "$.files")
    .map((entry, index) => file(entry, index))
    .sort((left, right) => compareUtf16(left.path, right.path))
  if (files.length === 0 || new Set(files.map((entry) => entry.path)).size !== files.length) {
    invalid("$.files", "Expected a non-empty list with unique file paths")
  }
  for (const required of REQUIRED_AUTHORITY_FILES) {
    if (!files.some((entry) => entry.path === required)) {
      invalid("$.files", `Required authority file '${required}' is missing`)
    }
  }
  if (!files.some((entry) => /^\.agent-resources\/(?:(global|workspace)|effective-vfs\/\.eidolon\/resources)\/manifest\.xnl$/.test(entry.path))) {
    invalid("$.files", "At least one frozen ResourcePackage layer manifest is required")
  }
  return Object.freeze({
    schemaVersion: exactLiteral(
      record.schemaVersion,
      HOLON_DEPLOYMENT_DEFINITION_SCHEMA_VERSION,
      "$.schemaVersion",
    ),
    deploymentId: exactIdentity(record.deploymentId, "$.deploymentId"),
    rootHolonRef: exactIdentity(record.rootHolonRef, "$.rootHolonRef"),
    bindingRef: resourceRef(record.bindingRef, "$.bindingRef"),
    snapshotRef: resourceRef(record.snapshotRef, "$.snapshotRef"),
    registryRevision: sha256(record.registryRevision, "$.registryRevision"),
    snapshotTreeDigest: sha256(record.snapshotTreeDigest, "$.snapshotTreeDigest"),
    snapshotReceiptDigest: sha256(record.snapshotReceiptDigest, "$.snapshotReceiptDigest"),
    bindingBytesDigest: sha256(record.bindingBytesDigest, "$.bindingBytesDigest"),
    bindingSemanticFingerprint: sha256(
      record.bindingSemanticFingerprint,
      "$.bindingSemanticFingerprint",
    ),
    files: Object.freeze(files),
  })
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

export function canonicalHolonDeploymentDefinitionBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(normalizeHolonDeploymentDefinition(value)))
}

export function parseHolonDeploymentDefinitionBytes(bytes: Uint8Array): HolonDeploymentDefinition {
  let decoded: string
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return invalid("$bytes", "Definition bytes are not valid UTF-8")
  }
  let value: unknown
  try {
    value = JSON.parse(decoded)
  } catch {
    return invalid("$bytes", "Definition bytes are not valid JSON")
  }
  const definition = normalizeHolonDeploymentDefinition(value)
  if (!sameBytes(bytes, canonicalHolonDeploymentDefinitionBytes(definition))) {
    return invalid("$bytes", "Definition bytes are not canonical")
  }
  return definition
}
