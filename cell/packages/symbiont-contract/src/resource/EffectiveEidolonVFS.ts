/**
 * Storage-neutral authority contract for Eidolon's materialized VFS.
 *
 * These types deliberately do not depend on Bun, node:fs, XNL or Halfcode.
 * Those systems provide inputs or derived projections; an admitted snapshot is
 * the only runtime file authority exposed to consumers.
 */

export const EFFECTIVE_EIDOLON_VFS_ROOT = "/.eidolon" as const;
export const EFFECTIVE_EIDOLON_VFS_SNAPSHOT_SCHEMA = "eidolon.effective-vfs-snapshot/v1" as const;
export const EIDOLON_VFS_MATERIALIZATION_PLAN_SCHEMA = "eidolon.vfs-materialization-plan/v1" as const;
export const EIDOLON_VFS_MATERIALIZATION_RECEIPT_SCHEMA = "eidolon.vfs-materialization-receipt/v1" as const;
export const LEGACY_RESOURCE_VFS_PROJECTION_SCHEMA = "eidolon.legacy-resource-vfs-projection/v1" as const;

export type EidolonVfsDigest = `sha256:${string}`;
export type EidolonVfsRevision = EidolonVfsDigest;

export type EidolonVfsOverlayKind = "home" | "workspace";

/** Ordered user intent; this is an input to materialization, never a read authority. */
export interface EidolonVfsOverlayDescriptor {
  readonly id: string;
  readonly kind: EidolonVfsOverlayKind;
  readonly order: number;
  readonly intentRevision: EidolonVfsRevision;
  readonly intentDigest: EidolonVfsDigest;
}

/** Immutable metadata for the one VFS revision admitted to runtime consumers. */
export interface EffectiveEidolonVfsSnapshot {
  readonly schemaVersion: typeof EFFECTIVE_EIDOLON_VFS_SNAPSHOT_SCHEMA;
  readonly revision: EidolonVfsRevision;
  readonly baseRevision: EidolonVfsRevision;
  readonly rootPath: typeof EFFECTIVE_EIDOLON_VFS_ROOT;
  readonly treeDigest: EidolonVfsDigest;
  readonly overlays: readonly EidolonVfsOverlayDescriptor[];
  readonly materializationReceiptId: string;
  readonly admittedAt: string;
}

/** Serializable transition intent created before any mutation is published. */
export interface EidolonVfsMaterializationPlan {
  readonly schemaVersion: typeof EIDOLON_VFS_MATERIALIZATION_PLAN_SCHEMA;
  readonly planId: string;
  readonly expectedCurrentRevision: EidolonVfsRevision | null;
  readonly baseRevision: EidolonVfsRevision;
  readonly overlays: readonly EidolonVfsOverlayDescriptor[];
  readonly candidateTreeDigest: EidolonVfsDigest;
  readonly createdAt: string;
}

/** Candidate metadata remains non-authoritative until an admitted receipt exists. */
export interface EidolonVfsMaterializationCandidate {
  readonly planId: string;
  readonly baseRevision: EidolonVfsRevision;
  readonly treeDigest: EidolonVfsDigest;
  readonly overlays: readonly EidolonVfsOverlayDescriptor[];
}

export interface EidolonVfsValidationEvidence {
  readonly id: string;
  readonly evidenceDigest: EidolonVfsDigest;
}

export interface EidolonVfsValidationProof {
  readonly validatedAt: string;
  readonly validators: readonly EidolonVfsValidationEvidence[];
}

export type EidolonVfsMaterializationDiagnosticCode =
  | "identity_mismatch"
  | "precondition_failed"
  | "mutation_rejected"
  | "validation_failed"
  | "duplicate_resource"
  | "invalid_resource"
  | "candidate_handle_invalid"
  | "publish_conflict";

export interface EidolonVfsMaterializationDiagnostic {
  readonly code: EidolonVfsMaterializationDiagnosticCode;
  readonly message: string;
  readonly overlayId?: string;
  readonly logicalPath?: string;
  readonly nodeId?: string;
  readonly mutationIndex?: number;
}

export interface AdmittedEidolonVfsMaterializationReceipt {
  readonly schemaVersion: typeof EIDOLON_VFS_MATERIALIZATION_RECEIPT_SCHEMA;
  readonly status: "admitted";
  readonly receiptId: string;
  readonly planId: string;
  readonly previousRevision: EidolonVfsRevision | null;
  readonly publishedRevision: EidolonVfsRevision;
  readonly candidateTreeDigest: EidolonVfsDigest;
  readonly validation: EidolonVfsValidationProof;
  readonly publishedAt: string;
}

/** Causal identity attached to the native VFS commit, never a separate head. */
export interface EidolonVfsPublicationAssociation {
  readonly transactionId: string;
  readonly planDigest: string;
  readonly receiptDigest: string;
}

/** Closed, recoverable projection input. Paths are relative to the configured workspace. */
export interface EidolonVfsWorkspaceWrite {
  readonly logicalPath: `/.eidolon/resources/${string}`;
  readonly before: { readonly state: "absent" } | {
    readonly state: "present";
    readonly text: string;
    readonly digest: EidolonVfsDigest;
  };
  readonly authorityText: string;
}

export interface EidolonVfsPublicationRecord {
  readonly publicationKey: string;
  readonly association?: EidolonVfsPublicationAssociation;
  readonly plan: EidolonVfsMaterializationPlan;
  readonly receipt: AdmittedEidolonVfsMaterializationReceipt;
}

export interface RejectedEidolonVfsMaterializationReceipt {
  readonly schemaVersion: typeof EIDOLON_VFS_MATERIALIZATION_RECEIPT_SCHEMA;
  readonly status: "rejected";
  readonly receiptId: string;
  readonly planId: string;
  /** Revision that remained admitted after candidate rejection. */
  readonly currentRevision: EidolonVfsRevision | null;
  readonly candidateTreeDigest: EidolonVfsDigest;
  readonly diagnostics: readonly EidolonVfsMaterializationDiagnostic[];
  readonly rejectedAt: string;
}

export type EidolonVfsMaterializationReceipt =
  | AdmittedEidolonVfsMaterializationReceipt
  | RejectedEidolonVfsMaterializationReceipt;

export interface EidolonVfsFileEntry {
  readonly kind: "file";
  readonly logicalPath: string;
  readonly nodeId: string;
  readonly size: number;
  readonly fileType?: "text" | "xnl" | "binary";
  readonly contentDigest?: EidolonVfsDigest;
}

export interface EidolonVfsDirectoryEntry {
  readonly kind: "directory";
  readonly logicalPath: string;
  readonly nodeId: string;
}

export type EidolonVfsEntry = EidolonVfsFileEntry | EidolonVfsDirectoryEntry;

/** A read port is permanently bound to one admitted snapshot. */
export interface EidolonVfsReadPort {
  readonly snapshot: EffectiveEidolonVfsSnapshot;
  stat(logicalPath: string): Promise<EidolonVfsEntry | undefined>;
  readDirectory(logicalPath: string): Promise<readonly EidolonVfsEntry[] | undefined>;
  readBytes(logicalPath: string): Promise<Uint8Array | undefined>;
}

/** Transitional, read-only projection for consumers that still accept ResourceVfs. */
export interface LegacyResourceVfsProjection<TResourceVfs> {
  readonly schemaVersion: typeof LEGACY_RESOURCE_VFS_PROJECTION_SCHEMA;
  readonly snapshotRevision: EidolonVfsRevision;
  readonly treeDigest: EidolonVfsDigest;
  readonly readOnly: true;
  readonly vfs: TResourceVfs;
}
