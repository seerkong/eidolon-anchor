import type { ResourceVfs, ResourceVfsFile } from "@cell/symbiont-contract/resource/ResourceVFS";
import {
  EFFECTIVE_EIDOLON_VFS_ROOT,
  EFFECTIVE_EIDOLON_VFS_SNAPSHOT_SCHEMA,
  EIDOLON_VFS_MATERIALIZATION_PLAN_SCHEMA,
  EIDOLON_VFS_MATERIALIZATION_RECEIPT_SCHEMA,
  LEGACY_RESOURCE_VFS_PROJECTION_SCHEMA,
  type EffectiveEidolonVfsSnapshot,
  type EidolonVfsMaterializationPlan,
  type EidolonVfsMaterializationReceipt,
  type EidolonVfsOverlayDescriptor,
  type LegacyResourceVfsProjection,
} from "@cell/symbiont-contract/resource/EffectiveEidolonVFS";

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid Eidolon VFS authority: ${message}`);
}

function nonEmpty(value: string, field: string): void {
  invariant(value.trim().length > 0, `${field} must be non-empty`);
}

function digest(value: string | null, field: string): void {
  if (value === null) return;
  invariant(value.startsWith("sha256:") && value.length > "sha256:".length, `${field} must be a sha256 digest`);
}

function assertOverlayOrder(overlays: readonly EidolonVfsOverlayDescriptor[]): void {
  const ids = new Set<string>();
  for (const [index, overlay] of overlays.entries()) {
    nonEmpty(overlay.id, `overlays[${index}].id`);
    invariant(!ids.has(overlay.id), `duplicate overlay id '${overlay.id}'`);
    invariant(overlay.order === index, `overlay order must be contiguous from zero`);
    digest(overlay.intentRevision, `overlays[${index}].intentRevision`);
    digest(overlay.intentDigest, `overlays[${index}].intentDigest`);
    ids.add(overlay.id);
  }

  const rank = { home: 0, workspace: 1 } as const;
  for (let index = 1; index < overlays.length; index += 1) {
    invariant(
      rank[overlays[index - 1].kind] <= rank[overlays[index].kind],
      "overlay precedence must follow Builtin → home → workspace",
    );
  }
}

export function assertEffectiveEidolonVfsSnapshot(
  snapshot: EffectiveEidolonVfsSnapshot,
): EffectiveEidolonVfsSnapshot {
  invariant(
    snapshot.schemaVersion === EFFECTIVE_EIDOLON_VFS_SNAPSHOT_SCHEMA,
    `snapshot schema must be '${EFFECTIVE_EIDOLON_VFS_SNAPSHOT_SCHEMA}'`,
  );
  invariant(snapshot.rootPath === EFFECTIVE_EIDOLON_VFS_ROOT, `snapshot root must be '${EFFECTIVE_EIDOLON_VFS_ROOT}'`);
  digest(snapshot.revision, "snapshot.revision");
  digest(snapshot.baseRevision, "snapshot.baseRevision");
  digest(snapshot.treeDigest, "snapshot.treeDigest");
  nonEmpty(snapshot.materializationReceiptId, "snapshot.materializationReceiptId");
  nonEmpty(snapshot.admittedAt, "snapshot.admittedAt");
  assertOverlayOrder(snapshot.overlays);
  return snapshot;
}

export function assertEidolonVfsMaterializationPlan(
  plan: EidolonVfsMaterializationPlan,
): EidolonVfsMaterializationPlan {
  invariant(
    plan.schemaVersion === EIDOLON_VFS_MATERIALIZATION_PLAN_SCHEMA,
    `plan schema must be '${EIDOLON_VFS_MATERIALIZATION_PLAN_SCHEMA}'`,
  );
  nonEmpty(plan.planId, "plan.planId");
  digest(plan.expectedCurrentRevision, "plan.expectedCurrentRevision");
  digest(plan.baseRevision, "plan.baseRevision");
  digest(plan.candidateTreeDigest, "plan.candidateTreeDigest");
  nonEmpty(plan.createdAt, "plan.createdAt");
  assertOverlayOrder(plan.overlays);
  return plan;
}

export function assertEidolonVfsMaterializationReceipt(
  plan: EidolonVfsMaterializationPlan,
  receipt: EidolonVfsMaterializationReceipt,
): EidolonVfsMaterializationReceipt {
  assertEidolonVfsMaterializationPlan(plan);
  invariant(
    receipt.schemaVersion === EIDOLON_VFS_MATERIALIZATION_RECEIPT_SCHEMA,
    `receipt schema must be '${EIDOLON_VFS_MATERIALIZATION_RECEIPT_SCHEMA}'`,
  );
  nonEmpty(receipt.receiptId, "receipt.receiptId");
  invariant(receipt.planId === plan.planId, "receipt plan id does not match materialization plan");
  invariant(
    receipt.candidateTreeDigest === plan.candidateTreeDigest,
    "receipt candidate tree digest does not match materialization plan",
  );

  if (receipt.status === "admitted") {
    invariant(
      receipt.previousRevision === plan.expectedCurrentRevision,
      "admitted receipt previous revision does not close the plan revision fence",
    );
    digest(receipt.publishedRevision, "receipt.publishedRevision");
    invariant(receipt.validation.validators.length > 0, "admitted receipt requires validation evidence");
    for (const [index, validator] of receipt.validation.validators.entries()) {
      nonEmpty(validator.id, `receipt.validation.validators[${index}].id`);
      digest(validator.evidenceDigest, `receipt.validation.validators[${index}].evidenceDigest`);
    }
    nonEmpty(receipt.validation.validatedAt, "receipt.validation.validatedAt");
    nonEmpty(receipt.publishedAt, "receipt.publishedAt");
  } else {
    invariant(receipt.diagnostics.length > 0, "rejected receipt requires at least one diagnostic");
    const publishConflict = receipt.diagnostics.some((diagnostic) => diagnostic.code === "publish_conflict");
    if (!publishConflict) {
      invariant(
        receipt.currentRevision === plan.expectedCurrentRevision,
        "rejected receipt current revision does not preserve the plan revision fence",
      );
    }
    for (const [index, diagnostic] of receipt.diagnostics.entries()) {
      nonEmpty(diagnostic.message, `receipt.diagnostics[${index}].message`);
    }
    nonEmpty(receipt.rejectedAt, "receipt.rejectedAt");
  }
  return receipt;
}

function freezeLegacyFile(file: ResourceVfsFile): ResourceVfsFile {
  return Object.freeze({ ...file });
}

export function createLegacyResourceVfsProjection(
  snapshot: EffectiveEidolonVfsSnapshot,
  vfs: ResourceVfs,
): LegacyResourceVfsProjection<ResourceVfs> {
  assertEffectiveEidolonVfsSnapshot(snapshot);
  const files = Object.freeze(Object.fromEntries(
    Object.entries(vfs.files).map(([path, file]) => [path, freezeLegacyFile(file)]),
  ));
  const frozenVfs = Object.freeze({ files });
  return Object.freeze({
    schemaVersion: LEGACY_RESOURCE_VFS_PROJECTION_SCHEMA,
    snapshotRevision: snapshot.revision,
    treeDigest: snapshot.treeDigest,
    readOnly: true,
    vfs: frozenVfs,
  });
}
