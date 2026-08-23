import type {
  AgentExecutionContract,
  AgentExecutionValue,
} from "@cell/ai-core-contract/runtime/AgentExecutionContract"

export class CoreAgentExecutionContractError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = "CoreAgentExecutionContractError"
  }
}

export function cloneAndFreezeAgentExecutionContract(value: unknown): AgentExecutionContract {
  const normalized = cloneClosedValue(value, "executionContract")
  const root = objectValue(normalized, "executionContract")
  exactKeys(root, ["schemaVersion", "input", "messageSchemas", "inputSchema", "outputSchema", "effectPolicy"], "executionContract")
  if (root.schemaVersion !== "eidolon.agent-execution-contract/v1") invalid("executionContract.schemaVersion is unsupported")

  const input = objectValue(root.input, "executionContract.input")
  exactKeys(input, ["schemaVersion", "payload", "materials"], "executionContract.input")
  if (input.schemaVersion !== "eidolon.agent-execution-input/v1"
    || !Object.prototype.hasOwnProperty.call(input, "payload")
    || !Array.isArray(input.materials)) {
    invalid("executionContract.input is malformed")
  }

  if (!Array.isArray(root.messageSchemas)) invalid("executionContract.messageSchemas must be an array")
  const messageIds = new Set<string>()
  for (let index = 0; index < root.messageSchemas.length; index += 1) {
    const message = objectValue(root.messageSchemas[index], `executionContract.messageSchemas[${index}]`)
    exactKeys(message, ["messageId", "schema"], `executionContract.messageSchemas[${index}]`)
    exactString(message.messageId, `executionContract.messageSchemas[${index}].messageId`)
    schemaObject(message.schema, `executionContract.messageSchemas[${index}].schema`)
    if (messageIds.has(message.messageId as string)) invalid("executionContract.messageSchemas contains duplicate messageId values")
    messageIds.add(message.messageId as string)
  }

  for (let index = 0; index < input.materials.length; index += 1) {
    const port = objectValue(input.materials[index], `executionContract.input.materials[${index}]`)
    exactKeys(port, ["portResourceId", "materialKind", "required", "cardinality", "schema", "values"], `executionContract.input.materials[${index}]`)
    exactString(port.portResourceId, `executionContract.input.materials[${index}].portResourceId`)
    exactString(port.materialKind, `executionContract.input.materials[${index}].materialKind`)
    if (typeof port.required !== "boolean"
      || (port.cardinality !== "one" && port.cardinality !== "many")
      || !Array.isArray(port.values)) {
      invalid(`executionContract.input.materials[${index}] is malformed`)
    }
    if (port.schema !== undefined) schemaObject(port.schema, `executionContract.input.materials[${index}].schema`)
    for (let valueIndex = 0; valueIndex < port.values.length; valueIndex += 1) {
      const entry = objectValue(port.values[valueIndex], `executionContract.input.materials[${index}].values[${valueIndex}]`)
      exactKeys(entry, ["bindingResourceId", "materialResourceId", "value"], `executionContract.input.materials[${index}].values[${valueIndex}]`)
      exactString(entry.bindingResourceId, `executionContract.input.materials[${index}].values[${valueIndex}].bindingResourceId`)
      exactString(entry.materialResourceId, `executionContract.input.materials[${index}].values[${valueIndex}].materialResourceId`)
      if (!Object.prototype.hasOwnProperty.call(entry, "value")) {
        invalid(`executionContract.input.materials[${index}].values[${valueIndex}].value is required`)
      }
    }
  }

  if (root.inputSchema !== undefined) schemaObject(root.inputSchema, "executionContract.inputSchema")
  if (root.outputSchema !== undefined) schemaObject(root.outputSchema, "executionContract.outputSchema")
  const policy = objectValue(root.effectPolicy, "executionContract.effectPolicy")
  exactKeys(policy, ["toolMode"], "executionContract.effectPolicy")
  if (policy.toolMode !== "declared-only" && policy.toolMode !== "none") {
    invalid("executionContract.effectPolicy.toolMode is unsupported")
  }
  return normalized as AgentExecutionContract
}

function cloneClosedValue(value: unknown, location: string, active = new Set<object>()): AgentExecutionValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(`${location} must be a finite number`)
    return value
  }
  if (typeof value !== "object") invalid(`${location} must be JSON-compatible plain data`)
  if (active.has(value)) invalid(`${location} must not contain a cycle`)
  active.add(value)
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value)
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)]
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          invalid(`${location}[${index}] must be a dense enumerable own-data entry`)
        }
      }
      for (const key of Reflect.ownKeys(descriptors)) {
        if (key === "length") continue
        if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
          invalid(`${location} must not contain symbol or extra array properties`)
        }
      }
      return Object.freeze(value.map((entry, index) => cloneClosedValue(entry, `${location}[${index}]`, active)))
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) invalid(`${location} must be a plain object`)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const output: Record<string, AgentExecutionValue> = Object.create(null)
    const keys = Reflect.ownKeys(descriptors)
    if (keys.some((key) => typeof key !== "string")) invalid(`${location} must not contain symbol properties`)
    for (const key of (keys as string[]).sort(compareCodeUnits)) {
      const descriptor = descriptors[key]
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        invalid(`${location}.${key} must be an enumerable own-data property`)
      }
      output[key] = cloneClosedValue(descriptor.value, `${location}.${key}`, active)
    }
    return Object.freeze(output)
  } finally {
    active.delete(value)
  }
}

function objectValue(value: AgentExecutionValue | undefined, location: string): Readonly<Record<string, AgentExecutionValue>> {
  if (value === null || value === undefined || Array.isArray(value) || typeof value !== "object") invalid(`${location} must be an object`)
  return value
}

function schemaObject(value: AgentExecutionValue | undefined, location: string): void {
  objectValue(value, location)
}

function exactString(value: AgentExecutionValue | undefined, location: string): void {
  if (typeof value !== "string" || !value || value !== value.trim()) invalid(`${location} must be an exact non-empty string`)
}

function exactKeys(record: Readonly<Record<string, AgentExecutionValue>>, allowed: readonly string[], location: string): void {
  const allowedSet = new Set(allowed)
  const extra = Object.keys(record).find((key) => !allowedSet.has(key))
  if (extra) invalid(`${location} has unsupported field '${extra}'`)
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function invalid(message: string): never {
  throw new CoreAgentExecutionContractError("AGENT_EXECUTION_CONTRACT_INVALID", `${message}.`)
}
