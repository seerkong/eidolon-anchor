export type ConversationArtifactOwnerDomain = "history" | "prompt" | "session";

export type ConversationArtifactKind =
  | "compaction_summary"
  | "diagnostic"
  | "bootstrap_snapshot";

export type ConversationArtifactRef = {
  artifactId: string;
  ownerDomain: ConversationArtifactOwnerDomain;
  ownerId: string;
  artifactKind: ConversationArtifactKind;
  filePath?: string | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
};

export type ConversationArtifactRefsSnapshot = {
  version: number;
  sessionId: string;
  refs: ConversationArtifactRef[];
  updatedAt: string;
};
