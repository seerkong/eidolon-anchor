import type { TechDesignSnapshotDsl } from "@shared/core";

export interface FetchDocContentRequest {
  docLink: string;
}

export interface FetchDocContentResponse {
  markdownContent: string;
  htmlContent: string;
}

export interface UpdateTechDocDslRequest {
  projectKey: string;
  conversationUniqueId: string;
  techDocDsl: TechDesignSnapshotDsl;
}
