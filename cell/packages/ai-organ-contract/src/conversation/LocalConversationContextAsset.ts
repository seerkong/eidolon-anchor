import type { ResponsesReplayCheckpoint } from "../llm/ResponsesReplay";
import type { ActorProviderContextFact } from "./ActorProviderContextFact";

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

export type LocalConversationContextResourceDigest = {
  algorithm: "sha256";
  digest: string;
};

export type LocalConversationContextResourceFragmentSelection = {
  kind: "line_range";
  startLine: number;
  endLine: number;
};

export type LocalConversationContextResourceFragmentFact = {
  fragmentId: string;
  revisionDigest: string;
  selection: LocalConversationContextResourceFragmentSelection;
  contentDigest: LocalConversationContextResourceDigest;
  observedAt: string;
};

export type LocalConversationContextResourceDeliveryFact = {
  toolCallId: string;
  revisionDigest: string;
  fragmentId: string;
  deliveredAt: string;
};

export type LocalConversationContextResourceFact = {
  canonicalResourceId: string;
  revision: LocalConversationContextResourceDigest;
  fragments: LocalConversationContextResourceFragmentFact[];
  deliveries: LocalConversationContextResourceDeliveryFact[];
  observedAt: string;
};

export type LocalConversationProviderProjectionSourceToolCall = {
  toolCallId: string;
  projectionRevision: string;
  deliveryState: "pending" | "delivered";
  deliveredAt?: string | null;
};

export type LocalConversationProviderProjectionFact = {
  actorKey: string;
  projectionKey: string;
  revision: string;
  content: string;
  placement: "late";
  sourceToolCalls: LocalConversationProviderProjectionSourceToolCall[];
  observedAt: string;
};

export type LocalConversationProviderContextFactCandidate = {
  actorKey: string;
  namespace: ActorProviderContextFact["namespace"];
  logicalKey: string;
  revision: string;
  payload: Readonly<Record<string, unknown>>;
  sourceToolCalls: LocalConversationProviderProjectionSourceToolCall[];
  observedAt: string;
};

export type LocalConversationToolResultDelivery = {
  toolCallId: string;
  deliveryState: "pending" | "delivered";
  observedAt: string;
  deliveredAt?: string | null;
};

export type LocalConversationToolResultDeliveryFact = {
  actorKey: string;
  deliveries: LocalConversationToolResultDelivery[];
  updatedAt: string;
};

export type LocalConversationMessageDelivery = {
  deliveryId: string;
  messageId: string;
  deliveryState: "pending" | "delivered";
  observedAt: string;
  deliveredAt?: string | null;
};

export type LocalConversationMessageDeliveryFact = {
  actorKey: string;
  deliveries: LocalConversationMessageDelivery[];
  updatedAt: string;
};

export type LocalConversationContextAssetData = {
  assetId: string;
  kind: LocalConversationContextAssetKind;
  label?: string | null;
  source: LocalConversationContextAssetSource;
  boundPromptGenerationId?: string | null;
  extractedArtifactId?: string | null;
  selectedFragmentId?: string | null;
  resourceFact?: LocalConversationContextResourceFact;
  projectionFact?: LocalConversationProviderProjectionFact;
  /** Runtime-only pending delivery candidate; never provider-visible itself. */
  providerContextFactCandidate?: LocalConversationProviderContextFactCandidate;
  /** Immutable, provider-visible append-only context fact. */
  providerContextFact?: ActorProviderContextFact;
  /**
   * Runtime-only delivery facts for ordinary tool call/result pairs. These
   * facts participate in late provider materialization decisions, but never
   * become provider-visible messages or stable prompt/cache inputs.
   */
  toolResultDeliveryFact?: LocalConversationToolResultDeliveryFact;
  /**
   * Runtime-only delivery facts for committed asynchronous messages. The
   * stable message id protects History through first successful provider
   * delivery; neither the fact nor the id is provider-visible.
   */
  messageDeliveryFact?: LocalConversationMessageDeliveryFact;
  /**
   * Replaceable provider-native optimization state. It is persisted with the
   * Session domain but is never a History fact or a provider-visible message.
   */
  replayCheckpoint?: ResponsesReplayCheckpoint;
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
