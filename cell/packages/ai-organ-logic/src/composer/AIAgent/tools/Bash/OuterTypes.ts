import type { AiAgentOneActorRuntime } from "@cell/ai-core-contract/types"
export type BashOuterRuntime = AiAgentOneActorRuntime
export type BashOuterInput = { command: string; timeoutSeconds?: number; workdir?: string; description?: string }
export type BashOuterConfig = Record<string, unknown>
export type BashOuterDerived = null
export type BashOuterOutput = string
