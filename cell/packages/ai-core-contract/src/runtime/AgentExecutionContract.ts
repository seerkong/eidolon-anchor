export interface AgentExecutionRecord {
  readonly [key: string]: AgentExecutionValue
}

export type AgentExecutionValue =
  | null
  | boolean
  | number
  | string
  | readonly AgentExecutionValue[]
  | AgentExecutionRecord

export type AgentExecutionSchema = AgentExecutionRecord

export type AgentExecutionMaterialValue = {
  readonly bindingResourceId: string
  readonly materialResourceId: string
  readonly value: AgentExecutionValue
}

export type AgentExecutionMaterialPortInput = {
  readonly portResourceId: string
  readonly materialKind: string
  readonly required: boolean
  readonly cardinality: "one" | "many"
  readonly schema?: AgentExecutionSchema
  readonly values: readonly AgentExecutionMaterialValue[]
}

export type AgentExecutionMessageSchema = {
  readonly messageId: string
  readonly schema: AgentExecutionSchema
}

export type AgentExecutionContract = {
  readonly schemaVersion: "eidolon.agent-execution-contract/v1"
  readonly input: {
    readonly schemaVersion: "eidolon.agent-execution-input/v1"
    readonly payload: AgentExecutionValue
    readonly materials: readonly AgentExecutionMaterialPortInput[]
  }
  readonly messageSchemas: readonly AgentExecutionMessageSchema[]
  readonly inputSchema?: AgentExecutionSchema
  readonly outputSchema?: AgentExecutionSchema
  readonly effectPolicy: {
    readonly toolMode: "declared-only" | "none"
  }
}
