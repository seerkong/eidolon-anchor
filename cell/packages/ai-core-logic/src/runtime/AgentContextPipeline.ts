import { createHash } from "node:crypto";
import type { AgentContextPipelineBinding } from "@cell/ai-core-contract/runtime/AgentContextPipeline";

export function cloneAndFreezeAgentContextPipelineBinding(
  binding: AgentContextPipelineBinding,
): AgentContextPipelineBinding {
  if (binding.schemaVersion === "eidolon.agent-context-pipeline-binding/v1") {
    return Object.freeze({
      schemaVersion: binding.schemaVersion,
      resourceId: binding.resourceId,
      contentDigest: binding.contentDigest,
      implementation: binding.implementation,
      stages: Object.freeze([...binding.stages]),
    });
  }
  if (binding.schemaVersion !== "eidolon.agent-context-pipeline-binding/v2"
    || typeof binding.resourceId !== "string" || !binding.resourceId.trim()
    || !/^sha256:[a-f0-9]{64}$/.test(binding.contentDigest)
    || !/^sha256:[a-f0-9]{64}$/.test(binding.executionDigest)
    || !/^[a-f0-9]{64}$/.test(binding.materialDigest)) {
    throw new Error("AGENT_CONTEXT_PIPELINE_BINDING_INVALID: expected exact frozen resource/code/material identities");
  }
  return Object.freeze({
    schemaVersion: binding.schemaVersion,
    resourceId: binding.resourceId,
    contentDigest: binding.contentDigest,
    executionDigest: binding.executionDigest,
    materialDigest: binding.materialDigest,
  });
}

/** Canonical closed field order is shared by preparation and the invocation adapter. */
export function digestAgentContextPipelineBinding(binding: AgentContextPipelineBinding): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(cloneAndFreezeAgentContextPipelineBinding(binding))).digest("hex")}`;
}
