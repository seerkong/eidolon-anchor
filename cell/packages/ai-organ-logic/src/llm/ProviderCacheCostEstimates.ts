import { estimateTokens } from "@cell/ai-organ-logic/compression/TokenEstimator";

export function estimateProviderToolSurfaceTokens(tools: readonly unknown[]): number {
  return tools.length === 0
    ? 0
    : estimateTokens([{ role: "system", content: JSON.stringify(tools) }]);
}

export function estimateGenericRuntimeContextTokens(messages: readonly any[]): number {
  return estimateTokens(messages.filter((message) => (
    typeof message?.content === "string" && message.content.includes("runtime_work_context")
  )));
}

export function estimateWorkflowControlTokens(messages: readonly any[], tools: readonly any[]): number {
  const workflowMessages = messages.filter((message) => {
    const content = typeof message?.content === "string" ? message.content : "";
    return content.includes("eidolon:workflow")
      || content.includes("<workflow_")
      || content.includes("runtime_work_context");
  });
  const workflowTools = tools.filter((tool: any) => (
    typeof tool?.function?.name === "string" && tool.function.name.startsWith("Workflow")
  ));
  return estimateTokens(workflowMessages) + estimateProviderToolSurfaceTokens(workflowTools);
}

export function estimateProviderCacheCostTokens(
  messages: readonly any[],
  tools: readonly any[],
): Readonly<{ toolSurfaceTokens: number; workflowControlTokens: number }> {
  return Object.freeze({
    toolSurfaceTokens: estimateProviderToolSurfaceTokens(tools),
    workflowControlTokens: estimateWorkflowControlTokens(messages, tools),
  });
}

/**
 * Derive diagnostic estimates from the exact JSON body admitted by the
 * provider transport. Driver projection can change tool schemas after the
 * Executor's earlier estimate, so cache-cost evidence must use these final
 * wire values rather than the pre-driver candidates.
 */
export function estimateFinalWireProviderCacheCostTokens(
  serializedRequestBody: string,
): Readonly<{ finalWireInputTokens: number; toolSurfaceTokens: number; workflowControlTokens: number }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serializedRequestBody);
  } catch {
    throw new Error("PROVIDER_CACHE_COST_FINAL_WIRE_INVALID: request body is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("PROVIDER_CACHE_COST_FINAL_WIRE_INVALID: request body must be an object");
  }
  const request = parsed as Record<string, unknown>;
  if (!Array.isArray(request.messages)) {
    throw new Error("PROVIDER_CACHE_COST_FINAL_WIRE_INVALID: messages must be an array");
  }
  const tools = request.tools === undefined ? [] : request.tools;
  if (!Array.isArray(tools)) {
    throw new Error("PROVIDER_CACHE_COST_FINAL_WIRE_INVALID: tools must be an array when present");
  }
  return Object.freeze({
    finalWireInputTokens: Math.ceil(Buffer.byteLength(serializedRequestBody, "utf8") / 4),
    ...estimateProviderCacheCostTokens(request.messages, tools),
  });
}
