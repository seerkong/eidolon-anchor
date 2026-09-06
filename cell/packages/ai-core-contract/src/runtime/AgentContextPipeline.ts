import type { AgentContextFactPresentationRecipe } from "./AgentContextFactPresentation";

export type LegacyAgentContextPipelineBinding = Readonly<{
  schemaVersion: "eidolon.agent-context-pipeline-binding/v1"
  resourceId: string
  contentDigest: string
  implementation: "eidolon.standard-context-pipeline/v1"
  stages: readonly string[]
}>

/** Durable identity only. Executable code is prepared from the addressed material. */
export type FrozenAgentContextPipelineBinding = Readonly<{
  schemaVersion: "eidolon.agent-context-pipeline-binding/v2"
  resourceId: string
  contentDigest: string
  executionDigest: string
  materialDigest: string
}>

export type AgentContextPipelineBinding = LegacyAgentContextPipelineBinding | FrozenAgentContextPipelineBinding

/** Opaque per-invocation owner results; resource code cannot supply message arrays. */
export type AgentContextPipelineStage = Readonly<{ stage: "plan" | "materialization" | "estimate" | "provider" }>

export type AgentContextPipelineInput = Readonly<{
  mode: "record" | "estimate"
  actorKey: string
  sessionId: string
  model: string
}>

/** Explicit mature processor ports, bound to one prompt invocation by the host. */
export type AgentContextPipelineRuntime = Readonly<{
  plan: () => AgentContextPipelineStage
  materialize: (plan: AgentContextPipelineStage) => AgentContextPipelineStage
  completeEstimate: (materialization: AgentContextPipelineStage) => AgentContextPipelineStage
  convert: (materialization: AgentContextPipelineStage) => AgentContextPipelineStage
}>

/** Process-local dependency. The compiled artifact supplies its own frozen config. */
export type AgentContextPipelineExecution = Readonly<{
  bindingDigest: string
  executionDigest: string
  factPresentation?: AgentContextFactPresentationRecipe
  execute: (runtime: AgentContextPipelineRuntime, input: AgentContextPipelineInput) => unknown
}>
