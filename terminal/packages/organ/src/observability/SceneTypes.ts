// Re-exported from canonical implementation in @cell/ai-organ-logic
export {
  manifestToNode,
  nodeToManifest,
  messageToNode,
  nodeToMessage,
} from "@cell/ai-organ-logic";
export type {
  ToolDef,
  SceneManifest,
  SceneMessage,
  SceneToolCall,
} from "@cell/ai-organ-logic";

// Legacy type alias for backward compatibility
export type SceneTurnEvent = {
  kind: "Message" | "ProviderEvent";
  message?: import("@cell/ai-organ-logic").SceneMessage;
  providerPhase?: string;
  providerTimestamp?: number;
  providerText?: string;
};
