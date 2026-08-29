export type AgentContextPipelineBinding = Readonly<{
  schemaVersion: "eidolon.agent-context-pipeline-binding/v1"
  resourceId: string
  contentDigest: string
  implementation: "eidolon.standard-context-pipeline/v1"
  stages: readonly string[]
}>
