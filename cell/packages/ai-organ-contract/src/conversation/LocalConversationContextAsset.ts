export type LocalConversationContextAssetKind =
  | "workspace_file"
  | "mcp_resource"
  | "upload"
  | "generated_summary"
  | "note";

export type LocalConversationContextAssetSource =
  | {
      kind: "workspace_file";
      path: string;
    }
  | {
      kind: "mcp_resource";
      serverName: string;
      resourceUri: string;
    }
  | {
      kind: "upload";
      fileName?: string | null;
      mimeType?: string | null;
    }
  | {
      kind: "generated_summary" | "note";
      ownerId?: string | null;
    };

export type LocalConversationContextAssetData = {
  assetId: string;
  kind: LocalConversationContextAssetKind;
  label?: string | null;
  source: LocalConversationContextAssetSource;
  boundPromptGenerationId?: string | null;
  extractedArtifactId?: string | null;
  selectedFragmentId?: string | null;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string | null;
};

export type LocalConversationContextAssetRegistrySlot = {
  version: number;
  assetIds: string[];
  updatedAt: string;
};
