import Ajv, { type ErrorObject, type ValidateFunction } from "ajv"

import type {
  AgentExecutionContract,
  AgentExecutionSchema,
  AgentExecutionValue,
} from "@cell/ai-core-contract/runtime/AgentExecutionContract"

const ajv = new Ajv({ allErrors: true, strict: true, validateFormats: false })

export class AgentExecutionContractError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`${code}: ${message}`)
    this.name = "AgentExecutionContractError"
  }
}

export function normalizeAgentExecutionValue(
  value: unknown,
  location = "value",
  active = new Set<object>(),
): AgentExecutionValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidValue(location, "must be a finite number")
    return value
  }
  if (typeof value !== "object") throw invalidValue(location, "must be JSON-compatible plain data")
  if (active.has(value)) throw invalidValue(location, "must not contain a cycle")
  active.add(value)
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value)
      const keys = Reflect.ownKeys(descriptors)
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)]
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw invalidValue(`${location}[${index}]`, "must be a dense own-data array entry")
        }
      }
      for (const key of keys) {
        if (key === "length") continue
        if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
          throw invalidValue(location, "must not contain symbol or extra array properties")
        }
      }
      return Object.freeze(value.map((entry, index) => normalizeAgentExecutionValue(entry, `${location}[${index}]`, active)))
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalidValue(location, "must use Object.prototype or a null prototype")
    }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const keys = Reflect.ownKeys(descriptors)
    if (keys.some((key) => typeof key !== "string")) {
      throw invalidValue(location, "must not contain symbol properties")
    }
    const output: Record<string, AgentExecutionValue> = Object.create(null)
    for (const key of (keys as string[]).sort(compareCodeUnits)) {
      const descriptor = descriptors[key]
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw invalidValue(`${location}.${key}`, "must be an enumerable own-data property")
      }
      output[key] = normalizeAgentExecutionValue(descriptor.value, `${location}.${key}`, active)
    }
    return Object.freeze(output)
  } finally {
    active.delete(value)
  }
}

export function normalizeAgentExecutionSchema(value: unknown, location: string): AgentExecutionSchema {
  const normalized = normalizeAgentExecutionValue(value, location)
  if (normalized === null || Array.isArray(normalized) || typeof normalized !== "object") {
    throw new AgentExecutionContractError("AGENT_EXECUTION_SCHEMA_INVALID", `${location} must be a schema object`)
  }
  compileSchema(normalized as AgentExecutionSchema, location)
  return normalized as AgentExecutionSchema
}

export function normalizeAgentExecutionContract(value: unknown): AgentExecutionContract {
  const normalized = normalizeAgentExecutionValue(value, "executionContract")
  const root = executionRecord(normalized, "executionContract")
  exactKeys(root, ["schemaVersion", "input", "messageSchemas", "inputSchema", "outputSchema", "effectPolicy"], "executionContract")
  if (root.schemaVersion !== "eidolon.agent-execution-contract/v1") {
    throw new AgentExecutionContractError("AGENT_EXECUTION_CONTRACT_INVALID", "executionContract.schemaVersion is unsupported.")
  }
  const input = executionRecord(root.input, "executionContract.input")
  exactKeys(input, ["schemaVersion", "payload", "materials"], "executionContract.input")
  if (input.schemaVersion !== "eidolon.agent-execution-input/v1" || !("payload" in input) || !Array.isArray(input.materials)) {
    throw new AgentExecutionContractError("AGENT_EXECUTION_CONTRACT_INVALID", "executionContract.input is malformed.")
  }
  if (!Array.isArray(root.messageSchemas)) {
    throw new AgentExecutionContractError("AGENT_EXECUTION_CONTRACT_INVALID", "executionContract.messageSchemas must be an array.")
  }
  const messageSchemas = Object.freeze(root.messageSchemas.map((entry, index) => {
    const message = executionRecord(entry, `executionContract.messageSchemas[${index}]`)
    exactKeys(message, ["messageId", "schema"], `executionContract.messageSchemas[${index}]`)
    if (typeof message.messageId !== "string" || !message.messageId || message.messageId !== message.messageId.trim()) {
      throw new AgentExecutionContractError("AGENT_EXECUTION_CONTRACT_INVALID", `messageSchemas[${index}].messageId must be exact.`)
    }
    return Object.freeze({
      messageId: message.messageId,
      schema: normalizeAgentExecutionSchema(message.schema, `messageSchemas[${index}].schema`),
    })
  }))
  if (new Set(messageSchemas.map((entry) => entry.messageId)).size !== messageSchemas.length) {
    throw new AgentExecutionContractError("AGENT_EXECUTION_CONTRACT_INVALID", "messageSchemas contains duplicate messageId values.")
  }
  const materials = Object.freeze(input.materials.map((entry, index) => {
    const port = executionRecord(entry, `executionContract.input.materials[${index}]`)
    exactKeys(port, ["portResourceId", "materialKind", "required", "cardinality", "schema", "values"], `executionContract.input.materials[${index}]`)
    if (typeof port.portResourceId !== "string" || !port.portResourceId
      || typeof port.materialKind !== "string" || !port.materialKind
      || typeof port.required !== "boolean"
      || (port.cardinality !== "one" && port.cardinality !== "many")
      || !Array.isArray(port.values)) {
      throw new AgentExecutionContractError("AGENT_EXECUTION_CONTRACT_INVALID", `input.materials[${index}] is malformed.`)
    }
    const values = Object.freeze(port.values.map((material, materialIndex) => {
      const item = executionRecord(material, `executionContract.input.materials[${index}].values[${materialIndex}]`)
      exactKeys(item, ["bindingResourceId", "materialResourceId", "value"], `executionContract.input.materials[${index}].values[${materialIndex}]`)
      if (typeof item.bindingResourceId !== "string" || !item.bindingResourceId
        || typeof item.materialResourceId !== "string" || !item.materialResourceId
        || !("value" in item)) {
        throw new AgentExecutionContractError("AGENT_EXECUTION_CONTRACT_INVALID", `input.materials[${index}].values[${materialIndex}] is malformed.`)
      }
      return Object.freeze({
        bindingResourceId: item.bindingResourceId,
        materialResourceId: item.materialResourceId,
        value: item.value,
      })
    }))
    return Object.freeze({
      portResourceId: port.portResourceId,
      materialKind: port.materialKind,
      required: port.required,
      cardinality: port.cardinality,
      ...(port.schema === undefined
        ? {}
        : { schema: normalizeAgentExecutionSchema(port.schema, `input.materials[${index}].schema`) }),
      values,
    })
  }))
  const policy = executionRecord(root.effectPolicy, "executionContract.effectPolicy")
  exactKeys(policy, ["toolMode"], "executionContract.effectPolicy")
  if (policy.toolMode !== "declared-only" && policy.toolMode !== "none") {
    throw new AgentExecutionContractError("AGENT_EXECUTION_CONTRACT_INVALID", "effectPolicy.toolMode is unsupported.")
  }
  return Object.freeze({
    schemaVersion: "eidolon.agent-execution-contract/v1",
    input: Object.freeze({
      schemaVersion: "eidolon.agent-execution-input/v1",
      payload: input.payload as AgentExecutionValue,
      materials,
    }),
    messageSchemas,
    ...(root.inputSchema === undefined ? {} : { inputSchema: normalizeAgentExecutionSchema(root.inputSchema, "inputSchema") }),
    ...(root.outputSchema === undefined ? {} : { outputSchema: normalizeAgentExecutionSchema(root.outputSchema, "outputSchema") }),
    effectPolicy: Object.freeze({ toolMode: policy.toolMode }),
  })
}

export function validateAgentExecutionValue(
  schema: AgentExecutionSchema,
  value: AgentExecutionValue,
  location: string,
): void {
  const validate = compileSchema(schema, location)
  if (validate(value)) return
  throw new AgentExecutionContractError(
    "AGENT_EXECUTION_SCHEMA_MISMATCH",
    `${location} does not satisfy its exact schema (${boundedAjvErrors(validate.errors)}).`,
  )
}

export function validateAgentExecutionInput(contract: AgentExecutionContract): void {
  if (contract.inputSchema) {
    validateAgentExecutionValue(contract.inputSchema, contract.input.payload, "input.payload")
  }
  for (const port of contract.input.materials) {
    if (port.required && port.values.length === 0) {
      throw new AgentExecutionContractError(
        "AGENT_EXECUTION_MATERIAL_REQUIRED",
        `Material port '${port.portResourceId}' requires a value.`,
      )
    }
    if (port.cardinality === "one" && port.values.length > 1) {
      throw new AgentExecutionContractError(
        "AGENT_EXECUTION_MATERIAL_CARDINALITY",
        `Material port '${port.portResourceId}' accepts at most one value.`,
      )
    }
    if (port.schema) {
      for (const entry of port.values) {
        validateAgentExecutionValue(port.schema, entry.value, `material.${port.portResourceId}.${entry.materialResourceId}`)
      }
    }
  }
}

export function validateAgentExecutionMessages(
  contract: AgentExecutionContract,
  messages: readonly { readonly id: string; readonly content: string }[],
): void {
  const byId = new Map(messages.map((message) => [message.id, message]))
  for (const entry of contract.messageSchemas) {
    const message = byId.get(entry.messageId)
    if (!message) {
      throw new AgentExecutionContractError(
        "AGENT_EXECUTION_MESSAGE_MISSING",
        `Message '${entry.messageId}' is not present in the frozen execution plan.`,
      )
    }
    validateAgentExecutionValue(entry.schema, message.content, `message.${entry.messageId}`)
  }
}

export function validateAgentExecutionOutput(
  contract: AgentExecutionContract | undefined,
  outputText: string,
): string {
  projectAgentExecutionOutput(contract, outputText)
  return outputText
}

export function projectAgentExecutionOutput(
  contract: AgentExecutionContract | undefined,
  outputText: string,
): AgentExecutionValue {
  if (!contract?.outputSchema) return outputText
  const validate = compileSchema(contract.outputSchema, "output")
  if (validate(outputText)) return outputText
  let parsed: AgentExecutionValue
  try {
    parsed = normalizeAgentExecutionValue(JSON.parse(outputText), "output")
  } catch {
    throw new AgentExecutionContractError(
      "AGENT_EXECUTION_OUTPUT_SCHEMA_MISMATCH",
      `Provider output does not satisfy the exact output schema (${boundedAjvErrors(validate.errors)}).`,
    )
  }
  if (!validate(parsed)) {
    throw new AgentExecutionContractError(
      "AGENT_EXECUTION_OUTPUT_SCHEMA_MISMATCH",
      `Provider output does not satisfy the exact output schema (${boundedAjvErrors(validate.errors)}).`,
    )
  }
  return parsed
}

function compileSchema(schema: AgentExecutionSchema, location: string): ValidateFunction {
  try {
    return ajv.compile(schema as object)
  } catch (error) {
    throw new AgentExecutionContractError(
      "AGENT_EXECUTION_SCHEMA_INVALID",
      `${location} is not a supported JSON Schema (${String((error as Error)?.message ?? error).slice(0, 240)}).`,
    )
  }
}

function boundedAjvErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).slice(0, 4).map((error) => `${error.instancePath || "/"} ${error.message ?? "invalid"}`).join("; ").slice(0, 320)
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function invalidValue(location: string, detail: string): AgentExecutionContractError {
  return new AgentExecutionContractError("AGENT_EXECUTION_VALUE_INVALID", `${location} ${detail}.`)
}

function executionRecord(value: AgentExecutionValue | undefined, location: string): Readonly<Record<string, AgentExecutionValue>> {
  if (value === null || value === undefined || Array.isArray(value) || typeof value !== "object") {
    throw new AgentExecutionContractError("AGENT_EXECUTION_CONTRACT_INVALID", `${location} must be an object.`)
  }
  return value
}

function exactKeys(
  record: Readonly<Record<string, AgentExecutionValue>>,
  allowed: readonly string[],
  location: string,
): void {
  const allowedSet = new Set(allowed)
  const extra = Object.keys(record).find((key) => !allowedSet.has(key))
  if (extra) throw new AgentExecutionContractError("AGENT_EXECUTION_CONTRACT_INVALID", `${location} has unsupported field '${extra}'.`)
}
