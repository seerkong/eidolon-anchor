import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
export type EditOuterRuntime = AiAgentOneActorRuntime
export type EditOuterInput = { filePath: string; oldString: string; newString: string; replaceAll?: boolean }
export type EditOuterConfig = Record<string, unknown>
export type EditOuterDerived = null
export type EditOuterOutput = string
