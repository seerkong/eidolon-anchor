import { describe, expect, it } from "bun:test";

import {
  EFFECTIVE_EIDOLON_VFS_ROOT,
  EFFECTIVE_EIDOLON_VFS_SNAPSHOT_SCHEMA,
  EIDOLON_VFS_MATERIALIZATION_PLAN_SCHEMA,
  EIDOLON_VFS_MATERIALIZATION_RECEIPT_SCHEMA,
  type EffectiveEidolonVfsSnapshot,
  type EidolonVfsMaterializationPlan,
  type EidolonVfsMaterializationReceipt,
  type EidolonVfsReadPort,
} from "@cell/symbiont-contract/resource/EffectiveEidolonVFS";
import { ResourceVFSOps } from "@cell/symbiont-logic/resource/ResourceVFS";
import {
  assertEffectiveEidolonVfsSnapshot,
  assertEidolonVfsMaterializationPlan,
  assertEidolonVfsMaterializationReceipt,
  createLegacyResourceVfsProjection,
} from "@cell/symbiont-logic/resource/EffectiveEidolonVFS";

const digest = (suffix: string): `sha256:${string}` => `sha256:${suffix}`;

describe("Effective Eidolon VFS authority contract", () => {
  it("freezes one storage-neutral snapshot rooted at /.eidolon", () => {
    const snapshot = {
      schemaVersion: EFFECTIVE_EIDOLON_VFS_SNAPSHOT_SCHEMA,
      revision: digest("effective-v1"),
      baseRevision: digest("builtin-v1"),
      rootPath: EFFECTIVE_EIDOLON_VFS_ROOT,
      treeDigest: digest("tree-v1"),
      overlays: [
        {
          id: "home",
          kind: "home",
          order: 0,
          intentRevision: digest("home-v1"),
          intentDigest: digest("home-intent-v1"),
        },
        {
          id: "workspace",
          kind: "workspace",
          order: 1,
          intentRevision: digest("workspace-v1"),
          intentDigest: digest("workspace-intent-v1"),
        },
      ],
      materializationReceiptId: "materialization-1",
      admittedAt: "2026-08-31T00:00:00.000Z",
    } as const satisfies EffectiveEidolonVfsSnapshot;

    expect(snapshot.rootPath).toBe("/.eidolon");
    expect(snapshot.overlays.map((overlay) => overlay.kind)).toEqual(["home", "workspace"]);
  });

  it("separates plan, candidate validation and admitted publication evidence", () => {
    const plan = {
      schemaVersion: EIDOLON_VFS_MATERIALIZATION_PLAN_SCHEMA,
      planId: "plan-1",
      expectedCurrentRevision: digest("effective-v0"),
      baseRevision: digest("builtin-v1"),
      overlays: [],
      candidateTreeDigest: digest("tree-v1"),
      createdAt: "2026-08-31T00:00:00.000Z",
    } as const satisfies EidolonVfsMaterializationPlan;

    const receipt = {
      schemaVersion: EIDOLON_VFS_MATERIALIZATION_RECEIPT_SCHEMA,
      status: "admitted",
      receiptId: "materialization-1",
      planId: plan.planId,
      previousRevision: plan.expectedCurrentRevision,
      publishedRevision: digest("effective-v1"),
      candidateTreeDigest: plan.candidateTreeDigest,
      validation: {
        validatedAt: "2026-08-31T00:00:01.000Z",
        validators: [
          { id: "xnl-vfs", evidenceDigest: digest("xnl-proof") },
          { id: "halfcode-readback", evidenceDigest: digest("halfcode-proof") },
        ],
      },
      publishedAt: "2026-08-31T00:00:02.000Z",
    } as const satisfies EidolonVfsMaterializationReceipt;

    expect(receipt.status).toBe("admitted");
    expect(receipt.validation.validators.map((validator) => validator.id)).toEqual([
      "xnl-vfs",
      "halfcode-readback",
    ]);
  });

  it("binds every read port to one admitted snapshot rather than live overlay roots", async () => {
    const snapshot = {
      schemaVersion: EFFECTIVE_EIDOLON_VFS_SNAPSHOT_SCHEMA,
      revision: digest("effective-v1"),
      baseRevision: digest("builtin-v1"),
      rootPath: EFFECTIVE_EIDOLON_VFS_ROOT,
      treeDigest: digest("tree-v1"),
      overlays: [],
      materializationReceiptId: "materialization-1",
      admittedAt: "2026-08-31T00:00:00.000Z",
    } as const satisfies EffectiveEidolonVfsSnapshot;
    const port: EidolonVfsReadPort = {
      snapshot,
      stat: async (logicalPath) => logicalPath === "/.eidolon/runtime-config.json"
        ? { kind: "file", logicalPath, nodeId: "runtime-config", size: 2 }
        : undefined,
      readDirectory: async () => [],
      readBytes: async () => new TextEncoder().encode("{}"),
    };

    expect(port.snapshot.revision).toBe(digest("effective-v1"));
    expect(await port.stat("/.eidolon/runtime-config.json")).toMatchObject({ nodeId: "runtime-config" });
  });

  it("accepts multiple patches per kind while rejecting duplicate ids or out-of-order kind groups", () => {
    const plan = {
      schemaVersion: EIDOLON_VFS_MATERIALIZATION_PLAN_SCHEMA,
      planId: "plan-invalid-order",
      expectedCurrentRevision: null,
      baseRevision: digest("builtin-v1"),
      overlays: [
        {
          id: "workspace",
          kind: "workspace",
          order: 0,
          intentRevision: digest("workspace-v1"),
          intentDigest: digest("workspace-intent-v1"),
        },
        {
          id: "home",
          kind: "home",
          order: 1,
          intentRevision: digest("home-v1"),
          intentDigest: digest("home-intent-v1"),
        },
      ],
      candidateTreeDigest: digest("tree-v1"),
      createdAt: "2026-08-31T00:00:00.000Z",
    } as const satisfies EidolonVfsMaterializationPlan;

    expect(() => assertEidolonVfsMaterializationPlan(plan)).toThrow("Builtin → home → workspace");
    expect(assertEidolonVfsMaterializationPlan({
      ...plan,
      overlays: [plan.overlays[0], { ...plan.overlays[0], id: "workspace-duplicate", order: 1 }],
    }).overlays).toHaveLength(2);
    expect(() => assertEidolonVfsMaterializationPlan({
      ...plan,
      overlays: [plan.overlays[0], { ...plan.overlays[0], order: 1 }],
    })).toThrow("duplicate overlay id");
  });

  it("rejects receipts that do not close the plan revision fence", () => {
    const plan = {
      schemaVersion: EIDOLON_VFS_MATERIALIZATION_PLAN_SCHEMA,
      planId: "plan-1",
      expectedCurrentRevision: digest("effective-v0"),
      baseRevision: digest("builtin-v1"),
      overlays: [],
      candidateTreeDigest: digest("tree-v1"),
      createdAt: "2026-08-31T00:00:00.000Z",
    } as const satisfies EidolonVfsMaterializationPlan;
    const rejected = {
      schemaVersion: EIDOLON_VFS_MATERIALIZATION_RECEIPT_SCHEMA,
      status: "rejected",
      receiptId: "rejected-1",
      planId: plan.planId,
      currentRevision: digest("unexpected-current"),
      candidateTreeDigest: plan.candidateTreeDigest,
      diagnostics: [{ code: "validation_failed", message: "candidate invalid" }],
      rejectedAt: "2026-08-31T00:00:01.000Z",
    } as const satisfies EidolonVfsMaterializationReceipt;

    expect(() => assertEidolonVfsMaterializationReceipt(plan, rejected)).toThrow("current revision");
    expect(() => assertEidolonVfsMaterializationReceipt(plan, {
      ...rejected,
      currentRevision: plan.expectedCurrentRevision,
      diagnostics: [],
    })).toThrow("at least one diagnostic");
    expect(assertEidolonVfsMaterializationReceipt(plan, {
      ...rejected,
      diagnostics: [{ code: "publish_conflict", message: "lost CAS race" }],
    }).status).toBe("rejected");
  });

  it("rejects an admitted receipt without full candidate validation evidence", () => {
    const plan = {
      schemaVersion: EIDOLON_VFS_MATERIALIZATION_PLAN_SCHEMA,
      planId: "plan-validation",
      expectedCurrentRevision: null,
      baseRevision: digest("builtin-v1"),
      overlays: [],
      candidateTreeDigest: digest("tree-v1"),
      createdAt: "2026-08-31T00:00:00.000Z",
    } as const satisfies EidolonVfsMaterializationPlan;
    const admitted = {
      schemaVersion: EIDOLON_VFS_MATERIALIZATION_RECEIPT_SCHEMA,
      status: "admitted",
      receiptId: "admitted-without-proof",
      planId: plan.planId,
      previousRevision: null,
      publishedRevision: digest("effective-v1"),
      candidateTreeDigest: plan.candidateTreeDigest,
      validation: {
        validatedAt: "2026-08-31T00:00:01.000Z",
        validators: [],
      },
      publishedAt: "2026-08-31T00:00:02.000Z",
    } as const satisfies EidolonVfsMaterializationReceipt;

    expect(() => assertEidolonVfsMaterializationReceipt(plan, admitted)).toThrow("validation evidence");
  });

  it("rejects a snapshot that is not rooted at the canonical Eidolon path", () => {
    const snapshot = {
      schemaVersion: EFFECTIVE_EIDOLON_VFS_SNAPSHOT_SCHEMA,
      revision: digest("effective-v1"),
      baseRevision: digest("builtin-v1"),
      rootPath: "/workspace/.eidolon",
      treeDigest: digest("tree-v1"),
      overlays: [],
      materializationReceiptId: "materialization-1",
      admittedAt: "2026-08-31T00:00:00.000Z",
    } as unknown as EffectiveEidolonVfsSnapshot;

    expect(() => assertEffectiveEidolonVfsSnapshot(snapshot)).toThrow("snapshot root");
  });

  it("marks the legacy text map as a deeply frozen single-revision projection", () => {
    const snapshot = {
      schemaVersion: EFFECTIVE_EIDOLON_VFS_SNAPSHOT_SCHEMA,
      revision: digest("effective-v1"),
      baseRevision: digest("builtin-v1"),
      rootPath: EFFECTIVE_EIDOLON_VFS_ROOT,
      treeDigest: digest("tree-v1"),
      overlays: [],
      materializationReceiptId: "materialization-1",
      admittedAt: "2026-08-31T00:00:00.000Z",
    } as const satisfies EffectiveEidolonVfsSnapshot;
    const projection = createLegacyResourceVfsProjection(
      snapshot,
      ResourceVFSOps.fromDict({ "/.eidolon/runtime-config.json": "{}" }),
    );

    expect(projection.readOnly).toBe(true);
    expect(projection.snapshotRevision).toBe(snapshot.revision);
    expect(projection.treeDigest).toBe(snapshot.treeDigest);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.vfs.files)).toBe(true);
    expect(Object.isFrozen(projection.vfs.files["/.eidolon/runtime-config.json"])).toBe(true);
  });
});
