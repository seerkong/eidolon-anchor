/** Derived provider presentation only; the underlying admitted facts stay immutable. */
export type AgentContextFactPresentationRule = Readonly<{
  namespace: "task-tree-context" | "workflow-stage-context";
  payloadKeys: readonly string[] | null;
  jsonLayout: "canonical" | "pretty";
}>;

/** Frozen with the existing Agent execution bundle, never a conversation fact owner. */
export type AgentContextFactPresentationRecipe = Readonly<{
  schemaVersion: "eidolon.context-fact-presentation/v1";
  rules: readonly AgentContextFactPresentationRule[];
}>;
