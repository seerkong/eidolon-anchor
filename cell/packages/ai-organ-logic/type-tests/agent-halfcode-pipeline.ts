import type { AgentContextPipelineBinding } from "@cell/ai-core-contract/runtime/AgentContextPipeline"
import type { AgentConfig } from "@cell/ai-core-contract/runtime/AgentConfig"
import { createActor } from "@cell/ai-core-logic/runtime/actor"
import { EidolonAppResourceRegistryAdapter } from "../src/resources/EidolonAppResourceRegistryAdapter"
import { copiedMatureCodeAgentPrefix } from "../../../../testkit/codument-proposition/agent-resources"

declare const binding: AgentContextPipelineBinding

const config: AgentConfig = {
  name: "resource://type-test.Agent",
  description: "type-test",
  tools: [],
  prompt: [],
  contextPipeline: binding,
}

createActor({ key: "type-test", contextPipeline: config.contextPipeline })
new EidolonAppResourceRegistryAdapter({ layers: [], workspaceRoot: "/workspace" })
copiedMatureCodeAgentPrefix("/workspace")
